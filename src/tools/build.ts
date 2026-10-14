/** Tools for compiling, publishing to Overleaf, and undoing edits. */

import { z } from 'zod';

import { ToolError } from '../util/errors.js';
import { parseLatexLog, renderLogSummary } from '../overleaf/latexlog.js';
import { formatChanges, readyWorkspace } from './shared.js';
import { assertWritable, defineTool } from './types.js';
import type { ToolContext } from './types.js';
import type { ProjectWorkspace } from '../overleaf/workspace.js';

/**
 * Make sure Overleaf holds the local edits before an operation that runs on their servers.
 *
 * Compilation happens remotely, so without this a "does it still compile?" check would
 * answer a question about the *old* file — the most misleading possible result.
 *
 * Publishing is a write, so this is also a mutating path and has to respect read-only
 * connections. Without that check, `compile` would be a way to edit and delete files from
 * a connection that was explicitly granted no write access.
 */
async function ensurePublished(ctx: ToolContext, workspace: ProjectWorkspace): Promise<string> {
  const pending = await workspace.changes();
  if (pending.length === 0) return '';

  assertWritable(ctx, 'publishing pending changes before compiling');

  const outcome = await ctx.session.run((client) => workspace.push(client));
  if (outcome.failed.length > 0) {
    throw new ToolError(
      `could not publish ${outcome.failed.length} pending change(s) before compiling`,
      outcome.failed.map((f) => `${f.path}: ${f.reason}`).join('; '),
    );
  }
  return `(published ${outcome.uploaded.length + outcome.deleted.length} pending change(s) first) `;
}

export const buildTools = [
  defineTool({
    name: 'compile',
    title: 'Compile the LaTeX project',
    description:
      'Compile the project on Overleaf and return errors, warnings and the PDF link. ' +
      'Use after editing to check the document still builds.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      resource_path: z.string().optional().describe('Main .tex path for multi-document projects.'),
    },
    async run(ctx, args) {
      const { project, workspace } = await readyWorkspace(ctx, args.project);
      const note = await ensurePublished(ctx, workspace);

      const result = await ctx.session.run((client) =>
        client.compileProject(project.id, args.resource_path),
      );
      const summary = parseLatexLog((result.logs ?? []).join('\n'));
      return (
        `${note}Compile result for "${project.name}":\n\n${renderLogSummary(summary)}` +
        (result.pdfUrl ? `\n\nPDF: ${result.pdfUrl}` : '')
      );
    },
  }),

  defineTool({
    name: 'publish_changes',
    title: 'Send local changes to Overleaf',
    description:
      'Push every pending local edit to Overleaf so the user sees it in their browser. ' +
      'Only needed when auto-publish is disabled or a previous publish failed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, 'publishing changes');
      const { project, workspace } = await readyWorkspace(ctx, args.project);
      const outcome = await ctx.session.run((client) => workspace.push(client));

      if (outcome.clean) return `Nothing to publish — "${project.name}" already matches Overleaf.`;
      const lines = [
        `Published to "${project.name}": ${outcome.uploaded.length} file(s) uploaded, ${outcome.deleted.length} deleted.`,
      ];
      if (outcome.uploaded.length > 0) lines.push('', 'Uploaded:', ...outcome.uploaded.map((p) => `  ${p}`));
      if (outcome.deleted.length > 0) lines.push('', 'Deleted:', ...outcome.deleted.map((p) => `  ${p}`));
      if (outcome.failed.length > 0) {
        lines.push(
          '',
          `FAILED (still pending locally):`,
          ...outcome.failed.map((f) => `  ${f.path}: ${f.reason}`),
        );
      }
      return lines.join('\n');
    },
  }),

  defineTool({
    name: 'pull_project',
    title: 'Reload the project from Overleaf',
    description:
      'Re-download the project from Overleaf, replacing the local mirror. Use when someone else ' +
      'edited the project, or to discard local changes.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      force: z.boolean().optional().describe('Discard unpushed local edits. Default false.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, 'reloading the project');
      const { project, workspace } = await readyWorkspace(ctx, args.project);
      const { fileCount } = await ctx.session.run((client) =>
        workspace.pull(client, { force: args.force ?? false }),
      );
      return `Reloaded "${project.name}" from Overleaf: ${fileCount} file(s).`;
    },
  }),

  defineTool({
    name: 'edit_history',
    title: 'Show recent edits',
    description: 'List recent changes made through this server, newest first. Useful before undoing.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      limit: z.number().int().positive().max(50).optional().describe('How many entries. Default 15.'),
    },
    async run(ctx, args) {
      const { project, workspace } = await readyWorkspace(ctx, args.project);
      const history = await workspace.history(args.limit ?? 15);
      if (history.length === 0) return `No recorded edits for "${project.name}" yet.`;
      const changes = await workspace.changes();
      const rows = history.map(
        (entry) => `${entry.sha.slice(0, 8)}  ${entry.date.slice(0, 19).replace('T', ' ')}  ${entry.message}`,
      );
      const pending =
        changes.length > 0 ? `\n\nUnpublished right now:\n${formatChanges(changes)}` : '';
      return `Recent edits to "${project.name}" (newest first):\n${rows.join('\n')}${pending}`;
    },
  }),

  defineTool({
    name: 'undo_last_edit',
    title: 'Undo recent edits and republish',
    description:
      'Reverse the last N edits made through this server and publish the reversal to Overleaf.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      steps: z.number().int().positive().max(20).optional().describe('How many edits to reverse. Default 1.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, 'undoing edits');
      const { project, workspace } = await readyWorkspace(ctx, args.project);
      const { reverted } = await workspace.undo(args.steps ?? 1);
      const outcome = await ctx.session.run((client) => workspace.push(client));
      const detail =
        outcome.failed.length > 0
          ? `\nBut ${outcome.failed.length} file(s) could not be pushed: ${outcome.failed.map((f) => f.path).join(', ')}`
          : '';
      return `Undid ${args.steps ?? 1} edit(s) in "${project.name}" and republished (${outcome.uploaded.length} file(s) updated)${detail}.\nReverted commits: ${reverted.join(', ')}`;
    },
  }),
];