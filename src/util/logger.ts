/**
 * Logging goes to stderr only.
 *
 * This is not cosmetic: with the stdio transport, stdout carries the MCP protocol
 * framed as newline-delimited JSON. A stray console.log on stdout corrupts the stream
 * and the client drops the connection.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

import { redact } from './errors.js';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const tag = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)}`;
  // Every line goes through redaction. Logs are the easiest place for a credential to leak
  // — an error from a dependency may quote the request that carried the session cookie —
  // and the cookie is worth an entire Overleaf account.
  if (extra === undefined) process.stderr.write(`${tag} ${redact(message)}\n`);
  else process.stderr.write(`${tag} ${redact(message)} ${redact(serialize(extra))}\n`);
}

export const log = {
  debug: (message: string, extra?: unknown): void => emit('debug', message, extra),
  info: (message: string, extra?: unknown): void => emit('info', message, extra),
  warn: (message: string, extra?: unknown): void => emit('warn', message, extra),
  error: (message: string, extra?: unknown): void => emit('error', message, extra),
};