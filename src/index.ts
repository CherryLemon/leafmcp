#!/usr/bin/env node
/**
 * Entry point.
 *
 * Two transports, one tool catalogue:
 *   - `http` (default) serves remote clients: Gemini, Claude, ChatGPT.
 *   - `stdio` serves local clients (Cursor, Claude Desktop, MCP Inspector) and is what the
 *     smoke test drives, so the same code path is exercised either way.
 *
 * Configuration is validated eagerly and the process refuses to start on an unsafe
 * combination — a server that edits someone's thesis should fail loudly at boot rather
 * than quietly at the first tool call.
 */

// Must stay first: it redirects the Overleaf client's config directory before that
// dependency is evaluated. See the comment in bootstrap.ts.
import './bootstrap.js';

import AdmZip from 'adm-zip';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, type AppConfig } from './config.js';
import { OAuthProvider, validateRedirectPatterns } from './auth/provider.js';
import { OAuthStore } from './auth/store.js';
import { ProjectRegistry, WorkspaceManager } from './overleaf/registry.js';
import { OverleafSession } from './overleaf/session.js';
import { SERVER_INSTRUCTIONS, registerTools } from './tools/index.js';
import { KeyedMutex } from './util/lock.js';
import { createHttpApp } from './transport/http.js';
import { errorMessage, registerSecret } from './util/errors.js';
import { log } from './util/logger.js';

const SERVER_NAME = 'overleaf-mcp';
const SERVER_VERSION = '0.1.0';

function parseTransport(argv: string[]): 'http' | 'stdio' {
  if (argv.includes('--stdio')) return 'stdio';
  if (argv.includes('--http')) return 'http';
  const fromEnv = (process.env.MCP_TRANSPORT ?? '').toLowerCase();
  if (fromEnv === 'stdio') return 'stdio';
  return 'http';
}

/**
 * Refuse to start on configurations that would silently weaken security or fail later.
 * Returning the problems lets `--check` print them all at once instead of one per run.
 */
function validate(config: AppConfig, transport: 'http' | 'stdio'): string[] {
  const problems: string[] = [];

  if (!config.overleaf.session && !(config.overleaf.email && config.overleaf.password)) {
    problems.push(
      'No Overleaf credentials. Set OVERLEAF_SESSION (the overleaf_session2 cookie value) ' +
        'or OVERLEAF_EMAIL + OVERLEAF_PASSWORD for a self-hosted instance.',
    );
  }

  if (!config.overleaf.baseUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(config.overleaf.baseUrl)) {
    problems.push(
      `OVERLEAF_BASE_URL is "${config.overleaf.baseUrl}". The Overleaf session cookie is a full-account ` +
        'credential and must not travel over plain HTTP except to localhost.',
    );
  }

  // Validated here rather than at provider construction, so `--check` reports it as a
  // configuration problem instead of the process dying with a stack trace.
  problems.push(...validateRedirectPatterns(config.auth.oauth.extraRedirectPatterns));

  if (transport === 'http') {
    if (config.auth.mode === 'oauth' && !process.env.MCP_OAUTH_PASSWORD) {
      problems.push(
        'MCP_AUTH_MODE=oauth requires MCP_OAUTH_PASSWORD. Without it any client that finds this ' +
          'URL could authorize itself against your Overleaf account.',
      );
    }
    if (config.auth.mode === 'bearer' && config.auth.tokens.length === 0) {
      problems.push(
        'MCP_AUTH_MODE=bearer requires MCP_BEARER_TOKENS. Set one, or choose MCP_AUTH_MODE=oauth ' +
          '(needed by ChatGPT and Gemini, which cannot send a static token).',
      );
    }
    if (config.auth.mode === 'none') {
      log.warn(
        'MCP_AUTH_MODE=none — this endpoint is public and anyone who learns the URL can read and ' +
          'edit your Overleaf projects.',
      );
    }
    if (!config.publicUrl.startsWith('https://') && process.env.NODE_ENV === 'production') {
      problems.push(
        `PUBLIC_URL is "${config.publicUrl}". Remote clients connect from their vendors' clouds and ` +
          'require a public https endpoint; OAuth discovery metadata must match it exactly.',
      );
    }
  }

  return problems;
}

