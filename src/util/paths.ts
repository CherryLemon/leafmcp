/** Path handling for tool arguments, which are attacker-influenced (the model writes them). */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolError } from './errors.js';

/**
 * Normalize a model-supplied project-relative path.
 *
 * Rejects absolute paths, drive letters, UNC prefixes and any `..` segment. The model is
 * told to use paths like `sections/intro.tex`; anything else is a bug or an injection
 * attempt, and either way must not reach the filesystem.
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

/** Path of `target` relative to `root`, always with forward slashes. */
export function relativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join('/');
}