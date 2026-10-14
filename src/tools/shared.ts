/** Helpers shared by the tool handlers: mirror readiness, save-and-publish, formatting. */

import { z } from 'zod';

import { ToolError } from '../util/errors.js';
import type { ActiveProject } from '../overleaf/registry.js';
import { EDIT_COMMIT_PREFIX } from '../overleaf/workspace.js';
import type { PendingChange, ProjectWorkspace } from '../overleaf/workspace.js';
import type { ToolContext, ToolResult } from './types.js';
import { assertWritable } from './types.js';

/**
 * How a mutating tool declares its project argument.
 *
 * Required in the schema, not merely enforced at runtime, so the model sees the requirement
 * while composing the call rather than after it fails. See `requireProjectArg` for why
 * mutating tools may not fall back to the selected project.
 */
export const requiredProject = z
  .string()
  .min(1)
  .describe('Project id or name. Required for tools that change the project.');

export const optionalProject = z
  .string()
  .optional()
  .describe('Project id or name; defaults to the selected project.');

/** Resolve the target project and guarantee its mirror holds the current Overleaf state. */
export async function readyWorkspace(
  ctx: ToolContext,
  projectRef: string | undefined,
): Promise<{ project: ActiveProject; workspace: ProjectWorkspace }> {
  const project = await ctx.registry.resolve(projectRef);
  const workspace = ctx.workspaces.for(project);
  await ensureReady(ctx, workspace);
  return { project, workspace };
}

/**
 * Bring a workspace to a usable state: created, and populated from Overleaf if it never was.
 *
 * The previous version also re-pulled whenever the file list came back empty, which meant a
 * genuinely empty project — or one whose every file is filtered out — re-downloaded on every
 * single tool call. `pull_project` is the explicit way to ask for a reload.
 */
export async function ensureReady(ctx: ToolContext, workspace: ProjectWorkspace): Promise<void> {
  await workspace.ensure();
  if (await workspace.isInitialized()) return;
  await ctx.session.run((client) => workspace.pull(client));
}

/**
 * Resolve the project for an operation that changes something.
 *
 * Mutating tools never fall back to the deployment-wide "selected project". Several clients
 * share one server, so a `use_project` call from one of them would otherwise silently
 * redirect another's edit into a different paper — the model asking for "the intro" would
 * be told it succeeded while editing a document nobody was looking at.
 *
 * Read tools keep the optional fallback: reading the wrong project is visible in the result,
 * and the cost of a mistake is a wasted call rather than a changed file.
 */
export async function requireProjectArg(
  ctx: ToolContext,
  projectRef: string | undefined,
  operation: string,
): Promise<{ project: ActiveProject; workspace: ProjectWorkspace }> {
  if (!projectRef || projectRef.trim() === '') {
    const active = await ctx.registry.active();
    throw new ToolError(
      `${operation} needs an explicit project argument`,
      active
        ? `Pass project="${active.id}" — the currently selected project is "${active.name}". ` +
          'Tools that change the project never rely on the selected project, because several ' +
          'clients share this server and would otherwise edit each other\'s papers.'
        : 'Call list_projects, then pass the id of the project to change.',
    );
  }
  return readyWorkspace(ctx, projectRef);
}

/**
 * Pull just this file's current content from Overleaf before acting on it.
 *
 * Best-effort by design: when it cannot run (no credentials, new file, network blip) the
 * mirror copy is still used, and the workspace refuses the refresh whenever there are
 * unpublished local edits, so nothing is ever discarded here.
 */
export async function refreshBeforeUse(
  ctx: ToolContext,
  workspace: ProjectWorkspace,
  relPath: string,
): Promise<void> {
  if (!ctx.config.freshReads) return;
  try {
    await ctx.session.run((client) => workspace.refreshFileFromRemote(client, relPath));
  } catch {
    // Never let a freshness check be the reason a read or edit fails.
  }
}

