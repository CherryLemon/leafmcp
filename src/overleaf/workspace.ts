/**
 * A local, git-versioned mirror of one Overleaf project.
 *
 * The mirror is the unit of work for every read and write tool. That choice buys three
 * things that matter a lot once a model is editing a paper unsupervised:
 *
 *   - "What would a push change?" is answered by git (`refs/overleaf/pushed..index`),
 *     not by bookkeeping we could get wrong.
 *   - Every accepted edit is a commit, so `undo` is real rather than best-effort.
 *   - Overleaf's own file-type semantics (docs vs. binary files, nested folders) are
 *     handled once, at pull time, by the zip round trip.
 *
 * The work tree holds project files and nothing else. Git's own directory lives beside it,
 * never inside it, so the file tools an assistant drives cannot reach git metadata — see
 * `util/git.ts` for why that matters.
 */

// First import, deliberately: it redirects the Overleaf client's config directory, and ESM
// evaluates imports in declaration order — so this has run by the time the import below is
// evaluated. See bootstrap.ts for the failure this prevents.
import '../bootstrap.js';

import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
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
  createRepo,
  git,
  headSha,
  markPushed,
  pushedSha,
  type GitRepo,
} from '../util/git.js';
import { log } from '../util/logger.js';
import { assertNotSymlink, normalizeRelPath, safeArchiveEntry, safeJoin } from '../util/paths.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

/**
 * A short, stable fingerprint of a file's contents.
 *
 * Returned by `read_file` and accepted by `edit_file`, so an edit can state which version of
 * the text it was written against. Overleaf offers no atomic conditional write, so this cannot
 * close the race between the final check and the upload — but it does turn the common case,
 * "the user changed this file after the model read it", from a silent overwrite into a
 * conflict the model has to look at.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

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
  /** True when deletions were held back because an upload failed. */
  deletionsDeferred: boolean;
}

/**
 * Bounds on what an imported archive may contain.
 *
 * The archive comes from Overleaf, but Overleaf's contents are collaborator-controlled, and
 * `pull` holds the whole thing in memory before extracting. Without limits a project with a
 * hundred thousand tiny files, or one enormous entry, is enough to exhaust the process. These
 * are deliberately constants rather than settings: no legitimate LaTeX project comes close,
 * and a knob here would only invite someone to raise it.
 */
