/**
 * The child half of the isolated search.
 *
 * This file is never imported — it is spawned. It exists so that evaluating a
 * model-supplied regular expression happens in a process the parent can kill outright.
 *
 * The reason is that a regex such as `(a|aa)+$` backtracks exponentially: measured against
 * Node 22, 36 characters of input take ~6 seconds and 40 characters never finish. Since the
 * pattern runs on the same event loop that serves every other request, a single search could
 * otherwise take the whole server down until someone restarted it. A deadline checked
 * between lines cannot help, because the runaway match never returns to be checked. Only
 * terminating the execution context stops it.
 *
 * This file must keep importing nothing but Node built-ins. It is launched as a plain script,
 * and under `npm run dev` the sources are executed directly — a relative import written as
 * `./foo.js` (the form `tsc` requires) would not resolve to `foo.ts` there, and the search
 * would fail in development while working in the built output.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface SearchJob {
  /** Absolute path of the work tree; file paths in the job are relative to it. */
  root: string;
  files: string[];
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  maxResults: number;
  /** Only this many characters per line are ever handed to the pattern. */
  lineCap: number;
  /** Files larger than this are skipped rather than read into memory. */
  maxFileBytes: number;
  /** Stop once this many bytes have been read across all files. */
  maxTotalBytes: number;
  /** Skip these; reading them as text is pointless. */
  skip: (path: string) => boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  scanned: number;
  /** True when the byte budget stopped the search early. */
  budgetExhausted: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function runSearch(job: SearchJob): SearchResult {
  const matcher = new RegExp(job.isRegex ? job.pattern : escapeRegExp(job.pattern), job.caseSensitive ? '' : 'i');
  const hits: SearchHit[] = [];
  let scanned = 0;
  let bytesRead = 0;
  let budgetExhausted = false;

  for (const file of job.files) {
    if (hits.length >= job.maxResults) break;
    if (job.skip(file)) continue;

    // The parent's read tool enforces a size limit; this process reads files itself, so it
    // has to enforce its own. Without it a single large asset could be pulled into memory
    // once per search.
    let content: string;
    try {
      const stats = statSync(`${job.root}/${file}`);
      if (stats.size > job.maxFileBytes) continue;
      if (bytesRead + stats.size > job.maxTotalBytes) {
        budgetExhausted = true;
        break;
      }
      content = readFileSync(`${job.root}/${file}`, 'utf8');
      bytesRead += stats.size;
    } catch {
      continue;
    }
    scanned += 1;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? '';
      // Truncating bounds the work a single pattern can do against one line.
      if (matcher.test(raw.slice(0, job.lineCap))) {
        hits.push({ path: file, line: i + 1, text: raw.trim().slice(0, 300) });
        if (hits.length >= job.maxResults) break;
      }
    }
  }

  return { hits, scanned, budgetExhausted };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Omit<SearchJob, 'skip'> & {
    skip: string[];
  };
  const skipSet = new Set(job.skip);
  const result = runSearch({ ...job, skip: (path) => skipSet.has(path) });
  process.stdout.write(JSON.stringify(result));
}

// Run only when this file *is* the program. The parent imports `runSearch` directly for its
// own tests, and reading stdin then would hang the test runner.
const isEntryPoint = ((): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`search worker failed: ${String(error)}\n`);
    process.exit(1);
  });
}