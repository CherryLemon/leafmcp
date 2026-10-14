/**
 * Thin promise wrapper around the git CLI.
 *
 * The mirror is versioned with real git rather than a bespoke snapshot format so that
 * every AI edit is auditable and reversible with standard tooling, and so "what differs
 * from Overleaf" is answered by git itself instead of by bookkeeping we could get wrong.
 */

import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export function git(cwd: string, args: string[], allowFailure = false): Promise<GitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Never let an interactive prompt hang a tool call.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'true',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      rejectPromise(
        new GitError(`failed to run git: ${error.message}`, { code: -1, stdout, stderr }),
      );
    });

    child.on('close', (code) => {
      const result: GitResult = { code: code ?? -1, stdout, stderr };
      if (result.code !== 0 && !allowFailure) {
        rejectPromise(
          new GitError(
            `git ${args.join(' ')} failed (exit ${result.code}): ${stderr.trim() || stdout.trim()}`,
            result,
          ),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const result = await git(cwd, args, true);
  return result.code === 0;
}

/** Commit everything currently in the working tree, if anything changed. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ['add', '-A']);
  const staged = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) return null;
  await git(cwd, ['commit', '-q', '-m', message]);
  const rev = await git(cwd, ['rev-parse', 'HEAD']);
  return rev.stdout.trim();
}

export async function headSha(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', 'HEAD'], true);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Point the `refs/overleaf/pushed` ref at a commit.
 *
 * That ref is the watermark of "what Overleaf already has". Everything after it is a
 * pending local change, which makes push a pure `git diff pushed..HEAD`.
 */
export async function markPushed(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['update-ref', 'refs/overleaf/pushed', sha]);
}

export async function pushedSha(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'refs/overleaf/pushed'], true);
  return result.code === 0 ? result.stdout.trim() : null;
}