/**
 * The per-project journal: what operations ran, and which change set they belong to.
 *
 * Undo used to be "revert the last N commits", which is a question about git rather than
 * about intent. It cannot answer "undo the edit that broke the bibliography", it counts a
 * reload from Overleaf as an edit-shaped thing, and it offers no way to say "these seven
 * edits are one change".
 *
 * So the model can open a change set explicitly. While one is open, edits accumulate in the
 * mirror and are published together when it is committed — which is what makes a multi-file
 * change atomic instead of a sequence of half-applied states that anyone reading the paper
 * in the meantime would see. Every mutating call records an operation, and both the operation
 * and the change set are addressable afterwards.
 *
 * This is metadata about work, never content: losing it costs history, not a paper.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { log } from '../util/logger.js';

export interface OperationRecord {
  id: string;
  tool: string;
  at: string;
  /** The mirror commit this operation produced, if it produced one. */
  commit: string | null;
  paths: string[];
  changeSetId?: string;
}

export interface ChangeSetRecord {
  id: string;
  description: string;
  startedAt: string;
  /** HEAD when the set was opened; abandoning returns the mirror to it. */
  baseCommit: string | null;
  committedAt?: string;
  abandonedAt?: string;
  /** How many operations were folded in, for the summary after committing. */
  operations?: number;
}

interface JournalShape {
  version: 1;
  open: ChangeSetRecord | null;
  changeSets: ChangeSetRecord[];
  operations: OperationRecord[];
}

const MAX_CHANGE_SETS = 100;
const MAX_OPERATIONS = 500;

function emptyJournal(): JournalShape {
  return { version: 1, open: null, changeSets: [], operations: [] };
}

function shortId(prefix: string): string {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class ProjectJournal {
  private data: JournalShape = emptyJournal();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<JournalShape>;
        this.data = {
          version: 1,
          open: parsed.open ?? null,
          changeSets: parsed.changeSets ?? [],
          operations: parsed.operations ?? [],
        };
      }
    } catch (error) {
      log.warn(`could not read the project journal, starting empty: ${String(error)}`);
      this.data = emptyJournal();
    }
    this.loaded = true;
  }

  /** Kept settled so one failed write cannot break every later one; see OAuthStore. */
  private persist(): Promise<void> {
    const attempt = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writeChain = attempt.catch(() => undefined);
    return attempt;
  }

  async getOpen(): Promise<ChangeSetRecord | null> {
    await this.load();
    return this.data.open;
  }

  async begin(description: string, baseCommit: string | null): Promise<ChangeSetRecord> {
    await this.load();
    if (this.data.open) {
      throw new Error(`change set ${this.data.open.id} is already open`);
    }
    const record: ChangeSetRecord = {
      id: shortId('cs'),
      description,
      startedAt: new Date().toISOString(),
      baseCommit,
      operations: 0,
    };
    this.data.open = record;
    await this.persist();
    return record;
  }

  /** Close the open set, recording whether it was published or discarded. */
  async close(outcome: 'committed' | 'abandoned'): Promise<ChangeSetRecord | null> {
    await this.load();
    const open = this.data.open;
    if (!open) return null;

    open.operations = this.data.operations.filter((op) => op.changeSetId === open.id).length;
    if (outcome === 'committed') open.committedAt = new Date().toISOString();
    else open.abandonedAt = new Date().toISOString();

    this.data.changeSets.unshift(open);
    this.data.changeSets = this.data.changeSets.slice(0, MAX_CHANGE_SETS);
    this.data.open = null;
    await this.persist();
    return open;
  }

  async record(operation: Omit<OperationRecord, 'id' | 'at'>): Promise<OperationRecord> {
    await this.load();
    const entry: OperationRecord = {
      ...operation,
      id: shortId('op'),
      at: new Date().toISOString(),
      ...(this.data.open ? { changeSetId: this.data.open.id } : {}),
    };
    this.data.operations.unshift(entry);
    this.data.operations = this.data.operations.slice(0, MAX_OPERATIONS);
    await this.persist();
    return entry;
  }

  async findOperation(id: string): Promise<OperationRecord | undefined> {
    await this.load();
    return this.data.operations.find((op) => op.id === id);
  }

  async findChangeSet(id: string): Promise<ChangeSetRecord | undefined> {
    await this.load();
    if (this.data.open?.id === id) return this.data.open;
    return this.data.changeSets.find((set) => set.id === id);
  }

  async recentOperations(limit: number): Promise<OperationRecord[]> {
    await this.load();
    return this.data.operations.slice(0, Math.max(0, limit));
  }

  /** Operations belonging to a change set, oldest first. */
  async operationsOf(changeSetId: string): Promise<OperationRecord[]> {
    await this.load();
    return this.data.operations.filter((op) => op.changeSetId === changeSetId).reverse();
  }

  /** Change sets that were committed and could still be reverted. */
  async committedChangeSets(limit: number): Promise<ChangeSetRecord[]> {
    await this.load();
    return this.data.changeSets.filter((set) => set.committedAt !== undefined).slice(0, Math.max(0, limit));
  }
}