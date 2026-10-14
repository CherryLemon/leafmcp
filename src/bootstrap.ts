/**
 * Must be the first import in the process. Nothing else may import before it.
 *
 * `@aloth/olcli` constructs a `conf` store at module-evaluation time, and `conf` resolves
 * its location from `env-paths` — `$XDG_CONFIG_HOME` on Linux, `$HOME` elsewhere. In a
 * container whose home directory is missing or read-only that constructor throws `EACCES`
 * during import, so the process dies before any of our code runs, with a stack trace that
 * points at an unrelated dependency.
 *
 * Redirecting the store into our own data directory makes startup independent of the home
 * directory. It also means the Overleaf session cookie, if it is ever cached there, lands
 * on the volume we already treat as sensitive rather than somewhere unmanaged.
 *
 * The environment is configured here rather than in `config.ts` because ESM evaluates
 * imports depth-first in declaration order: as long as this module is imported first, it
 * has run before any module that pulls in the Overleaf client.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadDotEnv } from './config.js';

loadDotEnv();

const dataDir = resolve(process.env.OLMCP_DATA_DIR ?? './data');
const configHome = resolve(dataDir, 'olcli-config');

try {
  mkdirSync(configHome, { recursive: true });
} catch {
  // If even our own data dir is unwritable the server has a bigger problem, and
  // `--check` / the first tool call will report it far more clearly than a throw here.
}

process.env.XDG_CONFIG_HOME ??= configHome;
// Windows and macOS builds of env-paths ignore XDG_CONFIG_HOME and use HOME instead.
if (!process.env.HOME) process.env.HOME = dataDir;