async function runStdio(config: AppConfig): Promise<void> {
  const session = new OverleafSession(config.overleaf);
  const registry = new ProjectRegistry(session, config);
  const workspaces = new WorkspaceManager(config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, {
    config,
    session,
    registry,
    workspaces,
    locks: new KeyedMutex(),
    readOnly: config.readOnly,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel here; logs must stay on stderr.
  log.info('overleaf-mcp ready on stdio');
}

async function runHttp(config: AppConfig): Promise<void> {
  const store = new OAuthStore(`${config.dataDir}/oauth.json`);
  await store.load();

  const provider = new OAuthProvider({
    store,
    issuer: config.auth.oauth.issuer,
    resourceUrl: `${config.publicUrl}/mcp`,
    password: process.env.MCP_OAUTH_PASSWORD ?? '',
    extraRedirectUrls: config.auth.oauth.extraRedirectUrls,
    extraRedirectPatterns: config.auth.oauth.extraRedirectPatterns,
    staticTokens: config.auth.tokens,
    oauthEnabled: config.auth.mode === 'oauth',
  });

  const app = createHttpApp({ config, provider, store });

  const server = app.listen(config.port, config.host, () => {
    log.info(`overleaf-mcp listening on ${config.host}:${config.port}`);
    log.info(`  MCP endpoint : ${config.publicUrl}/mcp`);
    log.info(`  auth mode    : ${config.auth.mode}${config.readOnly ? ' (read-only)' : ''}`);
    log.info(`  auto-publish : ${config.autoPush ? 'on' : 'off'}`);
    log.info(`  data dir     : ${config.dataDir}`);
  });

  const shutdown = (signal: string): void => {
    log.info(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on a lingering SSE connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Check the Overleaf credentials on their own, before any client is involved.
 *
 * Credential problems and MCP problems present almost identically from a chat client
 * ("it says something went wrong"), so being able to test the Overleaf half in isolation is
 * what turns a vague failure into a one-line fix.
 */
/**
 * Exercise every Overleaf capability this server depends on, read-only, and report each one.
 *
 * The point is diagnosis. In a chat window a broken cookie and an incompatible upstream look
 * identical — "something went wrong" — so the useful failure is the one that says *which*
 * call failed. Nothing here writes: no file is uploaded, no comment is posted, and the
 * project is untouched.
 *
 * `--compile` adds the one slow check, since a LaTeX build takes tens of seconds and is the
 * only step that is not instant.
 */
async function verifyOverleaf(config: AppConfig, options: { compile: boolean }): Promise<void> {
  const session = new OverleafSession(config.overleaf);
  let failures = 0;

  const pass = (label: string, detail?: string): void => {
    process.stdout.write(`  ok    ${label}${detail ? ` — ${detail}` : ''}\n`);
  };
  const fail = (label: string, error: unknown): void => {
    failures += 1;
    process.stdout.write(`  FAIL  ${label} — ${errorMessage(error)}\n`);
  };
  const step = async <T>(label: string, run: () => Promise<T>, detail?: (value: T) => string): Promise<T | undefined> => {
    try {
      const value = await run();
      pass(label, detail?.(value));
      return value;
    } catch (error) {
      fail(label, error);
      return undefined;
    }
  };

  process.stdout.write(`Overleaf at ${config.overleaf.baseUrl}, read-only checks\n\n`);

  const projects = await step('sign in and list projects', () => session.run((c) => c.listProjects()),
    (list) => `${list.length} project(s)`);
  if (!projects) {
    process.stdout.write('\nThe session cookie is the usual cause. Re-copy overleaf_session2 from\n');
    process.stdout.write('DevTools → Application → Cookies while logged in, then set OVERLEAF_SESSION.\n');
    process.exitCode = 1;
    return;
  }

  if (projects.length === 0) {
    process.stdout.write('\nThe account has no projects, so nothing further can be checked.\n');
    return;
  }

  // Prefer the configured default so the check runs against the project that will actually be used.
  const target =
    projects.find((p) => p.id === config.defaultProject || p.name === config.defaultProject) ?? projects[0];
  if (!target) return;
  process.stdout.write(`\n  project: ${target.name} (${target.id})\n\n`);

  const info = await step('project metadata', () => session.run((c) => c.getProjectInfo(target.id)),
    (value) => `${value.rootFolder.length} top-level entr(ies)`);
  if (!info) {
    process.stdout.write('\nWithout project metadata nothing else can be checked.\n');
    process.exitCode = 1;
    return;
  }

  // The archive is what `pull` uses, and it also gives us a real path to fetch individually.
  const archive = await step('download the project archive', () => session.run((c) => c.downloadProject(target.id)),
    (buffer) => `${(buffer.length / 1024).toFixed(0)} KB`);
  let sample: string | undefined;
  if (archive) {
    try {
      const entries = new AdmZip(archive).getEntries().filter((e) => !e.isDirectory);
      pass('read the archive', `${entries.length} file(s), e.g. ${entries[0]?.entryName ?? '(none)'}`);
      sample = entries.find((e) => /\.(tex|ltx)$/i.test(e.entryName))?.entryName ?? entries[0]?.entryName;
    } catch (error) {
      fail('read the archive', error);
    }
  }

  if (sample) {
    await step(`download a single file (${sample})`, () => session.run((c) => c.downloadByPath(target.id, sample)),
      (buffer) => `${buffer.length} bytes`);
  }

  await step('list review comments', () => session.run((c) => c.listComments(target.id, { status: 'all' })),
    (comments) => `${comments.length} thread(s)`);

  if (options.compile) {
    process.stdout.write('\n  compiling (this takes a while, and changes nothing)\n');
    await step('compile the project', () => session.run((c) => c.compileProject(target.id)),
      (result) => (result.pdfUrl ? 'a PDF was produced' : 'no PDF URL returned'));
  } else {
    process.stdout.write('\n  (compilation not checked; pass --compile to include it)\n');
  }

  process.stdout.write('\n');
  if (failures === 0) {
    process.stdout.write('Every check passed. The Overleaf side works.\n');
    return;
  }
  process.stdout.write(`${failures} check(s) failed. Fix those before connecting a client.\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Register the real credential values so they are scrubbed from every log line and tool
  // result no matter how they surface.
  registerSecret(config.overleaf.session);
  registerSecret(config.overleaf.password);
  registerSecret(process.env.MCP_OAUTH_PASSWORD);

  const transport = parseTransport(process.argv.slice(2));

  const problems = validate(config, transport);

  if (process.argv.includes('--verify')) {
    const credentialProblem = problems.find((p) => p.startsWith('No Overleaf credentials'));
    if (credentialProblem) {
      log.error(credentialProblem);
      process.exitCode = 1;
      return;
    }
    try {
      await verifyOverleaf(config, { compile: process.argv.includes('--compile') });
    } catch (error) {
      log.error(`Overleaf rejected the credentials: ${errorMessage(error)}`);
      process.stdout.write(
        '\nThe session cookie is the most likely cause. Re-copy overleaf_session2 from\n' +
          'DevTools → Application → Cookies while logged in, then set OVERLEAF_SESSION again.\n',
      );
      process.exitCode = 1;
    }
    return;
  }

  if (process.argv.includes('--check')) {
    if (problems.length === 0) {
      process.stdout.write('Configuration looks valid.\n');
      return;
    }
    for (const problem of problems) process.stdout.write(`- ${problem}\n`);
    process.exitCode = 1;
    return;
  }

  if (problems.length > 0) {
    for (const problem of problems) log.error(problem);
    log.error('refusing to start; fix the above or run with --check to review');
    process.exit(1);
  }

  if (transport === 'stdio') await runStdio(config);
  else await runHttp(config);
}

main().catch((error: unknown) => {
  log.error(`fatal: ${errorMessage(error)}`);
  process.exit(1);
});