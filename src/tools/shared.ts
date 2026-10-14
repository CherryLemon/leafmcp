/** Helpers shared by the tool handlers: mirror readiness, save-and-publish, formatting. */

import type { ActiveProject } from '../overleaf/registry.js';
import { EDIT_COMMIT_PREFIX } from '../overleaf/workspace.js';
import type { PendingChange, ProjectWorkspace } from '../overleaf/workspace.js';
import type { ToolContext } from './types.js';
import { assertWritable } from './types.js';

/** Resolve the target project and guarantee its mirror holds the current Overleaf state. */
export async function readyWorkspace(
  ctx: ToolContext,
  projectRef: string | undefined,
): Promise<{ project: ActiveProject; workspace: ProjectWorkspace }> {
  const project = await ctx.registry.resolve(projectRef);
  const workspace = ctx.workspaces.for(project);
  await workspace.ensure();

  if (!(await workspace.isInitialized())) {
    const { fileCount } = await ctx.session.run((client) => workspace.pull(client));
    return { project, workspace };
  }

  // A project named in the call but never opened should still work without a manual pull.
  if ((await workspace.listFiles()).length === 0) {
    await ctx.session.run((client) => workspace.pull(client));
  }
  return { project, workspace };
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
}

/**
 * Publish the mirror to Overleaf when auto-push is on, and describe what happened.
 *
 * Auto-push is the default because the whole point of the bridge is that the user sees the
 * change in their browser immediately. When it is off (or the push fails) the text says so
 * explicitly, so the model never reports success it did not achieve.
 */
export async function publishIfConfigured(
  ctx: ToolContext,
  workspace: ProjectWorkspace,
  options: SaveOptions,
): Promise<string> {
  await workspace.commit(`${EDIT_COMMIT_PREFIX} ${options.message}`);

  if (!ctx.config.autoPush) {
    return `\n\nSaved to the local mirror. Changes are NOT yet on Overleaf — call publish_changes to send them.`;
  }

  const outcome = await ctx.session.run((client) => workspace.push(client));
  if (outcome.clean) return '\n\nSynced with Overleaf (nothing to send).';

  const parts: string[] = [];
  const sent = outcome.uploaded.length + outcome.deleted.length;
  if (sent > 0) {
    parts.push(`\n\nPublished to Overleaf: ${outcome.uploaded.length} file(s) updated${outcome.deleted.length > 0 ? `, ${outcome.deleted.length} deleted` : ''}.`);
  }
  if (outcome.failed.length > 0) {
    parts.push(
      `\n\nWARNING — ${outcome.failed.length} change(s) could not be published and are still pending locally:\n` +
        outcome.failed.map((f) => `  - ${f.path}: ${f.reason}`).join('\n'),
    );
  }
  return parts.join('');
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