/**
 * A local, git-versioned mirror of one Overleaf project.
 *
 * The mirror is the unit of work for every read and write tool. That choice buys three
 * things that matter a lot once a model is editing a paper unsupervised:
 *
 *   - "What would a push change?" is answered by git (`refs/overleaf/pushed..worktree`),
 *     not by bookkeeping we could get wrong.
 *   - Every accepted edit is a commit, so `undo` is real rather than best-effort.
 *   - Overleaf's own file-type semantics (docs vs. binary files, nested folders) are
 *     handled once, at pull time, by the zip round trip.
 */

// First import, deliberately — see the note in session.ts.
import '../bootstrap.js';

import AdmZip from 'adm-zip';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildTexSiblingSet,
  loadIgnore,
  shouldIgnore,
  type OverleafClient,
} from '@aloth/olcli';

import { ToolError, errorMessage } from '../util/errors.js';
import {
  commitAll,
  git,
  headSha,
  markPushed,
  pushedSha,
} from '../util/git.js';
import { log } from '../util/logger.js';
import { normalizeRelPath, safeJoin } from '../util/paths.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

/**
 * Commit subject prefix marking a change made through a tool.
 *
 * `undo` reverses only these, which is what stops it from also reversing a reload from
 * Overleaf — see `undo()`.
 */
export const EDIT_COMMIT_PREFIX = 'edit:';

export interface PendingChange {
  path: string;
  status: ChangeStatus;
}

export interface PushOutcome {
  uploaded: string[];
  deleted: string[];
  failed: Array<{ path: string; reason: string }>;
  /** True when nothing was pending. */
  clean: boolean;
}

/** Text-ish extensions we are willing to hand to the model directly. */
const TEXT_EXTENSIONS = new Set([
  'tex', 'ltx', 'bib', 'cls', 'sty', 'bst', 'txt', 'md', 'markdown', 'csv', 'tsv',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'def', 'tikz', 'pgf', 'py', 'sh',
  'r', 'jl', 'm', 'lua', 'gitignore', 'olignore', 'svg', 'html', 'xml',
]);

export function looksBinary(relPath: string): boolean {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (!ext || ext === relPath.toLowerCase()) return false;
  return !TEXT_EXTENSIONS.has(ext);
}

export class ProjectWorkspace {
  readonly dir: string;