export interface SaveOptions {
  /** Commit message recorded in the mirror's history. */
  message: string;
  /** The tool making the change; recorded in the project journal with an operation id. */
  tool: string;
  /** Files this operation touched. */
  paths: string[];
}

export interface PublishReport {
  /** Text to append to the tool's own message. */
  note: string;
  /** False when something did not reach Overleaf, so the caller can mark the result failed. */
  ok: boolean;
  /** The journal entry for this call, so a caller can report or later undo it. */
  operationId: string;
}

/**
 * Publish the mirror to Overleaf when auto-push is on, and describe what happened.
 *
 * Auto-push is the default because the whole point of the bridge is that the user sees the
 * change in their browser immediately.
 *
 * The returned `ok` flag is what stops a partial failure from being read as success. A
 * warning buried in a successful-looking response is easy for a model to summarise away as
 * "done" — and the user then believes their paper was updated when the upload failed.
 */
export async function publishIfConfigured(
  ctx: ToolContext,
  workspace: ProjectWorkspace,
  options: SaveOptions,
): Promise<PublishReport> {
  const commit = await workspace.commit(`${EDIT_COMMIT_PREFIX} ${options.message}`);

  // Every mutating call is recorded, whether or not it publishes, so it can be referred to
  // afterwards by id instead of by "the third commit back".
  const operation = await workspace.journal.record({
    tool: options.tool,
    commit,
    paths: options.paths,
  });
  const tag = `\n\noperation ${operation.id}`;
  const open = await workspace.journal.getOpen();

  // An open change set suspends publishing. That is the whole point of opening one: the
  // edits land together or not at all, rather than leaving a half-revised paper visible.
  if (open) {
    return {
      note:
        `\n\nStaged in change set ${open.id} ("${open.description}"). Nothing has reached Overleaf yet — ` +
        `call commit_change_set once the whole change is ready, or abandon_change_set to discard it.${tag}`,
      ok: true,
      operationId: operation.id,
    };
  }

  if (!ctx.config.autoPush) {
    return {
      note: `\n\nSaved to the local mirror. Changes are NOT yet on Overleaf — call publish_changes to send them.${tag}`,
      ok: true,
      operationId: operation.id,
    };
  }

  const outcome = await ctx.session.run((client) => workspace.push(client));
  if (outcome.clean) {
    return { note: `\n\nSynced with Overleaf (nothing to send).${tag}`, ok: true, operationId: operation.id };
  }

  const parts: string[] = [];
  const sent = outcome.uploaded.length + outcome.deleted.length;
  if (sent > 0) {
    parts.push(
      `\n\nPublished to Overleaf: ${outcome.uploaded.length} file(s) updated` +
        `${outcome.deleted.length > 0 ? `, ${outcome.deleted.length} deleted` : ''}.`,
    );
  }
  if (outcome.failed.length > 0) {
    parts.push(
      `\n\nNOT PUBLISHED — ${outcome.failed.length} change(s) are still only local:\n` +
        outcome.failed.map((f) => `  - ${f.path}: ${f.reason}`).join('\n') +
        (outcome.deletionsDeferred
          ? '\nDeletions were held back so nothing was removed from Overleaf.'
          : ''),
    );
  }
  return { note: parts.join('') + tag, ok: outcome.failed.length === 0, operationId: operation.id };
}

/**
 * Build the tool's result from its message plus the publish report.
 *
 * Centralised so every mutating tool marks a partial publish as an error rather than leaving
 * it as a sentence inside an otherwise successful response.
 */
export function withPublish(text: string, publish: PublishReport): ToolResult {
  return publish.ok ? { text } : { text, isError: true };
}

export function formatChanges(changes: PendingChange[]): string {
  if (changes.length === 0) return 'No local changes; the mirror matches Overleaf.';
  const label: Record<PendingChange['status'], string> = {
    added: 'new',
    modified: 'modified',
    deleted: 'deleted',
  };
  return changes.map((c) => `  ${label[c.status].padEnd(8)} ${c.path}`).join('\n');
}

export function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export { assertWritable };