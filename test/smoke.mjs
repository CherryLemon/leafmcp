/**
 * End-to-end smoke test for the parts that do not need a real Overleaf account.
 *
 * The riskiest code in this project is not the LaTeX handling, it is the OAuth handshake:
 * three vendors' clients will hit it, none of them can be tested from here, and a subtle
 * deviation in discovery metadata or PKCE produces a generic "not a valid MCP server"
 * error with nothing to debug. So this test walks the whole documented flow for real —
 * discovery, dynamic registration, consent, PKCE, refresh rotation — and then drives an
 * actual MCP session (initialize + tools/list) over the authenticated endpoint.
 *
 * Run against the built output (`npm run build && node test/smoke.mjs`), so it also proves
 * the compiled artifact works, not just the sources.
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PASS = 'correct horse battery staple';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const EVIL_CALLBACK = 'https://attacker.example.com/steal';

const dataDir = mkdtempSync(join(tmpdir(), 'overleaf-mcp-smoke-'));
process.env.OLMCP_DATA_DIR = dataDir;
process.env.PUBLIC_URL = 'https://mcp.example.com';
process.env.MCP_AUTH_MODE = 'oauth';
process.env.MCP_OAUTH_PASSWORD = PASS;
process.env.OVERLEAF_SESSION = 'smoke-test-cookie';
process.env.LOG_LEVEL = 'error';

const { loadConfig } = await import('../dist/bootstrap.js').then(() => import('../dist/config.js'));
const { ProjectWorkspace } = await import('../dist/overleaf/workspace.js');
const { buildTools } = await import('../dist/tools/build.js');
const AdmZip = (await import('adm-zip')).default;
const { OAuthProvider } = await import('../dist/auth/provider.js');
const { OAuthStore } = await import('../dist/auth/store.js');
const { createHttpApp } = await import('../dist/transport/http.js');
const { parseLatexLog } = await import('../dist/overleaf/latexlog.js');
const { summarizeLatex } = await import('../dist/overleaf/latex.js');
const { normalizeRelPath } = await import('../dist/util/paths.js');

let checks = 0;
let failures = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// ── boot the app ─────────────────────────────────────────────────────────────

const config = loadConfig();
const store = new OAuthStore(join(dataDir, 'oauth.json'));
await store.load();
const provider = new OAuthProvider({
  store,
  issuer: config.auth.oauth.issuer,
  resourceUrl: `${config.publicUrl}/mcp`,
  password: PASS,
  oauthEnabled: true,
});
const app = createHttpApp({ config, provider, store });
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

try {
  // ── discovery ──────────────────────────────────────────────────────────────
  section('OAuth discovery metadata');

  const prm = await fetch(`${base}/.well-known/oauth-protected-resource`).then((r) => r.json());
  check('protected-resource `resource` is the exact MCP URL', prm.resource === 'https://mcp.example.com/mcp', prm.resource);
  check('protected-resource names the authorization server', prm.authorization_servers?.[0] === 'https://mcp.example.com', JSON.stringify(prm.authorization_servers));
  const prmPath = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  check('path-aware protected-resource variant is served', prmPath.resource === prm.resource);

  const asMeta = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  check('AS metadata advertises PKCE S256', asMeta.code_challenge_methods_supported?.includes('S256'));
  check('AS metadata advertises DCR', typeof asMeta.registration_endpoint === 'string');
  check('AS metadata allows public clients', asMeta.token_endpoint_auth_methods_supported?.includes('none'));
  check('AS issuer matches', asMeta.issuer === 'https://mcp.example.com', asMeta.issuer);

  // ── unauthenticated access ─────────────────────────────────────────────────
  section('Unauthenticated MCP access is refused with a discovery hint');

  const anonymous = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check('no token → 401', anonymous.status === 401, String(anonymous.status));
  const challenge = anonymous.headers.get('www-authenticate') ?? '';
  check('401 carries resource_metadata', challenge.includes('resource_metadata='), challenge);
  check('401 scope hint present', challenge.includes('scope='), challenge);

  const bogus = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check('invalid token → 401', bogus.status === 401, String(bogus.status));

  // ── dynamic client registration ────────────────────────────────────────────
  section('Dynamic client registration');

  const rejected = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'evil', redirect_uris: [EVIL_CALLBACK] }),
  });
  check('unknown redirect_uri is refused (open-redirect guard)', rejected.status === 400, String(rejected.status));

  const registered = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] }),
  });
  check('known vendor callback registers', registered.status === 201, String(registered.status));
  const client = await registered.json();
  check('registration returns a client_id', typeof client.client_id === 'string' && client.client_id.length > 0);
  check('public client gets no secret', client.client_secret === undefined);

  const gemini = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Gemini',
      redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123-example-com'],
    }),
  });
  check('Gemini redirect pattern is allowlisted', gemini.status === 201, String(gemini.status));

  // ── authorization code + PKCE ──────────────────────────────────────────────
  section('Authorization code flow with PKCE');

  const verifier = randomBytes(32).toString('base64url');
  const challengeValue = createHash('sha256').update(verifier).digest('base64url');
  const authorizeQuery = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    state: 'xyz-state',
    code_challenge: challengeValue,
    code_challenge_method: 'S256',
    scope: 'overleaf.read overleaf.write',
    resource: 'https://mcp.example.com/mcp',
  });

  const consent = await fetch(`${base}/oauth/authorize?${authorizeQuery}`);
  const consentHtml = await consent.text();
  check('consent screen renders', consent.status === 200 && consentHtml.includes('Authorize access to Overleaf'));
  check('consent screen names the client', consentHtml.includes('Claude'));

  const wrongPassword = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery), password: 'wrong' }),
    redirect: 'manual',
  });
  check('wrong passphrase is refused', wrongPassword.status === 401, String(wrongPassword.status));

  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery), password: PASS }),
    redirect: 'manual',
  });
  check('correct passphrase redirects', approved.status === 302, String(approved.status));
  const location = new URL(approved.headers.get('location'));
  check('redirect goes to the registered callback', location.origin + location.pathname === CLAUDE_CALLBACK);
  check('state is echoed back', location.searchParams.get('state') === 'xyz-state');
  const code = location.searchParams.get('code');
  check('authorization code issued', typeof code === 'string' && code.length > 20);

  const badPkce = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: randomBytes(32).toString('base64url'),
    }),
  });
  check('wrong PKCE verifier is refused', badPkce.status === 400, String(badPkce.status));

  // The failed attempt above consumed the code (single-use), so start a fresh one.
  const secondApprove = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery), password: PASS }),
    redirect: 'manual',
  });
  const code2 = new URL(secondApprove.headers.get('location')).searchParams.get('code');

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code2,
      client_id: client.client_id,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
    }),
  });
  check('token exchange succeeds', tokenResponse.status === 200, String(tokenResponse.status));
  const tokens = await tokenResponse.json();
  check('access token returned', typeof tokens.access_token === 'string');
  check('refresh token returned', typeof tokens.refresh_token === 'string');
  check('token type is Bearer', tokens.token_type === 'Bearer');

  const replay = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code2,
      client_id: client.client_id,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
    }),
  });
  check('authorization code cannot be replayed', replay.status === 400, String(replay.status));

  // ── refresh rotation ───────────────────────────────────────────────────────
  section('Refresh token rotation');

  const refreshed = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  check('refresh grant succeeds', refreshed.status === 200, String(refreshed.status));
  const rotated = await refreshed.json();
  check('rotation issues a new refresh token', rotated.refresh_token !== tokens.refresh_token);

  const reuse = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  check('consumed refresh token is rejected', reuse.status === 400, String(reuse.status));

  // ── authenticated MCP session ──────────────────────────────────────────────
  section('MCP session over the authenticated endpoint');

  const authHeaders = { ...MCP_HEADERS, authorization: `Bearer ${rotated.access_token}` };

  const unregistered = await fetch(`${base}/mcp`, { method: 'GET', headers: authHeaders });
  check('GET /mcp answers 405 with Allow: POST', unregistered.status === 405 && unregistered.headers.get('allow') === 'POST');

  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1.0.0' },
      },
    }),
  });
  check('initialize succeeds', init.status === 200, String(init.status));
  const initBody = await init.json();
  check('server identifies itself', initBody.result?.serverInfo?.name === 'overleaf-mcp', JSON.stringify(initBody.result?.serverInfo));
  check('server returns instructions', typeof initBody.result?.instructions === 'string' && initBody.result.instructions.length > 50);
  const negotiated = initBody.result?.protocolVersion;
  check('protocol version negotiated', typeof negotiated === 'string', String(negotiated));

  const list = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const listBody = await list.json();
  const tools = listBody.result?.tools ?? [];
  check('tools/list returns the catalogue', tools.length >= 20, `${tools.length} tools`);
  const names = tools.map((t) => t.name);
  for (const required of ['list_projects', 'use_project', 'read_file', 'edit_file', 'write_file', 'compile', 'undo_last_edit', 'list_comments']) {
    check(`tool present: ${required}`, names.includes(required));
  }
  check(
    'every tool has a description and schema',
    tools.every((t) => typeof t.description === 'string' && t.description.length > 10 && t.inputSchema),
  );
  check(
    'read-only hints are set on read tools',
    tools.find((t) => t.name === 'read_file')?.annotations?.readOnlyHint === true,
  );
  check(
    'destructive hint set on delete',
    tools.find((t) => t.name === 'delete_file')?.annotations?.destructiveHint === true,
  );

  // A tool call reaches the real Overleaf layer; without valid credentials it must come
  // back as a *tool error*, not a transport failure — that distinction is what lets a
  // model explain the problem to the user.
  const call = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_projects', arguments: {} },
    }),
  });
  const callBody = await call.json();
  check('tool call returns a JSON-RPC result', call.status === 200 && callBody.result !== undefined, JSON.stringify(callBody).slice(0, 200));

  // ── regression: the consent flow must not exist when OAuth is off ──────────
  section('Regression — no OAuth bypass in bearer mode');

  // The defect this guards against: the OAuth router used to be mounted in every mode. With
  // MCP_AUTH_MODE=bearer (the default) no passphrase is required, so the empty configured
  // passphrase matched the empty submitted one, and anyone who knew the URL could register
  // a client, approve it, mint a token and read/write the account.
  const bearerToken = 'static-token-for-smoke-test';
  const bearerConfig = {
    ...config,
    auth: { mode: 'bearer', tokens: [bearerToken], oauth: config.auth.oauth },
  };
  // Shares the main store on purpose, so a token minted while OAuth was enabled is visible
  // here — which is exactly the downgrade this test is about.
  const bearerProvider = new OAuthProvider({
    store,
    issuer: config.auth.oauth.issuer,
    resourceUrl: `${config.publicUrl}/mcp`,
    password: '',
    staticTokens: [bearerToken],
    oauthEnabled: false,
  });
  const bearerApp = createHttpApp({ config: bearerConfig, provider: bearerProvider, store });
  const bearerServer = createServer(bearerApp);
  await new Promise((resolve) => bearerServer.listen(0, '127.0.0.1', resolve));
  const bearerBase = `http://127.0.0.1:${bearerServer.address().port}`;

  try {
    check('an unset passphrase never authorizes anyone', bearerProvider.verifyPassword('') === false);
    check('a wrong passphrase does not authorize', bearerProvider.verifyPassword('guess') === false);

    const bearerAuthorize = await fetch(
      `${bearerBase}/oauth/authorize?response_type=code&client_id=anything&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
    );
    check('authorize endpoint is absent in bearer mode', bearerAuthorize.status === 404, String(bearerAuthorize.status));

    const bearerRegister = await fetch(`${bearerBase}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'attacker', redirect_uris: [CLAUDE_CALLBACK] }),
    });
    check('registration endpoint is absent in bearer mode', bearerRegister.status === 404, String(bearerRegister.status));

    const staleToken = await fetch(`${bearerBase}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${rotated.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    check('a token issued under OAuth is refused after switching to bearer', staleToken.status === 401, String(staleToken.status));

    const staticToken = await fetch(`${bearerBase}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } },
      }),
    });
    check('the configured static token still works', staticToken.status === 200, String(staticToken.status));
  } finally {
    await new Promise((resolve) => bearerServer.close(resolve));
  }

  // ── regression: guessing the passphrase is rate limited ────────────────────
  section('Regression — the consent screen is throttled');

  let sawTooMany = false;
  for (let attempt = 0; attempt < 25 && !sawTooMany; attempt += 1) {
    const guess = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery), password: `guess-${attempt}` }),
      redirect: 'manual',
    });
    if (guess.status === 429) sawTooMany = true;
    else if (guess.status !== 401) {
      check('a wrong passphrase is always rejected', false, `got ${guess.status}`);
      break;
    }
  }
  check('repeated passphrase guesses are throttled', sawTooMany);

  // ── pure helpers ───────────────────────────────────────────────────────────
  section('LaTeX log and structure parsing');

  const log = [
    'This is pdfTeX, Version 3.141592653',
    '(/usr/share/texlive/main.tex',
    'LaTeX Warning: Reference `fig:one\' on page 1 undefined on input line 42.',
    '! Undefined control sequence.',
    'l.57 \\badmacro',
    'Overfull \\hbox (12.0pt too wide) in paragraph at lines 10--12',
    'Output written on main.pdf (7 pages, 12345 bytes).',
  ].join('\n');
  const parsed = parseLatexLog(log);
  check('log: hard error detected', parsed.ok === false && parsed.errors.length === 1, JSON.stringify(parsed.errors));
  check('log: error carries its line number', parsed.errors[0]?.includes('line 57'), parsed.errors[0]);
  check('log: page count extracted', parsed.pages === 7, String(parsed.pages));
  check('log: undefined reference classified separately', parsed.missingReferences.length === 1);
  check('log: overfull box counted', parsed.overfull === 1, String(parsed.overfull));

  const tex = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction}',
    '\\label{sec:intro}',
    'See \\cite{knuth1984,lamport1994} for background. % \\section{commented out}',
    '\\subsection{Background}',
    '\\input{sections/methods}',
    '\\begin{equation}',
    'E = mc^2',
    '\\end{equation}',
    '\\todo{fix this claim}',
    '\\end{document}',
  ].join('\n');
  const summary = summarizeLatex(tex);
  check('tex: two headings found', summary.outline.length === 2, JSON.stringify(summary.outline.map((o) => o.title)));
  check('tex: heading titles parsed', summary.outline[0]?.title === 'Introduction', summary.outline[0]?.title);
  check('tex: commented-out heading ignored', !summary.outline.some((o) => o.title.includes('commented')));
  check('tex: labels collected', summary.labels.includes('sec:intro'));
  check('tex: includes collected', summary.includes.includes('sections/methods'));
  check('tex: multi-key citation counted', summary.citations === 2, String(summary.citations));
  check('tex: equation environment counted', summary.environments.equation === 1);
  check('tex: todo captured', summary.todos.length === 1, JSON.stringify(summary.todos));

  // ── path safety ────────────────────────────────────────────────────────────
  section('Path traversal is refused');

  const escapes = ['../secrets', '/etc/passwd', 'a/../../b', 'C:\\Windows\\system32', '..\\..\\x'];
  for (const candidate of escapes) {
    let threw = false;
    try {
      normalizeRelPath(candidate);
    } catch {
      threw = true;
    }
    check(`rejected: ${candidate}`, threw);
  }
  check('normal path accepted', normalizeRelPath('sections/intro.tex') === 'sections/intro.tex');
  check('redundant segments collapsed', normalizeRelPath('./a//b.tex') === 'a/b.tex');

  // ── the Overleaf mirror ────────────────────────────────────────────────────
  section('Mirror sync against a stubbed Overleaf');

  // The push/pull layer is where a mistake is most expensive: it decides which files
  // actually reach the user's paper. A fake client that records calls exercises the whole
  // path — zip extraction, change detection, upload/delete ordering — without an account.
  const zip = new AdmZip();
  zip.addFile('main.tex', Buffer.from('\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n'));
  zip.addFile('sections/intro.tex', Buffer.from('Intro text.\n'));
  zip.addFile('refs.bib', Buffer.from('@article{a, title={A}}\n'));

  const recorded = { uploaded: [], deleted: [], invalidated: 0 };
  const fakeClient = {
    downloadProject: async () => zip.toBuffer(),
    uploadFile: async (_projectId, _folderId, fileName, content) => {
      recorded.uploaded.push({ path: fileName, body: content.toString('utf8') });
      return { success: true };
    },
    deleteByPath: async (_projectId, path) => {
      recorded.deleted.push(path);
    },
    invalidateFolderTree: () => {
      recorded.invalidated += 1;
    },
  };

  const ws = new ProjectWorkspace(join(dataDir, 'projects'), 'proj123', 'Smoke Thesis', {
    maxFileBytes: 1024 * 1024,
  });
  const pulled = await ws.pull(fakeClient);
  check('pull extracts every zip entry', pulled.fileCount === 3, String(pulled.fileCount));
  check('pull lists the project files', ws.listFiles().join(',') === 'main.tex,refs.bib,sections/intro.tex', ws.listFiles().join(','));
  check('freshly pulled mirror has no pending changes', (await ws.changes()).length === 0);
  check('mirror is marked initialized', (await ws.isInitialized()) === true);

  await ws.write('main.tex', '\\documentclass{article}\n\\begin{document}\nNEW\n\\end{document}\n');
  await ws.write('sections/new.tex', 'A brand new file.\n');
  await ws.remove('refs.bib');

  const pending = await ws.changes();
  const byPath = Object.fromEntries(pending.map((c) => [c.path, c.status]));
  check('modified file detected', byPath['main.tex'] === 'modified', byPath['main.tex']);
  check('untracked new file detected as added', byPath['sections/new.tex'] === 'added', JSON.stringify(byPath));
  check('deleted file detected', byPath['refs.bib'] === 'deleted', byPath['refs.bib']);

  const pushOutcome = await ws.push(fakeClient);
  check('push uploads the modified file', recorded.uploaded.some((u) => u.path === 'main.tex'));
  check('push uploads the new file', recorded.uploaded.some((u) => u.path === 'sections/new.tex'));
  check('push uploaded the edited content', recorded.uploaded.find((u) => u.path === 'main.tex')?.body.includes('NEW'));
  check('push deletes the removed file', recorded.deleted.includes('refs.bib'));
  check('push reports no failures', pushOutcome.failed.length === 0, JSON.stringify(pushOutcome.failed));
  check('folder tree cache invalidated after push', recorded.invalidated === 1, String(recorded.invalidated));
  check('nothing pending after a successful push', (await ws.changes()).length === 0);

  // Commit granularity differs by mode, and `undo_last_edit` counts commits:
//   auto-publish on  → each tool call commits its own edit, so undo(1) reverses one edit
//   auto-publish off → edits accumulate until publish_changes, collapsing into one commit
// Here the writes were made directly against the workspace, so they collapse into the
// push — hence exactly two commits: the pull and the push.
  const history = await ws.history(10);
  check('history separates the pull from the push', history.length === 2, `${history.length} entries: ${history.map((h) => h.message).join(' | ')}`);
  check('history includes the pull', history.some((h) => h.message.startsWith('pull')));
  check('history includes the push', history.some((h) => h.message.startsWith('push to Overleaf')));

  // Undo reverses edits and previous undos, nothing else. A push is a sync marker, so the
  // most recent change here is not undoable and saying so is the correct behaviour.
  let refusedNonEdit = false;
  try {
    await ws.undo(1);
  } catch {
    refusedNonEdit = true;
  }
  check('undo refuses when the last change was not an edit', refusedNonEdit);

  await ws.write('main.tex', '\\documentclass{article}\n\\begin{document}\nEDIT MARKER\n\\end{document}\n');
  await ws.commit('edit: main.tex');
  check('the edit is in place', (await ws.read('main.tex')).includes('EDIT MARKER'));
  await ws.undo(1);
  check('undo reverses an edit', !(await ws.read('main.tex')).includes('EDIT MARKER'));
  // That edit was never published, so reversing it restores exactly the state Overleaf
  // already holds — there is correctly nothing left to send.
  check('undoing an unpublished edit leaves nothing pending', (await ws.changes()).length === 0);

  // Now leave genuine unpublished work, which the re-pull guard exists to protect.
  await ws.write('main.tex', '\\documentclass{article}\n\\begin{document}\nUNPUBLISHED WORK\n\\end{document}\n');
  await ws.commit('edit: main.tex unpublished work');
  check('unpublished work is pending', (await ws.changes()).length > 0);

  let refusedNonForce = false;
  try {
    await ws.pull(fakeClient);
  } catch {
    refusedNonForce = true;
  }
  check('re-pull refuses to discard unpublished edits', refusedNonForce);

  let acceptedForce = true;
  try {
    await ws.pull(fakeClient, { force: true });
  } catch {
    acceptedForce = false;
  }
  check('re-pull with force succeeds', acceptedForce);
  check('forced re-pull restores the original content', (await ws.read('main.tex')).includes('old'));

  // Reversing a reload would push a stale copy back over whatever the user has changed in
  // their browser since — silently, and reported as success.
  await ws.push(fakeClient);
  await ws.pull(fakeClient, { force: true });
  let refusedPullUndo = false;
  try {
    await ws.undo(1);
  } catch {
    refusedPullUndo = true;
  }
  check('undo refuses to reverse a reload from Overleaf', refusedPullUndo);

  // ── freshness before read/edit ─────────────────────────────────────────────
  section('Files are refreshed from Overleaf before being read or edited');

  // Simulates the user editing in their browser between tool calls. Without this refresh
  // the model would read stale text and then overwrite the user's change.
  let remoteMain = '\\documentclass{article}\n\\begin{document}\nedited in the browser\n\\end{document}\n';
  fakeClient.downloadByPath = async () => Buffer.from(remoteMain);

  const didRefresh = await ws.refreshFileFromRemote(fakeClient, 'main.tex');
  check('refresh reports a change', didRefresh === true);
  check('mirror now holds the remote text', (await ws.read('main.tex')).includes('edited in the browser'));
  check('refresh leaves nothing pending (baseline moved with it)', (await ws.changes()).length === 0);
  check('refreshing unchanged content is a no-op', (await ws.refreshFileFromRemote(fakeClient, 'main.tex')) === false);

  await ws.write('main.tex', '\\documentclass{article}\n\\begin{document}\nlocal unpublished edit\n\\end{document}\n');
  remoteMain = '\\documentclass{article}\n\\begin{document}\nsomeone else changed this\n\\end{document}\n';
  const blocked = await ws.refreshFileFromRemote(fakeClient, 'main.tex');
  check('refresh refuses while local edits are unpublished', blocked === false);
  check('unpublished local edit survives the blocked refresh', (await ws.read('main.tex')).includes('local unpublished edit'));

  fakeClient.downloadByPath = async () => {
    throw new Error('404 not found');
  };
  await ws.push(fakeClient);
  check('refresh tolerates a file that is not on Overleaf', (await ws.refreshFileFromRemote(fakeClient, 'main.tex')) === false);

  // ── regression: a read-only connection cannot write through compile ────────
  section('Regression — read-only connections cannot write');

  // `compile` publishes pending changes before compiling, which makes it a mutating path.
  // It used to be the one write path with no read-only check, so it could upload — and,
  // with a stale mirror, delete — files from a connection granted no write access.
  const uploadsBefore = recorded.uploaded.length;
  const deletionsBefore = recorded.deleted.length;

  await ws.write('main.tex', '\\documentclass{article}\n\\begin{document}\nneeds publishing\n\\end{document}\n');
  await ws.commit('edit: main.tex');
  check('there is something pending to publish', (await ws.changes()).length > 0);

  const readOnlyCtx = {
    config: { ...config, autoPush: true, readOnly: false },
    readOnly: true,
    session: { run: (fn) => fn(fakeClient) },
    registry: { resolve: async () => ({ id: 'proj123', name: 'Smoke Thesis' }) },
    workspaces: { for: () => ws },
  };

  const compileTool = buildTools.find((tool) => tool.name === 'compile');
  let compileRefused = false;
  try {
    await compileTool.run(readOnlyCtx, {});
  } catch {
    compileRefused = true;
  }
  check('compile refuses to publish for a read-only connection', compileRefused);
  check('compile uploaded nothing for a read-only connection', recorded.uploaded.length === uploadsBefore, `${recorded.uploaded.length - uploadsBefore} upload(s)`);
  check('compile deleted nothing for a read-only connection', recorded.deleted.length === deletionsBefore, `${recorded.deleted.length - deletionsBefore} delete(s)`);

  // ── regression: a push may not empty the project ───────────────────────────
  section('Regression — a push will not empty the project');

  // An empty mirror is the signature of a failed download or a damaged repository, not of
  // intent, and it is the state that turns a bug into a deleted thesis.
  await ws.push(fakeClient);
  for (const file of ws.listFiles()) await ws.remove(file);
  check('every file is staged for deletion', (await ws.changes()).filter((c) => c.status === 'deleted').length === 3, JSON.stringify(await ws.changes()));

  let refusedMassDelete = false;
  try {
    await ws.push(fakeClient);
  } catch {
    refusedMassDelete = true;
  }
  check('push refuses to delete every file in the project', refusedMassDelete);
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) {
  process.stdout.write(`${failures} FAILED\n`);
  process.exit(1);
}
process.stdout.write('smoke test passed\n');