  constructor(
    private readonly root: string,
    readonly projectId: string,
    readonly projectName: string,
    private readonly limits: { maxFileBytes: number },
  ) {
    this.dir = join(root, sanitizeSegment(projectId));
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, '.git'))) {
      await git(this.dir, ['init', '-q', '-b', 'main'], true);
      // The container may have no global git identity; scope one to this repo only.
      await git(this.dir, ['config', 'user.name', 'overleaf-mcp'], true);
      await git(this.dir, ['config', 'user.email', 'overleaf-mcp@localhost'], true);
      await git(this.dir, ['config', 'commit.gpgsign', 'false'], true);
      await git(this.dir, ['config', 'core.autocrlf', 'false'], true);
    }
  }

  /**
   * Replace the mirror contents with a fresh copy of the project from Overleaf.
   * Refuses to discard unpushed edits unless `force` is set — those edits are the
   * only copy of the model's work until a push succeeds.
   */
  async pull(client: OverleafClient, options: { force?: boolean } = {}): Promise<{ fileCount: number }> {
    await this.ensure();

    const pending = await this.changes();
    if (pending.length > 0 && !options.force) {
      throw new ToolError(
        `refusing to re-pull: ${pending.length} unpushed local change(s) would be lost`,
        'Call publish_changes first to send them to Overleaf, or pass force=true to discard them.',
      );
    }

    const zipBuffer = await client.downloadProject(this.projectId);
    const zip = new AdmZip(zipBuffer);

    // Extract into a sibling directory and only touch the mirror once every write has
    // succeeded. Wiping first would mean a failure part-way through (a truncated download,
    // a full disk) leaves a partial tree, and the next push would read every missing file
    // as a deletion and remove it from Overleaf.
    const incoming = `${this.dir}.incoming`;
    const backup = `${this.dir}.old`;
    await rm(incoming, { recursive: true, force: true });
    await mkdir(incoming, { recursive: true });

    let fileCount = 0;
    const unsafe: string[] = [];
    try {
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        let target: string;
        try {
          target = safeJoin(incoming, entry.entryName);
        } catch {
          unsafe.push(entry.entryName);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.getData());
        fileCount += 1;
      }
      if (unsafe.length > 0) {
        log.warn(`skipped ${unsafe.length} zip entr(ies) that escaped the project root`, unsafe.slice(0, 5));
      }
      await swapIn(this.dir, incoming, backup);
    } finally {
      await rm(incoming, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
    }

    const sha = await commitAll(this.dir, `pull ${this.projectName} (${fileCount} files)`);
    let head = sha ?? (await headSha(this.dir));
    if (!head) {
      // An empty project still needs a baseline commit, otherwise "has this mirror been
      // populated?" is unanswerable and every tool call would re-download the project.
      await git(this.dir, ['commit', '-q', '--allow-empty', '-m', `pull ${this.projectName} (empty project)`]);
      head = await headSha(this.dir);
    }
    if (head) await markPushed(this.dir, head);
    return { fileCount };
  }

  /** True once the mirror reflects a real Overleaf state (i.e. a pull has completed). */
  async isInitialized(): Promise<boolean> {
    if (!existsSync(join(this.dir, '.git'))) return false;
    return (await headSha(this.dir)) !== null;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /**
   * Refresh a single file from Overleaf before it is read or edited.
   *
   * The mirror is only a cache: nothing stops the user (or a collaborator) editing the same
   * file in the browser between tool calls. Without this, a read would report text that no
   * longer exists and a subsequent edit would silently overwrite whatever replaced it.
   *
   * Two guards make it safe rather than merely fresh:
   *   - It does nothing while there are unpublished local edits, since those exist only in
   *     the mirror and would be destroyed.
   *   - Failure is not fatal. A file the model just created is not on Overleaf yet, so a
   *     failed fetch means "keep the local copy", not "the file is gone".
   *
   * Returns true only when the mirror actually changed.
   */
  async refreshFileFromRemote(client: OverleafClient, relPath: string): Promise<boolean> {
    const pending = await this.changes();
    if (pending.length > 0) return false;

    const path = safeJoin(this.dir, relPath);
    let remote: Buffer;
    try {
      remote = await client.downloadByPath(this.projectId, normalizeRelPath(relPath));
    } catch (error) {
      log.debug(`could not refresh ${relPath} from Overleaf (keeping the local copy): ${errorMessage(error)}`);
      return false;
    }

    const local = await readFile(path).catch(() => null);
    if (local && local.equals(remote)) return false;

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, remote);

    // The refreshed content *is* what Overleaf holds, so the baseline moves with it.
    // Without this the file would look like an unpublished local change and the next push
    // would upload identical bytes back — harmless, but it would make `pending_changes`
    // and `edit_history` lie about what actually happened.
    await this.commit(`refresh ${normalizeRelPath(relPath)} from Overleaf`);
    const head = await headSha(this.dir);
    if (head) await markPushed(this.dir, head);

    log.debug(`refreshed ${relPath} from Overleaf (${remote.length} bytes)`);
    return true;
  }

  /** Every project file that survives Overleaf's own ignore semantics, sorted. */
  listFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    const ctx = loadIgnore(this.dir);
    const out: string[] = [];
    const walk = (dir: string, base: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const texSiblings = buildTexSiblingSet(
        entries.filter((e) => !e.isDirectory()).map((e) => e.name),
      );
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (shouldIgnore(`${rel}/`, ctx)) continue;
          walk(join(dir, entry.name), rel);
        } else {
          if (shouldIgnore(rel, ctx, texSiblings)) continue;
          out.push(rel);
        }
      }
    };
    walk(this.dir, '');
    return out.sort();
  }

  async stat(relPath: string): Promise<{ size: number; mtime: Date } | null> {
    try {
      const info = await stat(safeJoin(this.dir, relPath));
      return { size: info.size, mtime: info.mtime };
    } catch {
      return null;
    }
  }

  async read(relPath: string): Promise<string> {
    const path = safeJoin(this.dir, relPath);
    if (!existsSync(path)) {
      throw new ToolError(
        `file not found in the project: ${relPath}`,
        'Call list_files to see the exact paths.',
      );
    }
    const info = await stat(path);
    if (info.size > this.limits.maxFileBytes) {
      throw new ToolError(
        `file is too large to read (${formatBytes(info.size)}, limit ${formatBytes(this.limits.maxFileBytes)})`,
      );
    }
    if (looksBinary(relPath)) {
      throw new ToolError(
        `${relPath} looks like a binary file, which cannot be read as text`,
        'Only text sources (tex, bib, cls, sty, …) can be read.',
      );
    }
    return readFile(path, 'utf8');
  }

  // ── writing ──────────────────────────────────────────────────────────────

  async write(relPath: string, content: string): Promise<void> {
    const normalized = normalizeRelPath(relPath);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.limits.maxFileBytes) {
      throw new ToolError(
        `refusing to write ${formatBytes(bytes)} (limit ${formatBytes(this.limits.maxFileBytes)})`,
      );
    }
    const path = safeJoin(this.dir, normalized);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }

  async remove(relPath: string): Promise<void> {
    const path = safeJoin(this.dir, relPath);
    if (!existsSync(path)) {
      throw new ToolError(`cannot delete ${relPath}: no such file`);
    }
    await rm(path, { recursive: true, force: true });
  }

  async commit(message: string): Promise<string | null> {
    return commitAll(this.dir, message);
  }

  // ── diffing against Overleaf ─────────────────────────────────────────────

  /**
   * Changes between the last successful push and the working tree.
   *
   * Two subtleties, both load-bearing:
   *
   *  - `git add -A` runs first. Plain `git diff <commit>` compares against the *working
   *    tree*, which by definition cannot see untracked files — so a file the model just
   *    created would silently never be pushed. Staging first and comparing the index
   *    makes new files show up as `A`.
   *  - The watermark commit is the comparison base, so edits that are committed-but-not-
   *    yet-pushed and edits that are not committed at all both appear in one list.
   *
   * Staging is a side effect, but a harmless one: it never discards content, and every
   * push path commits what it staged.
   */
  async changes(): Promise<PendingChange[]> {
    if (!existsSync(join(this.dir, '.git'))) return [];
    await git(this.dir, ['add', '-A'], true);

    const watermark = await pushedSha(this.dir);
    const args = ['diff', '--cached', '--name-status', '-z', '--no-renames'];
    if (watermark) args.push(watermark);

    const result = await git(this.dir, args, true);
    if (result.code !== 0) {
      // Failing open here would be dangerous rather than merely untidy: an empty change list
      // reads as "the mirror matches Overleaf", so a broken watermark would make push() a
      // silent no-op and would disable pull()'s guard against discarding unpublished edits.
      throw new ToolError(
        `could not determine which files differ from Overleaf: ${result.stderr.trim() || 'git diff failed'}`,
        'The local mirror repository looks damaged. Remove that project directory under the ' +
          'data directory and run pull_project to rebuild it from Overleaf.',
      );
    }

    const tokens = result.stdout.split('\0').filter((t) => t !== '');
    const changes: PendingChange[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const code = tokens[i]?.[0];
      const path = tokens[i + 1];
      if (!code || !path) continue;
      const status: ChangeStatus = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      changes.push({ path, status });
    }
    return changes;
  }

  // ── pushing ──────────────────────────────────────────────────────────────

  /**
   * Send every pending change to Overleaf.
   *
   * Uploads happen before deletes so a rename never leaves the project without the
   * file at all, and the watermark only advances if every operation succeeded — a
   * partial push stays pending and can simply be retried.
   */
  async push(client: OverleafClient): Promise<PushOutcome> {
    await this.ensure();
    const changes = await this.changes();
    if (changes.length === 0) {
      return { uploaded: [], deleted: [], failed: [], clean: true };
    }

    // Safety valve. Emptying a project is essentially never what anyone intended, and it is
    // the signature of a mirror that came back wrong (a failed download, a corrupted repo).
    // Refusing here turns a catastrophic, hard-to-notice outcome into a visible error.
    const removals = changes.filter((change) => change.status === 'deleted');
    const remaining = this.listFiles().length;
    if (removals.length > 0 && remaining === 0) {
      throw new ToolError(
        `refusing to publish: it would delete all ${removals.length} file(s) in the project, leaving it empty`,
        'If that is genuinely what you want, delete the files one at a time. Otherwise run ' +
          'pull_project to rebuild the local copy from Overleaf first.',
      );
    }

    const uploaded: string[] = [];
    const deleted: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];

    for (const change of changes) {
      if (change.status === 'deleted') continue;
      try {
        const content = await readFile(safeJoin(this.dir, change.path));
        await client.uploadFile(this.projectId, null, change.path, content);
        uploaded.push(change.path);
      } catch (error) {
        failed.push({ path: change.path, reason: errorMessage(error) });
      }
    }

    for (const change of changes) {
      if (change.status !== 'deleted') continue;
      try {
        await client.deleteByPath(this.projectId, change.path);
        deleted.push(change.path);
      } catch (error) {
        failed.push({ path: change.path, reason: errorMessage(error) });
      }
    }

    // Folder ids are cached per project; creating a new folder mid-push invalidates it.
    client.invalidateFolderTree(this.projectId);

    if (failed.length === 0) {
      const sha = await commitAll(this.dir, `push to Overleaf (${uploaded.length} up, ${deleted.length} down)`);
      const head = sha ?? (await headSha(this.dir));
      if (head) await markPushed(this.dir, head);
    }

    return { uploaded, deleted, failed, clean: false };
  }

  // ── history & undo ───────────────────────────────────────────────────────

  async history(limit: number): Promise<Array<{ sha: string; date: string; message: string }>> {
    if (!existsSync(join(this.dir, '.git'))) return [];
    const result = await git(
      this.dir,
      ['log', `-n${Math.max(1, Math.min(limit, 200))}`, '--pretty=format:%H%x09%aI%x09%s'],
      true,
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', date = '', message = ''] = line.split('\t');
        return { sha, date, message };
      });
  }

  /**
   * Undo the last `steps` accepted edits by reverting them into a new commit.
   *
   * Only the *contiguous run of edit commits at HEAD* is eligible, and that restriction is
   * the whole point: reloading from Overleaf (`pull`) and refreshing a single file also
   * create commits, and reversing one of those would push a stale copy back over whatever
   * the user has since changed in their browser — silently, and reported as success.
   * Refusing is the honest outcome.
   *
   * Revert (rather than reset) keeps the original edits in history, so an undo that
   * turns out to be wrong is itself undoable.
   */
  async undo(steps: number): Promise<{ reverted: string[] }> {
    const count = Math.max(1, steps);
    const log = await git(this.dir, ['log', '-n200', '--pretty=format:%H%x09%s'], true);
    if (log.code !== 0) {
      throw new ToolError('could not read the edit history from the local mirror');
    }

    const commits = log.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('\t');
        return separator === -1
          ? { sha: line, subject: '' }
          : { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
      });

    const targets: string[] = [];
    for (const commit of commits) {
      if (!isUndoable(commit.subject)) break;
      targets.push(commit.sha);
      if (targets.length >= count) break;
    }

    if (targets.length === 0) {
      throw new ToolError(
        commits.length === 0
          ? 'there is nothing to undo yet'
          : 'the most recent change was not an edit, so there is nothing safe to undo',
        'Reloading the project from Overleaf and refreshing a file are deliberately excluded: ' +
          'reversing one would overwrite content that may have been edited in the browser.',
      );
    }

    const revert = await git(this.dir, ['revert', '--no-commit', ...targets], true);
    if (revert.code !== 0) {
      await git(this.dir, ['revert', '--abort'], true);
      throw new ToolError(
        `could not undo automatically: ${revert.stderr.trim() || 'the edits conflict'}`,
        'Read the affected files and adjust them directly instead.',
      );
    }
    const sha = await commitAll(this.dir, `undo ${targets.length} edit(s)`);
    return { reverted: targets.map((s) => s.slice(0, 8)).concat(sha ? [sha.slice(0, 8)] : []) };
  }
}

