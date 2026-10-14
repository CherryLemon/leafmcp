/** Tools for finding and selecting the Overleaf project to work on. */

import { z } from 'zod';

import { summarizeLatex, renderSummary } from '../overleaf/latex.js';
import type { ProjectWorkspace } from '../overleaf/workspace.js';
import { formatChanges, formatBytesShort, readyWorkspace } from './shared.js';
import { assertWritable, defineTool } from './types.js';

export const projectTools = [
  defineTool({
    name: 'list_projects',
    title: 'List Overleaf projects',
    description:
      'List every Overleaf project in the account (id, name, last updated). Use this to find the project to work on.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      refresh: z.boolean().optional().describe('Bypass the 60-second cache and refetch.'),
    },
    async run(ctx, args) {
      const projects = await ctx.registry.list(args.refresh ?? false);
      if (projects.length === 0) return 'No projects found in this Overleaf account.';
      const active = await ctx.registry.active();
      const rows = projects
        .filter((p) => !p.trashed)
        .map((p) => {
          const marker = p.id === active?.id ? '*' : ' ';
          const updated = p.lastUpdated ? p.lastUpdated.slice(0, 10) : '?';
          return `${marker} ${p.name}\n    id: ${p.id}   updated: ${updated}`;
        });
      return `${projects.length} project(s), * = currently selected:\n\n${rows.join('\n')}`;
    },
  }),

  defineTool({
    name: 'use_project',
    title: 'Select the working project',
    description:
      'Select which Overleaf project later tool calls operate on. Call this once before editing. Accepts an id or a name.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().describe('Project id, exact name, or a unique part of the name.'),
    },
    async run(ctx, args) {
      // The selected project is deployment-wide state, so a read-only connection must not
      // be able to retarget what a write-capable one will edit next.
      assertWritable(
        ctx,
        'changing the selected project',
        'Read tools still accept a `project` argument, so pass the project id or name directly to read it.',
      );

      const project = await ctx.registry.resolve(args.project);
      await ctx.registry.setActive(project);
      const workspace = ctx.workspaces.for(project);
      await workspace.ensure();
      if (!(await workspace.isInitialized())) {
        const { fileCount } = await ctx.session.run((client) => workspace.pull(client));
        return `Selected "${project.name}" (${project.id}) and downloaded ${fileCount} file(s).\nReady to read and edit.`;
      }
      const files = workspace.listFiles();
      return `Selected "${project.name}" (${project.id}). ${files.length} file(s) available locally.`;
    },
  }),

  defineTool({
    name: 'project_overview',
    title: 'Overview of the current project',
    description:
      'Get the file tree, the LaTeX section structure of the main file, and any unpublished changes. Start here to understand a paper.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      include_files: z.boolean().optional().describe('Include the full file list (default true).'),
    },
    async run(ctx, args) {
      const { project, workspace } = await readyWorkspace(ctx, args.project);

      const files = workspace.listFiles();
      const sections: string[] = [
        `Project: ${project.name}`,
        `id: ${project.id}`,
        `local files: ${files.length}`,
      ];

      const withSizes = await Promise.all(
        files.map(async (path) => {
          const info = await workspace.stat(path);
          return `  ${path}${info ? `  (${formatBytesShort(info.size)})` : ''}`;
        }),
      );
      if (args.include_files !== false) {
        sections.push('', 'Files:', ...(withSizes.length > 0 ? withSizes : ['  (none)']));
      }

      const texFiles = files.filter((f) => /\.(tex|ltx)$/i.test(f));
      const root = await findMainFile(workspace, texFiles);
      if (root) {
        try {
          const summary = summarizeLatex(await workspace.read(root));
          sections.push('', `Main document: ${root}`, '', renderSummary(root, summary));
        } catch {
          sections.push('', `Main document: ${root} (could not be parsed)`);
        }
      }

      const changes = await workspace.changes();
      if (changes.length > 0) {
        sections.push('', 'Unpublished local changes:', formatChanges(changes));
      }
      return sections.join('\n');
    },
  }),
];

/**
 * Guess the root document.
 *
 * Overleaf exposes `rootDoc_id`, but mapping that id to a path needs the full entity tree;
 * the pragmatic heuristic (a readable \documentclass, preferring conventional names) is
 * right far more often than it is wrong, and the model can always read a different file.
 */
async function findMainFile(
  workspace: ProjectWorkspace,
  texFiles: string[],
): Promise<string | undefined> {
  const preferred = ['main.tex', 'paper.tex', 'thesis.tex', 'article.tex', 'manuscript.tex', 'document.tex'];
  for (const name of preferred) {
    const hit = texFiles.find((f) => f.toLowerCase().endsWith(name));
    if (hit) return hit;
  }
  for (const file of texFiles) {
    if (/\//.test(file)) continue;
    try {
      if (/\\documentclass/.test(await workspace.read(file))) return file;
    } catch {
      // unreadable file, keep looking
    }
  }
  for (const file of texFiles) {
    try {
      if (/\\documentclass/.test(await workspace.read(file))) return file;
    } catch {
      // ignore
    }
  }
  return texFiles[0];
}