const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_DEPTH = 20;

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
  /** The work tree: project files only, exactly what the model may touch. */
  readonly dir: string;
  /** Git metadata, deliberately a sibling rather than a child of the work tree. */
  readonly gitDir: string;

  constructor(
    private readonly root: string,
    readonly projectId: string,
    readonly projectName: string,
    private readonly limits: { maxFileBytes: number },
  ) {
    const segment = sanitizeSegment(projectId);
    this.dir = join(root, 'projects', segment);
    this.gitDir = join(root, 'meta', `${segment}.git`);
  }

  private get repo(): GitRepo {
    return { gitDir: this.gitDir, workDir: this.dir };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async ensure(): Promise<void> {
    // 0700: these directories hold someone's unpublished papers.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.gitDir), { recursive: true, mode: 0o700 });
    if (!existsSync(this.gitDir)) {
      await createRepo(this.gitDir, this.dir);
    }
  }

  /** True once the mirror reflects a real Overleaf state (i.e. a pull has completed). */
  async isInitialized(): Promise<boolean> {
    if (!existsSync(this.gitDir)) return false;
    return (await headSha(this.repo)) !== null;
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
    await mkdir(incoming, { recursive: true, mode: 0o700 });

    const entries = zip.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new ToolError(
        `refusing to import: the project archive has ${entries.length} entries (limit ${MAX_ARCHIVE_ENTRIES})`,
        'This usually means the archive is not a normal Overleaf export.',
      );
    }

    let fileCount = 0;
    let extractedBytes = 0;
    const skipped: string[] = [];
    try {
      for (const entry of entries) {
        if (entry.isDirectory) continue;

        if (entry.entryName.split('/').length > MAX_ARCHIVE_DEPTH) {
          skipped.push(entry.entryName);
          continue;
        }
        // The header's declared size is checked before decompressing, and the real length is
        // checked after — a crafted archive can understate it.
        if (entry.header.size > MAX_ARCHIVE_ENTRY_BYTES) {
          skipped.push(entry.entryName);
          continue;
        }
        // An archive is attacker-controlled input: an entry named `.git/config` would
        // otherwise be written straight into the repository we are about to run git in.
        const target = safeArchiveEntry(incoming, entry.entryName);
        if (target === null) {
          skipped.push(entry.entryName);
          continue;
        }
        const data = entry.getData();
        if (data.length > MAX_ARCHIVE_ENTRY_BYTES) {
          skipped.push(entry.entryName);
          continue;
        }
        extractedBytes += data.length;
        if (extractedBytes > MAX_ARCHIVE_TOTAL_BYTES) {
          throw new ToolError(
            `refusing to import: the archive expands beyond ${Math.round(MAX_ARCHIVE_TOTAL_BYTES / (1024 * 1024))} MB`,
            'Extract it locally and upload only the sources the project needs.',
          );
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
        fileCount += 1;
      }
      if (skipped.length > 0) {
        log.warn(`skipped ${skipped.length} archive entr(ies) outside the project`, skipped.slice(0, 5));
      }
      await swapIn(this.dir, incoming, backup);
    } finally {
      await rm(incoming, { recursive: true, force: true });
    }

    const sha = await commitAll(this.repo, `pull ${this.projectName} (${fileCount} files)`);
    let head = sha ?? (await headSha(this.repo));
    if (!head) {
      // An empty project still needs a baseline commit, otherwise "has this mirror been
      // populated?" is unanswerable and every tool call would re-download the project.
      await git(this.repo, ['commit', '-q', '--allow-empty', '-m', `pull ${this.projectName} (empty project)`]);
      head = await headSha(this.repo);
    }
    if (head) await markPushed(this.repo, head);
    return { fileCount };
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
    const head = await headSha(this.repo);
    if (head) await markPushed(this.repo, head);

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
    await assertNotSymlink(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }

  /**
   * Move a file or directory within the project.
   *
   * This is a filesystem move rather than read-then-write, so renaming a figure or a PDF
   * works as well as renaming a `.tex` file.
   */
  async movePath(from: string, to: string): Promise<void> {
    const source = safeJoin(this.dir, from);
    const target = safeJoin(this.dir, to);
    if (source === target) return;
    if (!existsSync(source)) {
      throw new ToolError(`cannot rename ${from}: no such file`);
    }
    if (existsSync(target)) {
      throw new ToolError(
        `cannot rename ${from} to ${to}: something already exists at that path`,
        'Delete the existing file first, or choose another name.',
      );
    }
    await assertNotSymlink(target);
    await mkdir(dirname(target), { recursive: true });
    await moveEntry(source, target);
  }

  async remove(relPath: string): Promise<void> {
    const path = safeJoin(this.dir, relPath);
    if (!existsSync(path)) {
      throw new ToolError(`cannot delete ${relPath}: no such file`);
    }
    await rm(path, { recursive: true, force: true });
  }

  async commit(message: string): Promise<string | null> {
    return commitAll(this.repo, message);
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
   * push path commits what it staged. It does mean this is not a pure read, which is why
   * callers that must not mutate run it under the same lock as the operation it guards.
   */
  async changes(): Promise<PendingChange[]> {
    if (!existsSync(this.gitDir)) return [];
    await git(this.repo, ['add', '-A'], true);

    const watermark = await pushedSha(this.repo);
    const args = ['diff', '--cached', '--name-status', '-z', '--no-renames'];
    if (watermark) args.push(watermark);

    const result = await git(this.repo, args, true);
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
   * Uploads and deletes are separate phases, and a failure in the first one cancels the
   * second. That ordering is not cosmetic: a rename is an upload plus a delete, so letting
   * the delete proceed after a failed upload leaves the project with neither the new file
   * nor the old one — silent data loss, from an operation the user read as a rename.
   *
   * The watermark only advances when everything succeeded, so a partial push stays pending
   * and can simply be retried.
   */
  async push(client: OverleafClient): Promise<PushOutcome> {
    await this.ensure();
    const changes = await this.changes();
    if (changes.length === 0) {
      return { uploaded: [], deleted: [], failed: [], clean: true, deletionsDeferred: false };
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

    if (failed.length > 0) {
      log.warn(`holding back ${removals.length} deletion(s) because ${failed.length} upload(s) failed`);
      return { uploaded, deleted: [], failed, clean: false, deletionsDeferred: removals.length > 0 };
    }

    for (const change of removals) {
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
      const sha = await commitAll(this.repo, `push to Overleaf (${uploaded.length} up, ${deleted.length} down)`);
      const head = sha ?? (await headSha(this.repo));
      if (head) await markPushed(this.repo, head);
    }

    return { uploaded, deleted, failed, clean: false, deletionsDeferred: false };
  }

  // ── history & undo ───────────────────────────────────────────────────────

  async history(limit: number): Promise<Array<{ sha: string; date: string; message: string }>> {
    if (!existsSync(this.gitDir)) return [];
    const result = await git(
      this.repo,
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
    const log = await git(this.repo, ['log', '-n200', '--pretty=format:%H%x09%s'], true);
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

    const revert = await git(this.repo, ['revert', '--no-commit', ...targets], true);
    if (revert.code !== 0) {
      await git(this.repo, ['revert', '--abort'], true);
      throw new ToolError(
        `could not undo automatically: ${revert.stderr.trim() || 'the edits conflict'}`,
        'Read the affected files and adjust them directly instead.',
      );
    }
    const sha = await commitAll(this.repo, `undo ${targets.length} edit(s)`);
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
 * Replace the work tree's contents with a freshly extracted tree.
 *
 * Existing entries are moved aside with renames (cheap, and reversible) before the new ones
 * are moved in. The rollback is the delicate part: it removes only what was *installed* from
 * `incoming` and restores whatever the backup actually holds. An earlier version deleted
 * every remaining entry in the work tree, which destroyed exactly the files it was supposed
 * to protect — the ones that had not been backed up yet when the failure happened.
 */
async function swapIn(dir: string, incoming: string, backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true });
  await mkdir(backup, { recursive: true, mode: 0o700 });

  const installed: string[] = [];
  let succeeded = false;

  try {
    for (const entry of readdirSync(dir)) {
      await moveEntry(join(dir, entry), join(backup, entry));
    }
    for (const entry of readdirSync(incoming)) {
      await moveEntry(join(incoming, entry), join(dir, entry));
      installed.push(entry);
    }
    succeeded = true;
  } catch (error) {
    for (const entry of installed) {
      await rm(join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    // Restore from the directory listing rather than a record we may not have finished
    // writing when the failure happened.
    for (const entry of readdirSync(backup)) {
      await rm(join(dir, entry), { recursive: true, force: true }).catch(() => undefined);
      await moveEntry(join(backup, entry), join(dir, entry)).catch(() => undefined);
    }
    throw new ToolError(
      `could not replace the local mirror: ${errorMessage(error)}`,
      `The previous contents were restored where possible, and a copy is kept at ${backup}.`,
    );
  } finally {
    await rm(incoming, { recursive: true, force: true });
    // The backup is only redundant once the swap actually completed; otherwise it is the
    // recovery copy and must survive.
    if (succeeded) await rm(backup, { recursive: true, force: true });
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