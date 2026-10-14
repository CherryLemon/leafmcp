/**
 * Thin promise wrapper around the git CLI.
 *
 * The mirror is versioned with real git rather than a bespoke snapshot format so that every
 * AI edit is auditable and reversible with standard tooling, and so "what differs from
 * Overleaf" is answered by git itself instead of by bookkeeping we could get wrong.
 *
 * Three properties here are security-relevant rather than stylistic:
 *
 *  1. **The git directory lives outside the work tree.** Nothing an assistant can reach
 *     through the file tools is git metadata, so a model — or a prompt injection that
 *     reaches one — cannot write `.git/config`.
 *  2. **That matters because git configuration can execute commands.** `core.fsmonitor`,
 *     `core.hooksPath` and `filter.*.clean` all run programs as a side effect of ordinary
 *     commands like `git add` and `git commit`. This was verified against git 2.47: writing
 *     those keys and then running `git add -A` executes the configured program. So the
 *     isolation above is the primary control and the hardening below is the second layer.
 *  3. **The child gets a minimal environment.** Git does not need the Overleaf session
 *     cookie, and anything that can make git run a program would otherwise inherit it.
 */

import { spawn } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A work tree plus the git directory that tracks it, which are deliberately not co-located. */
export interface GitRepo {
  gitDir: string;
  workDir: string;
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

/** Environment values git genuinely needs, and nothing else. */
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Windows needs these to start a process at all.
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

export function gitEnv(repo: GitRepo): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_DIR = repo.gitDir;
  env.GIT_WORK_TREE = repo.workDir;
  env.GIT_TERMINAL_PROMPT = '0';
  // Ignore the machine's system and user git configuration entirely: a stray global
  // `core.fsmonitor` or `core.hooksPath` must not be able to influence these repositories.
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_PAGER = 'cat';
  env.GIT_EDITOR = 'true';
  env.GIT_ATTR_NOSYSTEM = '1';
  return env;
}

/** Upper bounds so a wedged git cannot grow a buffer until the process dies. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export function git(repo: GitRepo, args: string[], allowFailure = false): Promise<GitResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd: repo.workDir,
      env: gitEnv(repo),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let overflowed = false;

    const finish = (result: GitResult, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else if (result.code !== 0 && !allowFailure) {
        rejectPromise(
          new GitError(
            `git ${args.join(' ')} failed (exit ${result.code}): ${stderr.trim() || stdout.trim()}`,
            result,
          ),
        );
      } else resolvePromise(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        { code: -1, stdout, stderr: `${stderr}\ngit timed out after ${GIT_TIMEOUT_MS}ms` },
        new GitError(`git ${args.join(' ')} timed out after ${GIT_TIMEOUT_MS}ms`, {
          code: -1,
          stdout,
          stderr,
        }),
      );
    }, GIT_TIMEOUT_MS);
    timer.unref();

    const collect = (chunk: Buffer, into: 'stdout' | 'stderr'): void => {
      if (overflowed) return;
      const text = chunk.toString('utf8');
      if (into === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        child.kill('SIGKILL');
        finish(
          { code: -1, stdout, stderr },
          new GitError(`git ${args.join(' ')} produced more than ${MAX_OUTPUT_BYTES} bytes of output`, {
            code: -1,
            stdout,
            stderr,
          }),
        );
      }
    };

    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));

    child.on('error', (error) => {
      finish({ code: -1, stdout, stderr }, new GitError(`failed to run git: ${error.message}`, {
        code: -1,
        stdout,
        stderr,
      }));
    });

    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Create a repository whose git directory sits outside its work tree.
 *
 * `git init --bare` is used deliberately: initialising inside the work tree would drop a
 * `.git` directory there, which is exactly what we are trying to avoid.
 */
export async function createRepo(gitDir: string, workDir: string): Promise<GitRepo> {
  const repo: GitRepo = { gitDir, workDir };

  // `git init` must run without GIT_DIR/GIT_WORK_TREE in the environment: with them set, git
// treats the target as an existing repository and refuses. They are deleted rather than
// blanked — an empty string still counts as "set" and fails the same way.
  const initEnv = gitEnv({ gitDir, workDir });
  delete initEnv.GIT_DIR;
  delete initEnv.GIT_WORK_TREE;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['init', '-q', '--bare', '-b', 'main', gitDir], {
      env: initEnv,
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(new Error(`git init failed (exit ${code}): ${stderr.trim() || 'no output'}`)),
    );
  });

  // A bare repository has no work tree; these settings are what make it usable as one.
  await git(repo, ['config', 'core.bare', 'false'], true);
  await git(repo, ['config', 'core.worktree', workDir], true);
  await git(repo, ['config', 'user.name', 'leafmcp'], true);
  await git(repo, ['config', 'user.email', 'leafmcp@localhost'], true);
  await git(repo, ['config', 'commit.gpgsign', 'false'], true);
  await git(repo, ['config', 'core.autocrlf', 'false'], true);
  // Second layer: even inside our own git directory, refuse to run hooks or a filesystem
  // monitor. Point hooks at an empty directory rather than disabling them by name, so a
  // hook cannot be reintroduced by creating a file somewhere we forgot about.
  await git(repo, ['config', 'core.hooksPath', join(gitDir, 'no-hooks')], true);
  await git(repo, ['config', 'core.fsmonitor', 'false'], true);
  await git(repo, ['config', 'core.pager', 'cat'], true);
  await git(repo, ['config', 'core.editor', 'true'], true);
  await git(repo, ['config', 'core.sshCommand', 'false'], true);
  await git(repo, ['config', 'protocol.file.allow', 'never'], true);
  await git(repo, ['config', 'protocol.ext.allow', 'never'], true);

  return repo;
}

export async function gitOk(repo: GitRepo, args: string[]): Promise<boolean> {
  const result = await git(repo, args, true);
  return result.code === 0;
}

/** Commit everything currently in the working tree, if anything changed. */
export async function commitAll(repo: GitRepo, message: string): Promise<string | null> {
  await git(repo, ['add', '-A']);
  const staged = await git(repo, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) return null;
  await git(repo, ['commit', '-q', '-m', message]);
  const rev = await git(repo, ['rev-parse', 'HEAD']);
  return rev.stdout.trim();
}

export async function headSha(repo: GitRepo): Promise<string | null> {
  const result = await git(repo, ['rev-parse', 'HEAD'], true);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Point the `refs/overleaf/pushed` ref at a commit.
 *
 * That ref is the watermark of "what Overleaf already has". Everything after it is a
 * pending local change, which makes push a pure `git diff pushed..HEAD`.
 */
export async function markPushed(repo: GitRepo, sha: string): Promise<void> {
  await git(repo, ['update-ref', 'refs/overleaf/pushed', sha]);
}

export async function pushedSha(repo: GitRepo): Promise<string | null> {
  const result = await git(repo, ['rev-parse', '--verify', '--quiet', 'refs/overleaf/pushed'], true);
  return result.code === 0 ? result.stdout.trim() : null;
}