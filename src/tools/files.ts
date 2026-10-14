/** Tools that read and modify the files of the selected Overleaf project. */

import { z } from 'zod';

import { ToolError } from '../util/errors.js';
import { normalizeRelPath } from '../util/paths.js';
import { summarizeLatex, renderSummary } from '../overleaf/latex.js';
import { looksBinary } from '../overleaf/workspace.js';
import { formatBytesShort, formatChanges, publishIfConfigured, readyWorkspace, refreshBeforeUse } from './shared.js';
import { assertWritable, defineTool } from './types.js';

/** Read a slice of a file's lines, 1-based and inclusive, clamped to the file. */
export function sliceLines(
  content: string,
  startLine?: number,
  endLine?: number,
): { text: string; firstLine: number; totalLines: number; truncated: boolean } {
  const lines = content.split('\n');
  const total = lines.length;
  const first = Math.max(1, Math.floor(startLine ?? 1));
  const last = Math.min(total, Math.floor(endLine ?? total));
  if (first > total) {
    return { text: '', firstLine: first, totalLines: total, truncated: false };
  }
  const slice = lines.slice(first - 1, Math.max(first - 1, last));
  return {
    text: slice.join('\n'),
    firstLine: first,
    totalLines: total,
    truncated: last < total,
  };
}

