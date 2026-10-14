/**
 * Tools for Overleaf's review comments.
 *
 * These exist because the most useful thing an assistant can do with a supervisor's
 * comments is read them and act on them — so the comment list is the input, and the edit
 * tools are the output.
 */

import { z } from 'zod';

import { ToolError } from '../util/errors.js';
import {
  readyWorkspace,
  requireProjectArg,
  requiredProject,
} from './shared.js';
import { assertWritable, defineTool } from './types.js';

const STATUS = z.enum(['all', 'open', 'resolved']).optional().describe('Filter by thread status. Default open.');

export const commentTools = [
  defineTool({
    name: 'list_comments',
    title: 'List review comments',
    description: 'List review comments on the project, with the file and line each one refers to.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      project: z.string().optional().describe('Project id or name; defaults to the selected project.'),
      status: STATUS,
    },
    async run(ctx, args) {
      const { project } = await readyWorkspace(ctx, args.project);
      const comments = await ctx.session.run((client) =>
        client.listComments(project.id, { status: args.status ?? 'open' }),
      );
      if (comments.length === 0) {
        return `No ${args.status ?? 'open'} comments in "${project.name}".`;
      }
      const blocks = comments.map((comment) => {
        const head = `[${comment.threadId.slice(0, 8)}] ${comment.path}:${comment.line ?? '?'} ${
          comment.resolved ? '(resolved)' : '(open)'
        }`;
        const quote = comment.selectedText
          ? `\n    quoted: "${comment.selectedText.replace(/\s+/g, ' ').slice(0, 160)}"`
          : '';
        const messages = comment.messages
          .map((m) => `    - ${m.user?.name ?? m.user?.email ?? 'someone'}: ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`)
          .join('\n');
        return `${head}${quote}\n${messages}`;
      });
      return `${comments.length} comment thread(s) in "${project.name}":\n\n${blocks.join('\n\n')}`;
    },
  }),

  defineTool({
    name: 'add_comment',
    title: 'Add a review comment',
    description:
      'Add a comment anchored to a file, optionally to a specific line. Use to flag something for the ' +
      'user instead of silently changing it.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      path: z.string().describe('Project-relative file the comment belongs to.'),
      content: z.string().min(1).describe('Comment text.'),
      line: z.number().int().positive().optional().describe('1-based line to anchor the comment to.'),
      selected_text: z.string().optional().describe('Exact text being commented on.'),
      project: requiredProject,
    },
    async run(ctx, args) {
      assertWritable(ctx, 'adding a comment');
      const { project } = await requireProjectArg(ctx, args.project, 'add_comment');
      const comment = await ctx.session.run((client) =>
        client.addComment(project.id, {
          filePath: args.path,
          content: args.content,
          selectedText: args.selected_text,
          line: args.line,
        }),
      );
      return `Added comment ${comment.threadId.slice(0, 8)} on ${comment.path}:${comment.line ?? '?'}.`;
    },
  }),

  defineTool({
    name: 'reply_to_comment',
    title: 'Reply to a comment thread',
    description: 'Post a reply into an existing comment thread.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      thread_id: z.string().describe('Thread id from list_comments (short prefix is accepted).'),
      content: z.string().min(1).describe('Reply text.'),
      project: requiredProject,
    },
    async run(ctx, args) {
      assertWritable(ctx, 'replying to a comment');
      const { project } = await requireProjectArg(ctx, args.project, 'reply_to_comment');
      const threadId = await resolveThreadId(ctx, project.id, args.thread_id);
      const message = await ctx.session.run((client) =>
        client.postCommentMessage(project.id, threadId, args.content),
      );
      if (!message) throw new ToolError('Overleaf accepted the reply but returned no message');
      return `Replied in thread ${threadId.slice(0, 8)}.`;
    },
  }),

  defineTool({
    name: 'resolve_comment',
    title: 'Resolve a comment thread',
    description: 'Mark a comment thread as resolved once its request has been addressed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      thread_id: z.string().describe('Thread id from list_comments (short prefix is accepted).'),
      project: requiredProject,
    },
    async run(ctx, args) {
      assertWritable(ctx, 'resolving a comment');
      const { project } = await requireProjectArg(ctx, args.project, 'resolve_comment');
      const threadId = await resolveThreadId(ctx, project.id, args.thread_id);
      await ctx.session.run((client) => client.resolveComment(project.id, threadId));
      return `Resolved thread ${threadId.slice(0, 8)}.`;
    },
  }),
];

/**
 * Accept the short thread ids that `list_comments` prints.
 *
 * The model sees eight-character prefixes, so it will naturally pass those back; requiring
 * the full id would produce avoidable "not found" failures.
 */
async function resolveThreadId(
  ctx: { session: import('../overleaf/session.js').OverleafSession },
  projectId: string,
  reference: string,
): Promise<string> {
  const wanted = reference.trim();
  const comments = await ctx.session.run((client) => client.listComments(projectId, { status: 'all' }));
  const exact = comments.find((c) => c.threadId === wanted);
  if (exact) return exact.threadId;
  const matches = comments.filter((c) => c.threadId.startsWith(wanted));
  if (matches.length === 1 && matches[0]) return matches[0].threadId;
  if (matches.length > 1) {
    throw new ToolError(
      `"${wanted}" matches ${matches.length} comment threads`,
      'Pass more characters of the thread id.',
    );
  }
  throw new ToolError(
    `no comment thread matches "${wanted}"`,
    'Call list_comments to see the available thread ids.',
  );
}