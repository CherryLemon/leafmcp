/**
 * Runs a project search in a child process that can be killed.
 *
 * A model-supplied regular expression is untrusted code in the practical sense: catastrophic
 * backtracking is unbounded work on the event loop, and a deadline checked between lines
 * cannot interrupt a match that has already started. `(a|aa)+$` needs ~6 seconds at 36
 * characters and does not finish at 40, so a single line of a `.tex` file is enough to wedge
 * the whole server. Terminating the process is the only reliable way to stop it, and it keeps
 * the failure contained: the search returns "stopped" and everything else keeps serving.
 *
 * The cost is a process spawn per search, which is a few tens of milliseconds against a
 * fifteen-second budget — cheap next to losing the server.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../util/logger.js';
import type { SearchHit, SearchJob } from './search-worker.js';

export interface IsolatedSearchOptions {
  root: string;
  files: string[];
  /** Relative paths to skip — binary files, whose bytes are not worth scanning. */
  skip: string[];
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  maxResults: number;
  lineCap: number;
  timeoutMs: number;
}

export interface IsolatedSearchResult {
  hits: SearchHit[];
  scanned: number;
  timedOut: boolean;
  error?: string;
}

/**
 * Locate the worker in both the built output and the TypeScript sources.
 *
 * `npm run dev` executes `src/` directly, where only the `.ts` file exists and Node needs its
 * type-stripping flag; the published layout has the compiled `.js` beside it. Resolving both
 * keeps the two ways of running the server honest instead of making the search quietly fail
 * outside `dist/`.
 */
function workerCommand(): { file: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, 'search-worker.js');
  if (existsSync(compiled)) return { file: compiled, args: [] };

  const source = join(here, 'search-worker.ts');
  if (existsSync(source)) return { file: source, args: ['--experimental-transform-types'] };

  throw new Error(`search worker not found next to ${here}`);
}

export function searchIsolated(options: IsolatedSearchOptions): Promise<IsolatedSearchResult> {
  const { file, args } = workerCommand();

  const job: Omit<SearchJob, 'skip'> & { skip: string[] } = {
    root: options.root,
    files: options.files,
    pattern: options.pattern,
    isRegex: options.isRegex,
    caseSensitive: options.caseSensitive,
    maxResults: options.maxResults,
    lineCap: options.lineCap,
    skip: options.skip,
  };

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [...args, file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // The child reads project files; it has no need for this process's credentials.
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        NODE_OPTIONS: '',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (result: IsolatedSearchResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`search exceeded ${options.timeoutMs}ms and was terminated (pattern: ${options.pattern.slice(0, 80)})`);
      child.kill('SIGKILL');
      // Give the kill a moment to land, then answer regardless.
      setTimeout(() => finish({ hits: [], scanned: 0, timedOut: true }), 250).unref();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      finish({ hits: [], scanned: 0, timedOut, error: error.message });
    });

    child.on('close', () => {
      if (timedOut) {
        finish({ hits: [], scanned: 0, timedOut: true });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { hits: SearchHit[]; scanned: number };
        finish({ hits: parsed.hits ?? [], scanned: parsed.scanned ?? 0, timedOut: false });
      } catch {
        finish({
          hits: [],
          scanned: 0,
          timedOut: false,
          error: stderr.trim() || 'the search process returned no usable result',
        });
      }
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(job));
  });
}