function isUndoable(subject: string): boolean {
  return subject.startsWith(EDIT_COMMIT_PREFIX) || subject.startsWith('undo ');
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'project' : cleaned;
}

/**
 * Replace the mirror's tracked content with a freshly extracted tree.
 *
 * Existing entries are moved aside with renames (cheap, and reversible) before the new ones
 * are moved in, and everything is put back if any step fails. The alternative — deleting
 * the old tree first — creates a window where the mirror is incomplete, and an incomplete
 * mirror is indistinguishable from "the user deleted these files", which is exactly what
 * the next push would then do to their project.
 */
async function swapIn(dir: string, incoming: string, backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true });
  await mkdir(backup, { recursive: true });

  const movedAside: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git') continue;
      await moveEntry(join(dir, entry), join(backup, entry));
      movedAside.push(entry);
    }
    for (const entry of readdirSync(incoming)) {
      await moveEntry(join(incoming, entry), join(dir, entry));
    }
  } catch (error) {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git') continue;
      await rm(join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    for (const entry of movedAside) {
      await moveEntry(join(backup, entry), join(dir, entry)).catch(() => undefined);
    }
    throw new ToolError(
      `could not replace the local mirror: ${errorMessage(error)}`,
      'The previous mirror contents were restored, so nothing was lost.',
    );
  }
}

/**
 * Move a file or directory, falling back to copy-and-delete.
 *
 * `rename` is atomic and instant, but it only works within one filesystem — and it is not
 * universally supported between directories either, which some container and network
 * filesystems do not implement. The data directory is exactly the kind of path that ends up
 * on a mounted volume, so the fallback is not hypothetical.
 */
async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}