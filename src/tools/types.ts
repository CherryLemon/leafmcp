/**
 * Shared types for the tool layer.
 *
 * Handlers are written as plain `(ctx, args) => Promise<string>` functions in a descriptor
 * table, and only bound to the MCP SDK in `register.ts`. That separation means the whole
 * tool surface can be exercised without speaking JSON-RPC, which is what makes the local
 * smoke test possible.
 */

import type { z } from 'zod';

import type { AppConfig } from '../config.js';
import type { ProjectRegistry, WorkspaceManager } from '../overleaf/registry.js';
import type { OverleafSession } from '../overleaf/session.js';

export interface ToolContext {
  config: AppConfig;
  session: OverleafSession;
  registry: ProjectRegistry;
  workspaces: WorkspaceManager;
  /** True when this particular request may not mutate anything. */
  readOnly: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Shown to the model. Kept short and imperative; this is a prompt, not documentation. */
  description: string;
  annotations: ToolAnnotations;
  inputSchema: S;
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<string>;
}

/** Identity helper that preserves the schema type through the descriptor table. */
export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

/**
 * A tool descriptor with its argument type erased.
 *
 * `ToolSpec<SpecificShape>` is not assignable to `ToolSpec<ZodRawShape>` — `run` takes the
 * parsed arguments as a parameter, so the types are contravariant and a heterogeneous
 * catalogue cannot be typed by the generic directly. Erasing to `any` here (and nowhere
 * else) is what lets the tools array hold every tool while each definition stays fully typed.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyToolSpec = ToolSpec<any>;

export class ReadOnlyError extends Error {
  readonly hint?: string;

  constructor(what: string, hint?: string) {
    super(`this connection is read-only, so ${what} was not applied`);
    this.name = 'ReadOnlyError';
    this.hint = hint;
  }

  toModelMessage(): string {
    return this.hint ? `${this.message}\nHint: ${this.hint}` : this.message;
  }
}

export function assertWritable(ctx: ToolContext, what: string, hint?: string): void {
  if (ctx.readOnly || ctx.config.readOnly) throw new ReadOnlyError(what, hint);
}