/** Path handling for tool arguments, which are attacker-influenced (the model writes them). */

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ToolError } from './errors.js';

/**
 * Names the model may never read or write, anywhere in the tree.
 *
 * `.git` is the important one. Git configuration is executable — `core.fsmonitor`,
 * `core.hooksPath` and `filter.*.clean` all run programs as a side effect of ordinary
 * commands — so a writable `.git/config` inside a repository we then run git in is a command
 * execution primitive, not merely a corrupt repository. The git directory is also kept
 * outside the work tree (see `util/git.ts`); this rule is the second layer, so that a future
 * refactor cannot quietly reintroduce the reachable path.
 *
 * The other `.git*` names are blocked with it because they shape git's behaviour
 * (`.gitattributes` can attach a filter, `.gitmodules` can pull in another repository) and
 * an assistant editing a paper has no reason to touch any of them.
 */
function isReservedSegment(segment: string): boolean {
  return segment.toLowerCase().startsWith('.git');
}

/**
 * Normalize a model-supplied project-relative path.
 *
 * Rejects absolute paths, drive letters, UNC prefixes, any `..` segment, and the reserved
 * git names above. The model is told to use paths like `sections/intro.tex`; anything else
 * is a bug or an injection attempt, and either way must not reach the filesystem.
 */
export function normalizeRelPath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ToolError('path must be a non-empty string');
  }
  const raw = input.trim().replace(/\\/g, '/');
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) {
    throw new ToolError(
      `path must be relative to the project root, got "${input}"`,
      'Use a path such as "main.tex" or "sections/intro.tex".',
    );
  }
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new ToolError(`path must not contain "..", got "${input}"`);
  }
  if (segments.some(isReservedSegment)) {
    throw new ToolError(
      `"${input}" is not a project file: git metadata is not accessible through these tools`,
      'Only files that belong to the LaTeX project can be read or written.',
    );
  }
  if (segments.length === 0) {
    throw new ToolError(`path "${input}" does not name a file`);
  }
  return segments.join('/');
}

/** Join a project-relative path onto a root directory, refusing to escape it (zip-slip guard). */
export function safeJoin(root: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, normalized);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new ToolError(`path "${relPath}" escapes the project directory`);
  }
  return target;
}

/**
 * Like `safeJoin`, but for archive entries: returns null instead of throwing.
 *
 * Extraction must skip a bad entry and carry on rather than abort the whole import, and it
 * needs the same two guarantees — no escape, and no git metadata — because an archive is
 * attacker-controlled input too.
 */
export function safeArchiveEntry(root: string, entryName: string): string | null {
  try {
    return safeJoin(root, entryName);
  } catch {
    return null;
  }
}

/**
 * Refuse to operate on a path that is a symbolic link.
 *
 * We never create symlinks, so one appearing in the mirror means it was placed there by
 * something else, and following it would let a write land outside the project.
 */
export async function assertNotSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new ToolError(
        `refusing to write through the symbolic link "${path}"`,
        'Remove the link and use a regular project file instead.',
      );
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    // ENOENT is the normal case: the file does not exist yet.
  }
}

/**
 * Verify that a target's parent directory really sits inside the root.
 *
 * `safeJoin` reasons about the string, which cannot see a symbolic link: if any ancestor of
 * the target is a link pointing elsewhere, the path text still looks contained while the
 * write lands outside. Resolving the parent covers the whole chain at once.
 *
 * This cannot eliminate the window between the check and the write — only opening with
 * `O_NOFOLLOW` on every component would — but it closes the case where a link was placed in
 * the tree and simply left there.
 */
export async function assertInsideRealRoot(root: string, target: string): Promise<void> {
  const resolvedRoot = await realpath(root).catch(() => resolve(root));
  const parent = dirname(target);

  // A missing parent is normal: it is about to be created, and inside the root by then.
  const resolvedParent = await realpath(parent).catch(() => null);
  if (resolvedParent === null) return;

  if (resolvedParent !== resolvedRoot && !resolvedParent.startsWith(resolvedRoot + sep)) {
    throw new ToolError(
      `refusing to write to "${target}": its directory resolves outside the project`,
      'Something in the project directory is a symbolic link pointing elsewhere.',
    );
  }
}

/** Path of `target` relative to `root`, always with forward slashes. */
export function relativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}