function withLineNumbers(text: string, firstLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${String(firstLine + i).padStart(5)}│ ${line}`)
    .join('\n');
}

/** Build a compact description of where a replacement landed, for the model to verify. */
function describeEdit(before: string, after: string, occurrences: number): string {
  const delta = after.split('\n').length - before.split('\n').length;
  const deltaText = delta === 0 ? 'line count unchanged' : `net ${delta > 0 ? '+' : ''}${delta} line(s)`;
  return `${occurrences} replacement(s), ${deltaText}`;
}

export const fileTools = [
  defineTool({
    name: 'list_files',
    title: 'List project files',
    description: 'List files in the current project with sizes. Optionally filter by substring.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      filter: z.string().optional().describe('Only show paths containing this substring.'),
    },
    async run(ctx, args) {
      const { workspace } = await readyWorkspace(ctx, args.project);
      let files = workspace.listFiles();
      if (args.filter) {
        const needle = args.filter.toLowerCase();
        files = files.filter((f) => f.toLowerCase().includes(needle));
      }
      if (files.length === 0) return 'No matching files.';
      const rows = await Promise.all(
        files.map(async (path) => {
          const info = await workspace.stat(path);
          return `${path}  (${info ? formatBytesShort(info.size) : '?'})`;
        }),
      );
      return `${files.length} file(s):\n${rows.join('\n')}`;
    },
  }),

  defineTool({
    name: 'read_file',
    title: 'Read a file',
    description:
      'Read a text file from the project, returned with line numbers. Use start_line/end_line for long files.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Project-relative path, e.g. "main.tex" or "sections/intro.tex".'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      start_line: z.number().int().positive().optional().describe('First line to return (1-based).'),
      end_line: z.number().int().positive().optional().describe('Last line to return (inclusive).'),
    },
    async run(ctx, args) {
      const { workspace } = await readyWorkspace(ctx, args.project);
      await refreshBeforeUse(ctx, workspace, args.path);
      const content = await workspace.read(args.path);
      const slice = sliceLines(content, args.start_line, args.end_line);
      const header =
        `# ${normalizeRelPath(args.path)} — ${slice.totalLines} lines` +
        (slice.truncated ? ` (showing ${slice.firstLine}–${slice.firstLine + slice.text.split('\n').length - 1})` : '');
      return `${header}\n\n${withLineNumbers(slice.text, slice.firstLine)}`;
    },
  }),

  defineTool({
    name: 'read_files',
    title: 'Read several files',
    description: 'Read multiple files in one call. More efficient than repeated read_file calls.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      paths: z.array(z.string()).min(1).max(20).describe('Project-relative paths to read.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      const { workspace } = await readyWorkspace(ctx, args.project);
      // Bounded so a wide batch read does not turn into a burst of requests.
      if (args.paths.length <= 8) {
        for (const path of args.paths) await refreshBeforeUse(ctx, workspace, path);
      }
      const blocks: string[] = [];
      for (const path of args.paths) {
        try {
          const content = await workspace.read(path);
          const lines = content.split('\n').length;
          blocks.push(`─── ${normalizeRelPath(path)} (${lines} lines) ───\n${withLineNumbers(content, 1)}`);
        } catch (error) {
          blocks.push(`─── ${path} ───\n(could not read: ${error instanceof Error ? error.message : String(error)})`);
        }
      }
      return blocks.join('\n\n');
    },
  }),

  defineTool({
    name: 'search_project',
    title: 'Search the project',
    description:
      'Search all project text files for a string or regular expression. Returns matching lines with file and line numbers.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      query: z.string().describe('Text to find, or a regular expression when regex is true.'),
      regex: z.boolean().optional().describe('Treat query as a JavaScript regular expression.'),
      case_sensitive: z.boolean().optional().describe('Default false.'),
      glob: z.string().optional().describe('Only search paths containing this substring, e.g. ".tex" or "sections/".'),
      max_results: z.number().int().positive().max(300).optional().describe('Default 60.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      const { workspace } = await readyWorkspace(ctx, args.project);
      const limit = args.max_results ?? 60;
      const flags = args.case_sensitive ? '' : 'i';

      // A model-supplied regex runs on the one event loop this server has, so a pattern
      // that backtracks catastrophically would hang every client, not just this call.
      if (args.regex && looksCatastrophic(args.query)) {
        throw new ToolError(
          `the pattern ${JSON.stringify(args.query)} nests one repetition inside another, which can hang the server`,
          'Rephrase it without a quantified group inside another quantifier, or search for a literal string instead.',
        );
      }

      let matcher: RegExp;
      try {
        matcher = new RegExp(args.regex ? args.query : escapeRegExp(args.query), flags);
      } catch (error) {
        throw new ToolError(
          `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let files = workspace.listFiles();
      if (args.glob) files = files.filter((f) => f.includes(args.glob as string));

      const hits: string[] = [];
      let scanned = 0;
      let timedOut = false;
      const deadline = Date.now() + SEARCH_BUDGET_MS;

      for (const file of files) {
        if (hits.length >= limit) break;
        if (Date.now() > deadline) {
          timedOut = true;
          break;
        }
        if (looksBinary(file)) continue;
        let content: string;
        try {
          content = await workspace.read(file);
        } catch {
          continue;
        }
        scanned += 1;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const raw = lines[i] ?? '';
          // Only part of a very long line is ever matched, which bounds the work a single
          // pattern can do against it.
          if (matcher.test(raw.slice(0, MAX_LINE_SCAN))) {
            hits.push(`${file}:${i + 1}: ${raw.trim().slice(0, 300)}`);
            if (hits.length >= limit) break;
          }
        }
      }

      const note = timedOut
        ? `\n\n(stopped after ${SEARCH_BUDGET_MS / 1000}s to keep the server responsive; narrow the search with glob or max_results)`
        : '';
      if (hits.length === 0) {
        return `No matches for ${JSON.stringify(args.query)} in ${files.length} file(s).${note}`;
      }
      return `${hits.length} match(es) in ${scanned} file(s) scanned:\n${hits.join('\n')}${note}`;
    },
  }),

  defineTool({
    name: 'edit_file',
    title: 'Replace text in a file',
    description:
      'Replace an exact piece of text in a file. Preferred over write_file: it changes only what you specify. ' +
      'old_text must match the file exactly, including whitespace, and must be unique unless replace_all is true.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Project-relative path of the file to change.'),
      old_text: z.string().min(1).describe('Exact existing text to replace, copied from read_file output.'),
      new_text: z.string().describe('Replacement text. Use "" to delete the matched text.'),
      replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, `editing ${args.path}`);
      const { workspace } = await readyWorkspace(ctx, args.project);
      // Refresh before matching: if the user changed this text in the browser since the
      // model last read it, old_text stops matching and the edit fails loudly, instead of
      // silently overwriting their change.
      await refreshBeforeUse(ctx, workspace, args.path);
      const before = await workspace.read(args.path);

      const occurrences = countOccurrences(before, args.old_text);
      if (occurrences === 0) {
        throw new ToolError(
          `old_text was not found in ${args.path}`,
          'Read the file again and copy the exact text, including indentation. Note the line-number ' +
            'prefix in read_file output is not part of the file.',
        );
      }
      if (occurrences > 1 && !args.replace_all) {
        throw new ToolError(
          `old_text appears ${occurrences} times in ${args.path}, so the edit is ambiguous`,
          'Include more surrounding context to make it unique, or pass replace_all=true.',
        );
      }

      const after = args.replace_all
        ? before.split(args.old_text).join(args.new_text)
        : before.replace(args.old_text, args.new_text);

      await workspace.write(args.path, after);
      const summary = describeEdit(before, after, args.replace_all ? occurrences : 1);
      const publish = await publishIfConfigured(ctx, workspace, {
        message: `edit ${normalizeRelPath(args.path)}`,
      });
      return `Edited ${normalizeRelPath(args.path)}: ${summary}.${publish}`;
    },
  }),

  defineTool({
    name: 'write_file',
    title: 'Create or overwrite a file',
    description:
      'Write the full contents of a file, creating it if needed. Overwrites everything already in the file — ' +
      'prefer edit_file for changes to existing files.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Project-relative path, e.g. "sections/methods.tex".'),
      content: z.string().describe('Full new contents of the file.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, `writing ${args.path}`);
      const { workspace } = await readyWorkspace(ctx, args.project);
      const existed = (await workspace.stat(args.path)) !== null;

      await workspace.write(args.path, args.content);
      const lines = args.content.split('\n').length;
      const publish = await publishIfConfigured(ctx, workspace, {
        message: `${existed ? 'overwrite' : 'create'} ${normalizeRelPath(args.path)}`,
      });
      return `${existed ? 'Overwrote' : 'Created'} ${normalizeRelPath(args.path)} (${lines} lines, ${formatBytesShort(Buffer.byteLength(args.content, 'utf8'))}).${publish}`;
    },
  }),

  defineTool({
    name: 'delete_file',
    title: 'Delete a file',
    description: 'Delete a file from the project. Requires confirm=true because it removes content from Overleaf.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Project-relative path of the file to delete.'),
      confirm: z.boolean().describe('Must be true. Confirms you intend to delete this file.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, `deleting ${args.path}`);
      if (args.confirm !== true) {
        throw new ToolError('delete_file requires confirm=true', 'Ask the user before deleting files.');
      }
      const { workspace } = await readyWorkspace(ctx, args.project);
      await workspace.remove(args.path);
      const publish = await publishIfConfigured(ctx, workspace, {
        message: `delete ${normalizeRelPath(args.path)}`,
      });
      return `Deleted ${normalizeRelPath(args.path)}.${publish}`;
    },
  }),

  defineTool({
    name: 'rename_file',
    title: 'Rename or move a file',
    description: 'Move a file to a new path within the project, creating folders as needed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      from: z.string().describe('Current project-relative path.'),
      to: z.string().describe('New project-relative path.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      assertWritable(ctx, `renaming ${args.from}`);
      const { workspace } = await readyWorkspace(ctx, args.project);
      const content = await workspace.read(args.from);
      await workspace.write(args.to, content);
      await workspace.remove(args.from);
      const publish = await publishIfConfigured(ctx, workspace, {
        message: `rename ${normalizeRelPath(args.from)} -> ${normalizeRelPath(args.to)}`,
      });
      return `Moved ${normalizeRelPath(args.from)} to ${normalizeRelPath(args.to)}.${publish}`;
    },
  }),

  defineTool({
    name: 'file_outline',
    title: 'Show a LaTeX file structure',
    description:
      'Show the section headings, labels, included files and environments of one LaTeX file, with line numbers. ' +
      'Cheaper than reading the whole file when you only need to locate something.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Project-relative path of a .tex file.'),
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      const { workspace } = await readyWorkspace(ctx, args.project);
      await refreshBeforeUse(ctx, workspace, args.path);
      const content = await workspace.read(args.path);
      return renderSummary(normalizeRelPath(args.path), summarizeLatex(content));
    },
  }),

  defineTool({
    name: 'pending_changes',
    title: 'Show unpublished changes',
    description: 'List local edits that have not been sent to Overleaf yet.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
    },
    async run(ctx, args) {
      const { workspace } = await readyWorkspace(ctx, args.project);
      return formatChanges(await workspace.changes());
    },
  }),
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Upper bound on how long a single search may occupy the event loop. */
const SEARCH_BUDGET_MS = 5_000;

/** Only this much of a line is ever handed to a model-supplied pattern. */
const MAX_LINE_SCAN = 4_000;

/**
 * Detect the classic catastrophic-backtracking shape: a group that itself contains a
 * repetition, wrapped in another repetition — `(a+)+`, `(\d+)*`, `([a-z]+\.)+`.
 *
 * This is a heuristic, not a proof, which is why the search also carries a deadline and a
 * per-line cap. It is deliberately narrow so ordinary patterns are not rejected: groups
 * containing alternation without an inner quantifier, which are the more ambiguous case,
 * are allowed through and bounded by the deadline instead.
 */
function looksCatastrophic(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*]/.test(pattern);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
    if (count > 10_000) break;
  }
  return count;
}