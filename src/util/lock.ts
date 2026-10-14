/**
 * A mutex keyed by project.
 *
 * The workspace is shared between requests, and a mutating operation is not one step: it
 * refreshes from Overleaf, reads, writes, commits and pushes. Two concurrent edits in the
 * same project can interleave inside that sequence — both read the same base, the second
 * overwrites the first, one commit ends up containing another request's half-finished
 * changes, and parallel pulls fight over the same staging directory.
 *
 * Locking the whole operation rather than each git command is what makes "read, decide,
 * write" atomic with respect to other clients. Different projects remain fully concurrent,
 * which is the case that matters when someone has a paper and a slides project open.
 *
 * This serialises within one process. Two server instances sharing a data directory would
 * still race, which is why the README says not to do that.
 */

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Number of keys currently queued; exposed for tests and diagnostics. */
  get activeKeys(): number {
    return this.tails.size;
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Run on both settle paths: one failed operation must not wedge the queue behind it.
    const result = previous.then(operation, operation);

    // What the next caller waits on. Deliberately never rejects, so a rejection here cannot
    // become an unhandled one now that nothing else observes it.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);

    // Forget the key once this operation is done and nobody queued behind it. Comparing
    // identity is what keeps a later arrival's chain from being dropped by an earlier one.
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });

    return result;
  }
}