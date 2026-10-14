/**
 * The tool catalogue, and the one place that binds it to the MCP SDK.
 *
 * `SERVER_INSTRUCTIONS` is not decoration: clients surface it to the model before any tool
 * call, and at least one reads only its first few hundred characters. So the opening
 * sentences have to stand alone as operating instructions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ReadOnlyError, type AnyToolSpec, type ToolContext, type ToolReturn } from './types.js';
import { ToolError, errorMessage, redact } from '../util/errors.js';
import { commentTools } from './comments.js';
import { buildTools } from './build.js';
import { fileTools } from './files.js';
import { projectTools } from './projects.js';
import { log } from '../util/logger.js';

export const ALL_TOOLS: AnyToolSpec[] = [
  ...projectTools,
  ...fileTools,
  ...buildTools,
  ...commentTools,
];

export const SERVER_INSTRUCTIONS = [
  'This server reads and edits the user\'s Overleaf LaTeX projects.',
  'Start with list_projects, then use_project to choose one; project_overview then shows the',
  'file tree and the LaTeX section structure. Read before you write: read_file or',
  'file_outline first, then edit_file with an exact old_text copied from what you read.',
  'Edits are published to Overleaf immediately by default, so the user sees them in their',
  'browser within seconds, and every edit is versioned — undo_last_edit reverses recent',
  'changes and republishes. After substantive edits, call compile and fix reported errors.',
  'Never claim a change was made unless the tool result confirms it.',
].join(' ');

function formatToolError(error: unknown): string {
  if (error instanceof ToolError) return error.toModelMessage();
  if (error instanceof ReadOnlyError) return error.toModelMessage();
  return `Unexpected error: ${errorMessage(error)}`;
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  for (const spec of ALL_TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: spec.annotations,
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        try {
          const text = await runWithProjectLock(ctx, spec, args);
          log.debug(`tool ${spec.name} ok in ${Date.now() - started}ms`);
          // Tool output is model-visible, so it is scrubbed on the way out too: a file could
          // in principle contain a credential, and anything the model sees leaves this host.
          return typeof text === 'string'
            ? { content: [{ type: 'text' as const, text: redact(text) }] }
            : {
                content: [{ type: 'text' as const, text: redact(text.text) }],
                ...(text.isError ? { isError: true } : {}),
              };
        } catch (error) {
          // Tool failures are normal control flow for a model (wrong path, ambiguous edit),
          // so they are reported as an error *result* it can act on, not as a transport fault.
          log.warn(`tool ${spec.name} failed: ${errorMessage(error)}`);
          return {
            content: [{ type: 'text' as const, text: redact(formatToolError(error)) }],
            isError: true,
          };
        }
      },
    );
  }
}

/**
 * Run mutating tools under their project's write lock.
 *
 * The lock is taken here rather than inside each handler so it cannot be forgotten, and so it
 * covers the whole operation — refresh from Overleaf, read, decide, write, commit, publish.
 * Locking individual steps would still let two edits interleave between their read and their
 * write, which is exactly the overwrite this exists to prevent.
 *
 * "Mutating" is read off the annotations the tools already declare for their clients:
 * anything that is not advertised as read-only changes something.
 */
export async function runWithProjectLock(
  ctx: ToolContext,
  spec: AnyToolSpec,
  args: Record<string, unknown>,
): Promise<ToolReturn> {
  if (spec.annotations.readOnlyHint === true) {
    return spec.run(ctx, args as never);
  }
  const projectRef = typeof args.project === 'string' ? args.project : undefined;
  const project = await ctx.registry.resolve(projectRef);
  return ctx.locks.run(project.id, () => spec.run(ctx, args as never));
}

export type { ToolContext, ToolSpec } from './types.js';