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
  commitPaths,
  createRepo,
  git,
  gitBlob,
  hardenRepo,
  headSha,
  type GitRepo,
} from '../util/git.js';
import { log } from '../util/logger.js';
import { ProjectJournal, type ChangeSetRecord } from './journal.js';
import {
  assertInsideRealRoot,
  assertNotSymlink,
  normalizeRelPath,
  safeArchiveEntry,
  safeJoin,
} from '../util/paths.js';

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

/**
 * What Overleaf was last known to hold, per file.
 *
 * Change detection used to be a single `refs/overleaf/pushed` commit, which is wrong whenever
 * a file can become up to date on its own: refreshing `b.tex` from the browser while `a.tex`
 * still had unpublished edits advanced that one ref past both, and `a.tex` then looked
 * already-published and was never uploaded. A per-file record has no such failure mode —
 * updating one entry cannot speak for another file.
 *
 * It also removes git from the trust path. Deriving "what needs publishing" from the index
 * meant a failed `git add` produced a confident "nothing to publish"; here the answer comes
 * from hashing the files themselves.
 */
interface SyncManifest {
  version: 1;
  /** Project-relative path -> sha256 of the content Overleaf is believed to hold. */
  remote: Record<string, string>;
}

const EMPTY_MANIFEST: SyncManifest = { version: 1, remote: {} };

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
  const name = relPath.split('/').pop() ?? relPath;
  const dot = name.lastIndexOf('.');

  // A leading dot is not an extension: `.latexmkrc`, `.gitignore` and `.olignore` are
  // configuration text. Treating them as extensionless binaries hid them from search and
  // refused to read them, which is the opposite of what a project config deserves.
  if (dot <= 0) return false;

  return !TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export class ProjectWorkspace {
  /** The work tree: project files only, exactly what the model may touch. */
  readonly dir: string;
  /** Git metadata, deliberately a sibling rather than a child of the work tree. */
  readonly gitDir: string;
  /** Per-file record of what Overleaf holds; see `SyncManifest`. */
  private readonly manifestPath: string;

  constructor(
    private readonly root: string,
    readonly projectId: string,
    readonly projectName: string,
    private readonly limits: { maxFileBytes: number },
  ) {
    const segment = sanitizeSegment(projectId);
    this.dir = join(root, 'projects', segment);
    this.gitDir = join(root, 'meta', `${segment}.git`);
    this.manifestPath = join(root, 'meta', `${segment}.sync.json`);
    this.journal = new ProjectJournal(join(root, 'meta', `${segment}.journal.json`));
  }

  /** Operations and change sets for this project; see `journal.ts`. */
  readonly journal: ProjectJournal;

  private get repo(): GitRepo {
    return { gitDir: this.gitDir, workDir: this.dir };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async ensure(): Promise<void> {
    // 0700: these directories hold someone's unpublished papers.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.gitDir), { recursive: true, mode: 0o700 });

    if (!existsSync(this.gitDir) && existsSync(join(this.dir, '.git'))) {
      await this.migrateLegacyLayout();
      return;
    }
    if (!existsSync(this.gitDir)) {
      await createRepo(this.gitDir, this.dir);
    }
  }

  /**
   * Move a pre-existing in-tree `.git` to the separated layout.
   *
   * Two things make this more than a directory move.
   *
   * The old configuration is untrusted. It lived inside the tree the assistant could write
   * to, and git configuration can name programs to run (`core.fsmonitor`, `core.hooksPath`,
   * `filter.*.clean`), so it is replaced wholesale rather than read — nothing from it is
   * allowed to reach a git invocation. Objects and refs are data, so they are carried over,
   * and that is what preserves history.
   *
   * The sync state is reconstructed rather than guessed. The old watermark ref says which
   * commit Overleaf held, so files that differ from it are still unpublished and their
   * manifest entry must be the *watermark's* content — otherwise a pending edit would be
   * recorded as already published and never sent. If the ref is missing, nothing is assumed
   * published: the files are re-uploaded, which is idempotent and cannot lose anything.
   */
  private async migrateLegacyLayout(): Promise<void> {
    const legacyDir = join(this.dir, '.git');
    log.warn(`migrating ${this.projectId} to the separated git layout`);

    // Read the watermark as a plain file, before any git command touches the moved directory.
    const legacyWatermark = await readFile(join(legacyDir, 'refs', 'overleaf', 'pushed'), 'utf8')
      .then((value) => value.trim())
      .catch(() => null);

    await moveEntry(legacyDir, this.gitDir);

    // A known-good configuration, written rather than parsed.
    await writeFile(
      join(this.gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n',
      'utf8',
    );
    // Per-worktree config is an extension that could reintroduce settings we just replaced.
    await rm(join(this.gitDir, 'config.worktree'), { force: true });
    await rm(join(this.gitDir, 'hooks'), { recursive: true, force: true });

    const repo: GitRepo = { gitDir: this.gitDir, workDir: this.dir };
    await hardenRepo(repo);

    const manifest: SyncManifest = { version: 1, remote: {} };
    if (legacyWatermark) {
      const tracked = (await git(repo, ['ls-tree', '-r', '--name-only', legacyWatermark], true)).stdout
        .split('\n')
        .filter(Boolean);
      // Untracked files must be included explicitly: `git diff` cannot see them, so a file
      // created locally but never committed would be recorded as already published — the
      // same blind spot that once kept new files out of a push, in a new place.
      const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard'], true)).stdout
        .split('\n')
        .filter(Boolean);
      const changed = new Set([
        ...(await git(repo, ['diff', '--name-only', legacyWatermark], true)).stdout.split('\n').filter(Boolean),
        ...untracked,
      ]);

      for (const path of this.listFiles()) {
        if (!changed.has(path)) {
          // Untouched since the last push, so local content is what Overleaf holds.
          await this.recordCurrentHash(manifest, path);
          continue;
        }
        const blob = await gitBlob(repo, `${legacyWatermark}:${path}`);
        // No blob means the file is new since the watermark, so it is genuinely unpublished.
        if (blob) manifest.remote[path] = createHash('sha256').update(blob).digest('hex');
      }

      // Files deleted locally must stay in the manifest, or the deletion would be invisible.
      for (const path of tracked) {
        if (manifest.remote[path] !== undefined) continue;
        const blob = await gitBlob(repo, `${legacyWatermark}:${path}`);
        if (blob) manifest.remote[path] = createHash('sha256').update(blob).digest('hex');
      }
    } else {
      log.warn(`no sync watermark found for ${this.projectId}; treating every file as unpublished`);
    }

    await this.saveManifest(manifest);
    log.warn(
      `migrated ${this.projectId}: ${Object.keys(manifest.remote).length} file(s) recorded as published`,
    );
  }

  private async recordCurrentHash(manifest: SyncManifest, relative: string): Promise<void> {
    try {
      const content = await readFile(safeJoin(this.dir, relative));
      manifest.remote[relative] = createHash('sha256').update(content).digest('hex');
    } catch {
      // Unreadable now; leaving it out means it re-uploads rather than being assumed synced.
    }
  }

  /** True once the mirror reflects a real Overleaf state (i.e. a pull has completed). */
  async isInitialized(): Promise<boolean> {
    return existsSync(this.manifestPath);
  }

  private async loadManifest(): Promise<SyncManifest> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Partial<SyncManifest>;
      return { version: 1, remote: parsed.remote ?? {} };
    } catch {
      return { ...EMPTY_MANIFEST, remote: {} };
    }
  }

  private async saveManifest(manifest: SyncManifest): Promise<void> {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.manifestPath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.manifestPath);
  }

  /** Hash every project file, so the stored values mean something about content. */
  private async hashProjectFiles(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const relative of this.listFiles()) {
      try {
        const content = await readFile(safeJoin(this.dir, relative));
        hashes.set(relative, createHash('sha256').update(content).digest('hex'));
      } catch {
        // A file we cannot read is not a file we can claim is in sync, so it is left out and
        // will surface as "deleted" until it is readable again.
      }
    }
    return hashes;
  }

  /**
   * Replace the mirror contents with a fresh copy of the project from Overleaf.
   * Refuses to discard unpushed edits unless `force` is set — those edits are the
   * only copy of the model's work until a push succeeds.
   */
  async pull(client: OverleafClient, options: { force?: boolean } = {}): Promise<{ fileCount: number }> {
    await this.ensure();

    // Local files with no sync record means the metadata was lost or an upgrade was
    // interrupted. Overwriting is almost certainly not what anyone wants, and the old guard
    // below cannot catch it because with no manifest there is nothing to compare against.
    if (!options.force && !(await this.isInitialized())) {
      const present = this.listFiles();
      if (present.length > 0) {
        throw new ToolError(
          `refusing to pull: ${present.length} file(s) exist locally but this mirror has no record of what Overleaf holds`,
          'This happens after an interrupted upgrade or if the sync state was removed. Pass ' +
            'force=true to replace the local files with the copy from Overleaf.',
        );
      }
    }

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
    if (!sha && !(await headSha(this.repo))) {
      // An empty project still needs a first commit: without HEAD there is no history for
      // `undo` and `edit_history` to refer to.
      await git(this.repo, ['commit', '-q', '--allow-empty', '-m', `pull ${this.projectName} (empty project)`]);
    }

    // Written last, and it is what marks the mirror ready. A crash before this point leaves
    // the project to be pulled again rather than a half-populated mirror that reports itself
    // as initialised.
    await this.saveManifest({ version: 1, remote: Object.fromEntries(await this.hashProjectFiles()) });
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
    const normalized = normalizeRelPath(relPath);

    // Scoped to this file, not the whole project. Refusing to refresh anything while any
    // other file is unpublished was the safe answer under the old shared baseline, and it
    // cost freshness exactly when a batch of edits was in progress. With per-file state,
    // refreshing `b.tex` cannot disturb `a.tex`.
    const pending = await this.changes();
    if (pending.some((change) => change.path === normalized)) return false;

    const path = safeJoin(this.dir, normalized);
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

    // Exactly one entry moves. This is the fix for the worst consequence of the old shared
    // watermark: refreshing one file used to advance a project-wide marker past *every*
    // commit, so another file's unpublished edit silently became "already published" and was
    // never uploaded.
    const manifest = await this.loadManifest();
    manifest.remote[normalized] = createHash('sha256').update(remote).digest('hex');
    await this.saveManifest(manifest);

    // Committed for history only, and only this path, so the log does not take credit for
    // edits made elsewhere.
    await commitPaths(this.repo, [normalized], `refresh ${normalized} from Overleaf`);

    log.debug(`refreshed ${normalized} from Overleaf (${remote.length} bytes)`);
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
        // Only git's own names are hidden. Everything else that starts with a dot is an
        // ordinary project file — a `.latexmkrc`, a `.olignore` — and hiding it from the
        // listing while the read tool would happily return it by name was the inconsistency:
        // the model could not discover the file, but could still be told about it.
        if (entry.name.toLowerCase().startsWith('.git')) continue;
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
    await assertInsideRealRoot(this.dir, path);
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
    await assertInsideRealRoot(this.dir, target);
    await mkdir(dirname(target), { recursive: true });
    await moveEntry(source, target);
  }

  /**
   * Describe what deleting a path would remove.
   *
   * `rm -r` on a directory takes everything under it, and the caller only ever named the
   * directory. Reporting the contents first is what turns an accidental "delete the folder"
   * from a silent sweep of twenty files into a decision someone can make.
   */
  async describeDeletion(relPath: string): Promise<{ isDirectory: boolean; files: string[] }> {
    const path = safeJoin(this.dir, relPath);
    if (!existsSync(path)) {
      throw new ToolError(`cannot delete ${relPath}: no such file`);
    }
    const info = await stat(path);
    if (!info.isDirectory()) return { isDirectory: false, files: [normalizeRelPath(relPath)] };

    const prefix = `${normalizeRelPath(relPath)}/`;
    return {
      isDirectory: true,
      files: this.listFiles().filter((file) => file.startsWith(prefix)),
    };
  }

  async remove(relPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    const path = safeJoin(this.dir, relPath);
    if (!existsSync(path)) {
      throw new ToolError(`cannot delete ${relPath}: no such file`);
    }
    await assertInsideRealRoot(this.dir, path);

    const info = await stat(path);
    if (info.isDirectory() && options.recursive !== true) {
      throw new ToolError(
        `${relPath} is a directory, not a file`,
        'Pass recursive=true to delete it and everything inside it.',
      );
    }
    await rm(path, { recursive: true, force: true });
  }

  async commit(message: string): Promise<string | null> {
    return commitAll(this.repo, message);
  }

  // ── diffing against Overleaf ─────────────────────────────────────────────

  /**
   * Files whose content differs from what Overleaf is known to hold.
   *
   * Computed by hashing the project files against the per-file manifest, so this is a pure
   * read: it stages nothing, takes no lock, and cannot fail open. The previous implementation
   * asked git, which meant an `add` that failed (a full disk, an unreadable file) could leave
   * the index untouched and produce a confident empty list — the server would then report
   * "already synced" about changes it had never sent.
   */
  async changes(): Promise<PendingChange[]> {
    if (!existsSync(this.manifestPath)) return [];

    const manifest = await this.loadManifest();
    const current = await this.hashProjectFiles();
    const changes: PendingChange[] = [];

    for (const [path, hash] of current) {
      const known = manifest.remote[path];
      if (known === undefined) changes.push({ path, status: 'added' });
      else if (known !== hash) changes.push({ path, status: 'modified' });
    }
    for (const path of Object.keys(manifest.remote)) {
      if (!current.has(path)) changes.push({ path, status: 'deleted' });
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
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
      // Record only the files that actually landed, and hash them from disk so the recorded
      // value describes what was sent rather than what we intended to send.
      const manifest = await this.loadManifest();
      const current = await this.hashProjectFiles();
      for (const path of uploaded) {
        const hash = current.get(path);
        if (hash !== undefined) manifest.remote[path] = hash;
      }
      for (const path of deleted) delete manifest.remote[path];
      await this.saveManifest(manifest);
      await commitAll(this.repo, `push to Overleaf (${uploaded.length} up, ${deleted.length} down)`);
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

  // ── change sets ──────────────────────────────────────────────────────────

  /**
   * Open a change set: everything edited until it is committed or abandoned stays local.
   *
   * This is where atomicity comes from. Without it, a five-file revision reaches Overleaf one
   * file at a time and anyone reading the paper in between sees a state that never existed as
   * a whole — and if the model stops half way, that state is simply left there.
   */
  async beginChangeSet(description: string): Promise<ChangeSetRecord> {
    await this.ensure();
    const base = await headSha(this.repo);
    const record = await this.journal.begin(description, base);
    log.info(`change set ${record.id} opened for ${this.projectId}: ${description}`);
    return record;
  }

  /** Close the open change set. Callers publish first; a failed publish keeps it open. */
  async closeChangeSet(outcome: 'committed' | 'abandoned'): Promise<ChangeSetRecord | null> {
    return this.journal.close(outcome);
  }

  /**
   * Discard the open change set and return the mirror to the state it opened from.
   *
   * Returns the files that were discarded, computed before the reset so the answer describes
   * what was actually thrown away rather than what remains.
   */
  async abandonChangeSet(baseCommit: string | null): Promise<string[]> {
    const discarded = await this.filesChangedSince(baseCommit);
    if (baseCommit) {
      await git(this.repo, ['reset', '--hard', '-q', baseCommit]);
    }
    await this.closeChangeSet('abandoned');
    return discarded;
  }

  /** Paths differing between a commit and the current work tree, including untracked files. */
  async filesChangedSince(commit: string | null): Promise<string[]> {
    if (!commit) return this.listFiles();
    const diff = await git(this.repo, ['diff', '--name-only', commit], true);
    const untracked = await git(this.repo, ['ls-files', '--others', '--exclude-standard'], true);
    return [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))].sort();
  }

  /**
   * Reverse one commit, leaving everything after it in place.
   *
   * Reverting rather than resetting is what makes this "undo that operation" instead of
   * "discard everything since" — and it keeps the original edit in history, so a mistaken
   * undo is itself undoable.
   */
  async revertCommit(commit: string): Promise<void> {
    const revert = await git(this.repo, ['revert', '--no-commit', commit], true);
    if (revert.code !== 0) {
      await git(this.repo, ['revert', '--abort'], true);
      // The explanation is the message, and git's own output is the detail. Putting the raw
      // stderr in the message meant a caller only saw our explanation when git happened to be
      // silent — which is the opposite of when it is needed.
      throw new ToolError(
        `could not reverse ${commit.slice(0, 8)}: the change conflicts with later edits`,
        `git reported: ${(revert.stderr.trim() || revert.stdout.trim() || 'the revert did not apply').slice(0, 300)}. ` +
          'Read the affected file and adjust it directly instead.',
      );
    }
    await commitAll(this.repo, `undo operation ${commit.slice(0, 8)}`);
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