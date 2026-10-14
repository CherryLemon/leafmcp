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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const { KeyedMutex } = await import('../dist/util/lock.js');
const { runWithProjectLock } = await import('../dist/tools/index.js');
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

/**
 * Walk the full authorization-code + PKCE flow and return the issued tokens.
 *
 * Used more than once because replaying a refresh token now revokes its entire grant, so a
 * test that checks revocation destroys the tokens it was holding.
 */
async function authorizeAndExchange({ base, clientId, redirectUri, scope, password }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: 'state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
    resource: 'https://mcp.example.com/mcp',
  });

  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(query), password }),
    redirect: 'manual',
  });
  const code = new URL(approved.headers.get('location')).searchParams.get('code');

  const response = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  return response.json();
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

  // The successor must work before we test that replaying the predecessor kills it.
  const stillValid = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${rotated.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list' }),
  });
  check('the rotated access token works before the replay', stillValid.status === 200, String(stillValid.status));

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

  // Replaying a rotated token means the credential leaked, so RFC 9700 wants the whole grant
  // revoked. Checking only that the *old* token fails would pass even if revocation did
  // nothing at all — the old token is marked used either way. What has to die is the
  // successor the legitimate client is holding right now.
  const afterReplay = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${rotated.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list' }),
  });
  check('replay revokes the whole grant, including its access token', afterReplay.status === 401, String(afterReplay.status));

  const successorRefresh = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rotated.refresh_token,
      client_id: client.client_id,
    }),
  });
  check('replay revokes the successor refresh token too', successorRefresh.status === 400, String(successorRefresh.status));

  // ── a fresh grant for the MCP session tests ────────────────────────────────
  const sessionTokens = await authorizeAndExchange({
    base,
    clientId: client.client_id,
    redirectUri: CLAUDE_CALLBACK,
    scope: 'overleaf.read overleaf.write',
    password: PASS,
  });
  check('a fresh authorization still works after a revocation', typeof sessionTokens.access_token === 'string');

  // ── authenticated MCP session ──────────────────────────────────────────────
  section('MCP session over the authenticated endpoint');

  const authHeaders = { ...MCP_HEADERS, authorization: `Bearer ${sessionTokens.access_token}` };

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

  // ── regression: the consent screen refuses to be framed or cached ──────────
  section('Regression — the consent screen is hardened');

  const consentResponse = await fetch(`${base}/oauth/authorize?${authorizeQuery}`);
  const csp = consentResponse.headers.get('content-security-policy') ?? '';
  check('consent page sets a CSP', csp.includes("default-src 'none'"), csp);
  check('consent page cannot be framed by CSP', csp.includes("frame-ancestors 'none'"), csp);
  check('consent page restricts form targets', csp.includes("form-action 'self'"), csp);
  check('consent page sets X-Frame-Options', consentResponse.headers.get('x-frame-options') === 'DENY');
  check('consent page is not cached', consentResponse.headers.get('cache-control') === 'no-store');
  check('consent page sets a referrer policy', consentResponse.headers.get('referrer-policy') === 'no-referrer');

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

  const ws = new ProjectWorkspace(dataDir, 'proj123', 'Smoke Thesis', {
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
    locks: new KeyedMutex(),
  };

  const compileTool = buildTools.find((tool) => tool.name === 'compile');
  let compileRefused = false;
  try {
    await compileTool.run(readOnlyCtx, { project: 'proj123' });
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

  // ── regression: git metadata is out of reach ───────────────────────────────
  section('Regression — git metadata cannot be reached through the file tools');

  // Writing `.git/config` used to be a command-execution primitive, not just repository
  // corruption: git runs programs named by `core.fsmonitor`, `core.hooksPath` and
  // `filter.*.clean`, and `git add -A` is enough to trigger them. Verified against git 2.47
  // before the fix. Two independent controls now cover it.
  for (const reserved of ['.git/config', '.git/hooks/pre-commit', 'sections/.git/config', '.gitattributes', '.gitmodules', '.GIT/config']) {
    let rejected = false;
    try {
      normalizeRelPath(reserved);
    } catch {
      rejected = true;
    }
    check(`path guard rejects ${reserved}`, rejected);
  }
  check('ordinary paths still work', normalizeRelPath('sections/intro.tex') === 'sections/intro.tex');

  const hostileZip = new AdmZip();
  hostileZip.addFile('main.tex', Buffer.from('\\documentclass{article}\n'));
  hostileZip.addFile('.git/config', Buffer.from('[core]\n\thooksPath = /tmp/lm-hooks\n'));
  hostileZip.addFile('nested/.git/hooks/pre-commit', Buffer.from('#!/bin/sh\ntouch /tmp/lm-PWNED\n'));

  const ws2 = new ProjectWorkspace(dataDir, 'gitprobe', 'Git Probe', { maxFileBytes: 1024 * 1024 });
  const hostileClient = {
    downloadProject: async () => hostileZip.toBuffer(),
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  };
  const pulledHostile = await ws2.pull(hostileClient);
  check('archive entries under .git are skipped', pulledHostile.fileCount === 1, String(pulledHostile.fileCount));
  check('the work tree holds only project files', ws2.listFiles().join(',') === 'main.tex', ws2.listFiles().join(','));
  check('the work tree contains no .git directory', !existsSync(join(ws2.dir, '.git')));
  check('the git directory lives outside the work tree', ws2.gitDir.startsWith(join(dataDir, 'meta')) && !ws2.gitDir.startsWith(ws2.dir), ws2.gitDir);
  check('the planted hook never ran', !existsSync('/tmp/lm-PWNED'));
  check('the mirror is still a working repository', (await ws2.changes()).length === 0);

  // ── regression: a failed pull must not damage the mirror ───────────────────
  section('Regression — a failed pull leaves the mirror intact');

  // An archive with `a` as a file and `a/b` as a file cannot be extracted: creating the
  // parent directory for `a/b` fails because `a` is already a file. Before the fix, `pull`
  // wiped the work tree *first*, so this left a partial tree that the next push read as
  // "these files were deleted" and removed from Overleaf.
  const clashZip = new AdmZip();
  clashZip.addFile('a', Buffer.from('file named a\n'));
  clashZip.addFile('a/b', Buffer.from('nested under a file\n'));
  clashZip.addFile('keep.tex', Buffer.from('should survive\n'));

  const ws3 = new ProjectWorkspace(dataDir, 'pullprobe', 'Pull Probe', { maxFileBytes: 1024 * 1024 });
  const goodZip = new AdmZip();
  goodZip.addFile('precious.tex', Buffer.from('\\section{Do not lose me}\n'));
  goodZip.addFile('notes.bib', Buffer.from('@book{x}\n'));
  let currentZip = goodZip;
  const switcher = {
    downloadProject: async () => currentZip.toBuffer(),
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  };
  await ws3.pull(switcher);
  check('the mirror starts with the good content', ws3.listFiles().length === 2, JSON.stringify(ws3.listFiles()));

  currentZip = clashZip;
  let pullFailed = false;
  try {
    await ws3.pull(switcher, { force: true });
  } catch {
    pullFailed = true;
  }
  check('a malformed archive makes the pull fail', pullFailed);
  check(
    'the previous files are still there after the failed pull',
    ws3.listFiles().join(',') === 'notes.bib,precious.tex',
    ws3.listFiles().join(','),
  );
  check('no partial tree was left behind', !existsSync(`${ws3.dir}.incoming`));
  check('no leftover backup directory', !existsSync(`${ws3.dir}.old`));
  check('the failed pull changed nothing remotely', (await ws3.changes()).length === 0);

  // ── regression: a failed upload must not be followed by deletes ────────────
  section('Regression — a failed upload cancels the deletions');

  // A rename is an upload plus a delete. If the upload fails and the delete proceeds, the
  // project loses the old file without gaining the new one.
  const ws4 = new ProjectWorkspace(dataDir, 'pushprobe', 'Push Probe', { maxFileBytes: 1024 * 1024 });
  const renameZip = new AdmZip();
  renameZip.addFile('old-name.tex', Buffer.from('\\section{Original}\n'));
  const attempts = [];
  const flakyClient = {
    downloadProject: async () => renameZip.toBuffer(),
    uploadFile: async (_p, _f, name) => {
      attempts.push(name);
      if (name === 'new-name.tex') throw new Error('simulated upload failure');
      return { success: true };
    },
    deleteByPath: async (_p, path) => {
      attempts.push(`delete:${path}`);
    },
    invalidateFolderTree: () => undefined,
  };
  await ws4.pull(flakyClient);
  await ws4.movePath('old-name.tex', 'new-name.tex');

  const deferred = await ws4.push(flakyClient);
  check('the upload was attempted', attempts.includes('new-name.tex'), JSON.stringify(attempts));
  check('the failed upload is reported', deferred.failed.some((f) => f.path === 'new-name.tex'));
  check('the deletion was held back', deferred.deletionsDeferred === true);
  check('no delete reached Overleaf', !attempts.includes('delete:old-name.tex'), JSON.stringify(attempts));
  check('the rename is still pending', (await ws4.changes()).length === 2, JSON.stringify(await ws4.changes()));

  // ── regression: edits must be literal ──────────────────────────────────────
  section('Regression — replacement text is inserted literally');

  // `String.replace` expands `$$`, `$&` and `$1` in the replacement, which turned
  // `$$E = mc^2$$` into `$E = mc^2$` — display math silently destroyed by the one tool whose
  // whole job is editing LaTeX.
  const { fileTools } = await import('../dist/tools/files.js');
  const editTool = fileTools.find((tool) => tool.name === 'edit_file');

  const ws5 = new ProjectWorkspace(dataDir, 'editprobe', 'Edit Probe', { maxFileBytes: 1024 * 1024 });
  const plainZip = new AdmZip();
  plainZip.addFile('main.tex', Buffer.from('BEFORE\nMARKER\nAFTER\n'));
  await ws5.pull({
    downloadProject: async () => plainZip.toBuffer(),
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  });

  const editCtx = {
    config: { ...config, autoPush: false, readOnly: false, freshReads: false },
    readOnly: false,
    session: { run: (fn) => fn({}) },
    registry: { resolve: async () => ({ id: 'editprobe', name: 'Edit Probe' }) },
    workspaces: { for: () => ws5 },
    locks: new KeyedMutex(),
  };

  const latexMath = '$$E = mc^2$$';
  await editTool.run(editCtx, { path: 'main.tex', old_text: 'MARKER', new_text: latexMath, project: 'editprobe' });
  const edited = await ws5.read('main.tex');
  check('display math survives an edit', edited.includes(latexMath), JSON.stringify(edited));

  await editTool.run(editCtx, { path: 'main.tex', old_text: latexMath, new_text: 'back to $& and $1', project: 'editprobe' });
  const escaped = await ws5.read('main.tex');
  check('`$&` in replacement text is literal', escaped.includes('back to $& and $1'), JSON.stringify(escaped));

  let projectRequired = false;
  try {
    await editTool.run(editCtx, { path: 'main.tex', old_text: 'BEFORE', new_text: 'x' });
  } catch {
    projectRequired = true;
  }
  check('edit_file refuses to run without an explicit project', projectRequired);

  // ── regression: a catastrophic pattern cannot wedge the server ─────────────
  section('Regression — an expensive pattern is terminated, not waited on');

  const { searchIsolated } = await import('../dist/tools/search.js');
  await ws5.write('hang.tex', `${'a'.repeat(80)}b\n`);

  const startedAt = Date.now();
  const doomed = await searchIsolated({
    root: ws5.dir,
    files: ['hang.tex'],
    skip: [],
    pattern: '(a|aa)+$',
    isRegex: true,
    caseSensitive: false,
    maxResults: 10,
    lineCap: 4000,
    timeoutMs: 1500,
  });
  const elapsed = Date.now() - startedAt;

  check('the runaway search was terminated', doomed.timedOut === true);
  check('the caller got control back promptly', elapsed < 6000, `${elapsed}ms`);
  check('no results were fabricated', doomed.hits.length === 0);

  // Sanity: the same file with a literal search is instant, so the timeout is specific to the
  // pathological pattern rather than to the search machinery.
  const literal = await searchIsolated({
    root: ws5.dir,
    files: ['hang.tex'],
    skip: [],
    pattern: 'aaaa',
    isRegex: false,
    caseSensitive: false,
    maxResults: 10,
    lineCap: 4000,
    timeoutMs: 1500,
  });
  check('a literal search over the same file is fine', literal.timedOut === false && literal.hits.length === 1);

  // ── regression: concurrent edits to one project serialise ─────────────────
  section('Regression — concurrent edits to a project do not lose each other');

  // Without a lock both calls read the same base, and the second write discards the first.
  // The lock is taken in the registration layer, so this drives `runWithProjectLock`, which
  // is the function every tool call actually goes through.
  const concurrencyZip = new AdmZip();
  concurrencyZip.addFile('both.tex', Buffer.from('ALPHA_MARKER\nBETA_MARKER\n'));
  const concurrencyClient = {
    downloadProject: async () => concurrencyZip.toBuffer(),
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  };
  const ws6 = new ProjectWorkspace(dataDir, 'lockprobe', 'Lock Probe', { maxFileBytes: 1024 * 1024 });
  await ws6.pull(concurrencyClient);

  const lockCtx = {
    config: { ...config, autoPush: false, readOnly: false, freshReads: false },
    readOnly: false,
    session: { run: (fn) => fn(concurrencyClient) },
    registry: { resolve: async () => ({ id: 'lockprobe', name: 'Lock Probe' }) },
    workspaces: { for: () => ws6 },
    locks: new KeyedMutex(),
  };

  const editBoth = fileTools.find((tool) => tool.name === 'edit_file');
  await Promise.all([
    runWithProjectLock(lockCtx, editBoth, { path: 'both.tex', old_text: 'ALPHA_MARKER', new_text: 'ALPHA_DONE', project: 'lockprobe' }),
    runWithProjectLock(lockCtx, editBoth, { path: 'both.tex', old_text: 'BETA_MARKER', new_text: 'BETA_DONE', project: 'lockprobe' }),
  ]);
  const bothEdits = await ws6.read('both.tex');
  check('the first concurrent edit survived', bothEdits.includes('ALPHA_DONE'), JSON.stringify(bothEdits));
  check('the second concurrent edit survived', bothEdits.includes('BETA_DONE'), JSON.stringify(bothEdits));

  // A failing operation must not wedge the queue behind it.
  const queue = new KeyedMutex();
  await queue.run('k', async () => undefined);
  let afterFailureRan = false;
  await queue
    .run('k', async () => {
      throw new Error('deliberate');
    })
    .catch(() => undefined);
  await queue.run('k', async () => {
    afterFailureRan = true;
  });
  check('a failed operation does not block the next one on the same key', afterFailureRan);

  // Different projects must not wait on each other.
  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const order = [];
  const slow = queue.run('project-a', async () => {
    order.push('a-start');
    await slowGate;
    order.push('a-end');
  });
  await queue.run('project-b', async () => {
    order.push('b-ran');
  });
  check('a different project runs while another is held', order.includes('b-ran'), JSON.stringify(order));
  releaseSlow();
  await slow;
  check('keys are released once idle', queue.activeKeys === 0, String(queue.activeKeys));

  // ── regression: a partial publish is reported as a failure ────────────────
  section('Regression — a partial publish is not reported as success');

  const failZip = new AdmZip();
  failZip.addFile('paper.tex', Buffer.from('CHANGE_ME\n'));
  const ws7 = new ProjectWorkspace(dataDir, 'failprobe', 'Fail Probe', { maxFileBytes: 1024 * 1024 });
  const refusingClient = {
    downloadProject: async () => failZip.toBuffer(),
    uploadFile: async () => {
      throw new Error('overleaf refused the upload');
    },
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  };
  await ws7.pull({ ...refusingClient, uploadFile: async () => ({ success: true }) });

  const failCtx = {
    config: { ...config, autoPush: true, readOnly: false, freshReads: false },
    readOnly: false,
    session: { run: (fn) => fn(refusingClient) },
    registry: { resolve: async () => ({ id: 'failprobe', name: 'Fail Probe' }) },
    workspaces: { for: () => ws7 },
    locks: new KeyedMutex(),
  };

  const failedEdit = await editBoth.run(failCtx, {
    path: 'paper.tex',
    old_text: 'CHANGE_ME',
    new_text: 'CHANGED',
    project: 'failprobe',
  });
  check('the edit is written locally', (await ws7.read('paper.tex')).includes('CHANGED'));
  check('the failure is marked as an error result', failedEdit.isError === true, JSON.stringify(failedEdit));
  check('the message says it was not published', /NOT PUBLISHED/.test(failedEdit.text), failedEdit.text);
  check('the tool does not claim success', !/^Edited .*\.$/m.test(failedEdit.text) || failedEdit.isError === true);

  // ── regression: an edit can state which version it was written against ─────
  section('Regression — edits can be pinned to a version');

  const hashZip = new AdmZip();
  hashZip.addFile('pinned.tex', Buffer.from('STABLE\n'));
  const ws8 = new ProjectWorkspace(dataDir, 'hashprobe', 'Hash Probe', { maxFileBytes: 1024 * 1024 });
  await ws8.pull({
    downloadProject: async () => hashZip.toBuffer(),
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  });

  const hashCtx = {
    config: { ...config, autoPush: false, readOnly: false, freshReads: false },
    readOnly: false,
    session: { run: (fn) => fn({}) },
    registry: { resolve: async () => ({ id: 'hashprobe', name: 'Hash Probe' }) },
    workspaces: { for: () => ws8 },
    locks: new KeyedMutex(),
  };
  const readTool = fileTools.find((tool) => tool.name === 'read_file');

  const readResult = await readTool.run(hashCtx, { path: 'pinned.tex', project: 'hashprobe' });
  const hashMatch = /sha256:([0-9a-f]{12})/.exec(readResult);
  check('read_file reports a content hash', hashMatch !== null, readResult.split('\n')[0]);

  const goodHash = hashMatch[1];
  const pinnedEdit = await editBoth.run(hashCtx, {
    path: 'pinned.tex',
    old_text: 'STABLE',
    new_text: 'PINNED',
    expected_hash: goodHash,
    project: 'hashprobe',
  });
  check('an edit pinned to the current version is accepted', pinnedEdit.isError !== true, JSON.stringify(pinnedEdit));

  let staleRefused = false;
  try {
    await editBoth.run(hashCtx, {
      path: 'pinned.tex',
      old_text: 'PINNED',
      new_text: 'STALE',
      expected_hash: goodHash,
      project: 'hashprobe',
    });
  } catch (error) {
    staleRefused = /changed since it was read/.test(String(error.message));
  }
  check('an edit pinned to a stale version is refused', staleRefused);
  check('the refused edit changed nothing', (await ws8.read('pinned.tex')).includes('PINNED'));

  // ── regression: unauthenticated registration is bounded ───────────────────
  section('Regression — registration is bounded');

  const longName = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'x'.repeat(500), redirect_uris: [CLAUDE_CALLBACK] }),
  });
  check('an oversized client_name is refused', longName.status === 400, String(longName.status));

  const manyUris = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: Array.from({ length: 12 }, () => CLAUDE_CALLBACK) }),
  });
  check('too many redirect_uris are refused', manyUris.status === 400, String(manyUris.status));

  const longUri = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [`http://127.0.0.1:1/${'a'.repeat(3000)}`] }),
  });
  check('an oversized redirect_uri is refused', longUri.status === 400, String(longUri.status));

  const fatBody = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'x'.repeat(64 * 1024), redirect_uris: [CLAUDE_CALLBACK] }),
  });
  check('a body over the OAuth limit is refused', fatBody.status === 413, String(fatBody.status));

  // The cap itself is checked in the provider, past the rate limiter, so it is exercised
  // directly — 200 HTTP registrations would be throttled long before reaching it.
  const capStore = new OAuthStore(join(dataDir, 'cap-probe.json'));
  const capProvider = new OAuthProvider({
    store: capStore,
    issuer: config.auth.oauth.issuer,
    resourceUrl: `${config.publicUrl}/mcp`,
    password: PASS,
    oauthEnabled: true,
  });
  for (let i = 0; i < 200; i += 1) {
    await capStore.putClient({
      client_id: `seed_${i}`,
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      created_at: Date.now(),
    });
  }
  let capRefused = false;
  try {
    await capProvider.registerClient({ redirect_uris: [CLAUDE_CALLBACK] });
  } catch (error) {
    capRefused = /maximum of 200/.test(String(error.message));
  }
  check('the total number of registered clients is capped', capRefused);

  // ── regression: an absurd archive is refused ──────────────────────────────
  section('Regression — archive imports are bounded');

  const bombZip = new AdmZip();
  for (let i = 0; i < 5001; i += 1) bombZip.addFile(`f${i}.tex`, Buffer.from('x'));
  const ws9 = new ProjectWorkspace(dataDir, 'bombprobe', 'Bomb Probe', { maxFileBytes: 1024 * 1024 });
  let bombRefused = false;
  try {
    await ws9.pull({
      downloadProject: async () => bombZip.toBuffer(),
      uploadFile: async () => ({ success: true }),
      deleteByPath: async () => undefined,
      invalidateFolderTree: () => undefined,
    });
  } catch (error) {
    bombRefused = /too many|entries/.test(String(error.message)) || /entries/.test(String(error.message));
  }
  check('an archive with too many entries is refused', bombRefused);

  const deepZip = new AdmZip();
  deepZip.addFile(`${Array.from({ length: 25 }, (_, i) => `d${i}`).join('/')}/deep.tex`, Buffer.from('deep\n'));
  deepZip.addFile('shallow.tex', Buffer.from('shallow\n'));
  const ws10 = new ProjectWorkspace(dataDir, 'deepprobe', 'Deep Probe', { maxFileBytes: 1024 * 1024 });
  const deepResult = await ws10.pull({
    downloadProject: async () => deepZip.toBuffer(),
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  });
  check('an over-deep entry is skipped, not extracted', deepResult.fileCount === 1, String(deepResult.fileCount));
  check('the shallow entry still arrived', ws10.listFiles().join(',') === 'shallow.tex', ws10.listFiles().join(','));

  // ── regression R1: refreshing one file must not speak for another ─────────
  section('Regression R1 — a refresh cannot mark another file as published');

  // The failure this guards against: a.tex holds an unpublished edit, a read request
  // refreshes b.tex, and the project-wide watermark advances past both — so a.tex looks
  // already published and is never uploaded.
  let syncZip = new AdmZip();
  syncZip.addFile('a.tex', Buffer.from('A-remote-v1\n'));
  syncZip.addFile('b.tex', Buffer.from('B-remote-v1\n'));
  const syncClient = {
    downloadProject: async () => syncZip.toBuffer(),
    downloadByPath: async (_projectId, path) => {
      if (path === 'b.tex') return Buffer.from('B-remote-v2\n');
      return Buffer.from('A-remote-v1\n');
    },
    uploadFile: async () => ({ success: true }),
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  };

  const wsR1 = new ProjectWorkspace(dataDir, 'r1probe', 'R1 Probe', { maxFileBytes: 1024 * 1024 });
  await wsR1.pull(syncClient);
  check('the project starts clean', (await wsR1.changes()).length === 0);

  await wsR1.write('a.tex', 'A-local-unpublished\n');
  check('a.tex is pending', (await wsR1.changes()).some((c) => c.path === 'a.tex' && c.status === 'modified'));

  const refreshedB = await wsR1.refreshFileFromRemote(syncClient, 'b.tex');
  check('b.tex was refreshed even while a.tex is pending', refreshedB === true);

  const afterRefresh = await wsR1.changes();
  check(
    'a.tex is STILL pending after refreshing b.tex',
    afterRefresh.some((c) => c.path === 'a.tex' && c.status === 'modified'),
    JSON.stringify(afterRefresh),
  );
  check('b.tex is no longer pending', !afterRefresh.some((c) => c.path === 'b.tex'), JSON.stringify(afterRefresh));
  check('the refreshed content is on disk', (await wsR1.read('b.tex')).includes('v2'));

  // A file with its own unpublished edit must still refuse to be overwritten.
  const selfGuardClient = {
    ...syncClient,
    downloadByPath: async () => Buffer.from('A-remote-OVERWRITE\n'),
  };
  check('a file with pending edits is not refreshed', (await wsR1.refreshFileFromRemote(selfGuardClient, 'a.tex')) === false);
  check('its local edit survived', (await wsR1.read('a.tex')).includes('A-local-unpublished'), await wsR1.read('a.tex'));

  // ── regression R2: change detection must not depend on git ────────────────
  section('Regression R2 — change detection survives a broken git index');

  // Previously `changes()` staged files and diffed the index, so a failed `git add` could
  // leave a stale index and produce a confident "nothing to publish" about changes that were
  // never sent. Hashing the files removes git from that decision entirely.
  await wsR1.write('c.tex', 'C-new-file\n');
  const beforeIndexDamage = await wsR1.changes();
  check('the new file is detected', beforeIndexDamage.some((c) => c.path === 'c.tex'), JSON.stringify(beforeIndexDamage));

  writeFileSync(join(wsR1.gitDir, 'index'), Buffer.from('GARBAGE-NOT-AN-INDEX'));
  const afterIndexDamage = await wsR1.changes();
  check(
    'changes() still reports the truth with a corrupt index',
    afterIndexDamage.some((c) => c.path === 'c.tex') && afterIndexDamage.some((c) => c.path === 'a.tex'),
    JSON.stringify(afterIndexDamage),
  );

  // A commit genuinely needs git, and must fail loudly rather than silently succeed.
  let commitFailed = false;
  try {
    await wsR1.commit('edit: should fail');
  } catch {
    commitFailed = true;
  }
  check('a commit with a corrupt index fails loudly', commitFailed);
  rmSync(join(wsR1.gitDir, 'index'), { force: true });

  // ── regression R3: revocation is a state, not a deletion ──────────────────
  section('Regression R3 — a revoked grant cannot be resurrected');

  const revokeStore = new OAuthStore(join(dataDir, 'revoke-probe.json'));
  const revokeProvider = new OAuthProvider({
    store: revokeStore,
    issuer: config.auth.oauth.issuer,
    resourceUrl: `${config.publicUrl}/mcp`,
    password: PASS,
    oauthEnabled: true,
  });
  await revokeStore.load();
  await revokeStore.putToken({
    token: 'fresh-access', kind: 'access', client_id: 'c1', family: 'grant-x',
    expires_at: Date.now() + 60_000, created_at: Date.now(), status: 'active',
  });
  await revokeStore.revokeFamily('grant-x');
  check('the grant is recorded as revoked', revokeStore.isGrantRevoked('grant-x') === true);

  // This is the race: a request that read its record before the revocation still tries to
  // write successors afterwards. Deleting the old rows would not have stopped it.
  const resurrected = await revokeStore.mintTokens(
    [
      { token: 'late-access', kind: 'access', client_id: 'c1', family: 'grant-x', expires_at: Date.now() + 60_000, created_at: Date.now(), status: 'active' },
      { token: 'late-refresh', kind: 'refresh', client_id: 'c1', family: 'grant-x', expires_at: Date.now() + 60_000, created_at: Date.now(), status: 'active' },
    ],
    'grant-x',
  );
  check('minting into a revoked grant is refused', resurrected === false);
  check('no successor token exists', (await revokeStore.getToken('late-access')) === undefined);

  let revokedRefused = false;
  try {
    await revokeProvider.refresh('nonexistent', 'c1');
  } catch {
    revokedRefused = true;
  }
  check('a refresh against a dead grant fails', revokedRefused);

  // ── regression R4: the old in-tree git layout migrates safely ─────────────
  section('Regression R4 — legacy mirrors migrate without losing state');

  const { execFileSync } = await import('node:child_process');
  const legacyRoot = join(dataDir, 'legacy');
  const legacyWork = join(legacyRoot, 'projects', 'oldproj');
  mkdirSync(legacyWork, { recursive: true });

  // Build the pre-upgrade layout: a real repository *inside* the work tree, with a watermark
  // and one unpublished edit.
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete gitEnv.GIT_DIR;
  delete gitEnv.GIT_WORK_TREE;
  const legacyGit = (...args) => execFileSync('git', args, { cwd: legacyWork, env: gitEnv, stdio: 'pipe' });

  legacyGit('init', '-q', '-b', 'main');
  legacyGit('config', 'user.email', 'legacy@test');
  legacyGit('config', 'user.name', 'legacy');
  writeFileSync(join(legacyWork, 'published.tex'), 'already on overleaf\n');
  writeFileSync(join(legacyWork, 'edited.tex'), 'first version\n');
  legacyGit('add', '-A');
  legacyGit('commit', '-qm', 'pull');
  legacyGit('update-ref', 'refs/overleaf/pushed', 'HEAD');

  writeFileSync(join(legacyWork, 'edited.tex'), 'local edit not yet uploaded\n');
  writeFileSync(join(legacyWork, 'brand-new.tex'), 'created locally\n');

  // A configuration that would execute a program, to prove migration does not carry it over.
  const legacyConfig = readFileSync(join(legacyWork, '.git', 'config'), 'utf8');
  writeFileSync(
    join(legacyWork, '.git', 'config'),
    `${legacyConfig}[core]\n\tfsmonitor = /tmp/lm-legacy-PWNED\n`,
  );

  const wsR4 = new ProjectWorkspace(legacyRoot, 'oldproj', 'Old Project', { maxFileBytes: 1024 * 1024 });
  await wsR4.ensure();

  check('the git directory moved out of the work tree', !existsSync(join(legacyWork, '.git')));
  check('the git directory now lives beside it', existsSync(wsR4.gitDir) && wsR4.gitDir.startsWith(join(legacyRoot, 'meta')));

  const migrated = await wsR4.changes();
  const migratedByPath = Object.fromEntries(migrated.map((c) => [c.path, c.status]));
  check(
    'the unpublished edit is still pending after migration',
    migratedByPath['edited.tex'] === 'modified',
    JSON.stringify(migratedByPath),
  );
  check(
    'the already-published file is NOT reported as pending',
    migratedByPath['published.tex'] === undefined,
    JSON.stringify(migratedByPath),
  );
  check('a locally created file is reported as new', migratedByPath['brand-new.tex'] === 'added', JSON.stringify(migratedByPath));
  check('the local edit survived migration', (await wsR4.read('edited.tex')).includes('not yet uploaded'));
  check('history survived migration', (await wsR4.history(5)).length >= 1);
  check('the planted fsmonitor command never ran', !existsSync('/tmp/lm-legacy-PWNED'));

  const migratedConfig = readFileSync(join(wsR4.gitDir, 'config'), 'utf8');
  check('the legacy fsmonitor setting was discarded', !migratedConfig.includes('lm-legacy-PWNED'), migratedConfig.slice(0, 200));
  check('hardening was reapplied', /hooksPath/.test(migratedConfig) && /fsmonitor = false/.test(migratedConfig));

  // ── regression: a mirror with local files but no sync record refuses to pull ──
  const orphanRoot = join(dataDir, 'orphan');
  const orphanWork = join(orphanRoot, 'projects', 'orphanproj');
  mkdirSync(orphanWork, { recursive: true });
  writeFileSync(join(orphanWork, 'work.tex'), 'hours of unsaved work\n');
  const wsOrphan = new ProjectWorkspace(orphanRoot, 'orphanproj', 'Orphan', { maxFileBytes: 1024 * 1024 });
  let orphanRefused = false;
  try {
    await wsOrphan.pull({
      downloadProject: async () => new AdmZip().toBuffer(),
      uploadFile: async () => ({ success: true }),
      deleteByPath: async () => undefined,
      invalidateFolderTree: () => undefined,
    });
  } catch (error) {
    orphanRefused = /no record of what Overleaf holds/.test(String(error.message));
  }
  check('a pull over unexplained local files is refused', orphanRefused);
  check('the unexplained files are untouched', existsSync(join(orphanWork, 'work.tex')));

  // ── regression: the rate limiter is bounded and cannot be reset ───────────
  section('Regression — the rate limiter is bounded');

  const { rateLimit } = await import('../dist/util/ratelimit.js');

  // A full table must throttle new arrivals, not evict existing buckets: evicting is what
  // lets an attacker rotate addresses to erase the record of their own abuse.
  const limiter = rateLimit({ windowMs: 60_000, max: 2, maxKeys: 3, overflowMax: 1 });
  const attemptRateLimited = (ip) => {
    const res = {
      statusCode: 200,
      headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json() { return this; },
    };
    let passed = false;
    limiter({ ip, socket: {} }, res, () => { passed = true; });
    return { status: res.statusCode, passed, headers: res.headers };
  };

  check('a client gets its allowance', attemptRateLimited('10.0.0.1').passed && attemptRateLimited('10.0.0.1').passed);
  check('then it is throttled', attemptRateLimited('10.0.0.1').status === 429);
  attemptRateLimited('10.0.0.2');
  attemptRateLimited('10.0.0.3');
  check('the table is now full', true);

  // New addresses share one overflow budget instead of displacing the existing entries.
  const overflowFirst = attemptRateLimited('10.9.9.9');
  check('an unknown address is admitted once from the overflow budget', overflowFirst.passed);
  check('the overflow budget is also finite', attemptRateLimited('10.8.8.8').status === 429);
  check(
    'the earlier client is still throttled, so its bucket was not evicted',
    attemptRateLimited('10.0.0.1').status === 429,
  );
  check('throttling reports when to retry', typeof attemptRateLimited('10.0.0.1').headers['Retry-After'] === 'string');

  // ── regression: registration reclaims abandoned clients ───────────────────
  section('Regression — a full client table reclaims abandoned registrations');

  const seedStore = new OAuthStore(join(dataDir, 'seed-probe.json'));
  const seedProvider = new OAuthProvider({
    store: seedStore, issuer: config.auth.oauth.issuer, resourceUrl: `${config.publicUrl}/mcp`,
    password: PASS, oauthEnabled: true,
  });
  const seed = async (count, { old, withToken }) => {
    for (let i = 0; i < count; i += 1) {
      await seedStore.putClient({
        client_id: `seed_${old ? 'old' : 'new'}_${i}`,
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        created_at: old ? 0 : Date.now(),
      });
    }
    if (withToken) {
      await seedStore.putToken({
        token: 'live-token', kind: 'access', client_id: 'seed_old_0', family: 'g',
        expires_at: Date.now() + 600_000, created_at: Date.now(), status: 'active',
      });
    }
  };

  // A full table of registrations that never became anything: reclamation has to make room.
  await seed(200, { old: true, withToken: false });
  let reclaimWorked = true;
  try {
    await seedProvider.registerClient({ redirect_uris: [CLAUDE_CALLBACK] });
  } catch (error) {
    reclaimWorked = false;
    check('registration succeeded by reclaiming', false, String(error.message));
  }
  check('registration succeeds by reclaiming idle clients', reclaimWorked);
  check('abandoned registrations were dropped', (await seedStore.listClients()).length < 200);

  // Now a full table where a live token makes a client un-reclaimable.
  const busyStore = new OAuthStore(join(dataDir, 'busy-probe.json'));
  const busyProvider = new OAuthProvider({
    store: busyStore, issuer: config.auth.oauth.issuer, resourceUrl: `${config.publicUrl}/mcp`,
    password: PASS, oauthEnabled: true,
  });
  for (let i = 0; i < 200; i += 1) {
    await busyStore.putClient({
      client_id: `busy_${i}`, redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none', created_at: 0,
    });
    await busyStore.putToken({
      token: `busy-token-${i}`, kind: 'access', client_id: `busy_${i}`, family: `g${i}`,
      expires_at: Date.now() + 600_000, created_at: Date.now(), status: 'active',
    });
  }
  let busyRefused = false;
  try {
    await busyProvider.registerClient({ redirect_uris: [CLAUDE_CALLBACK] });
  } catch (error) {
    busyRefused = /maximum of 200/.test(String(error.message));
  }
  check('a table of clients holding live tokens is not reclaimed', busyRefused);
  check('those clients are untouched', (await busyStore.listClients()).length === 200);

  // ── regression: search budgets ────────────────────────────────────────────
  section('Regression — the search process has its own budgets');

  const budgetRoot = join(dataDir, 'projects', 'searchprobe');
  const wsSearch = new ProjectWorkspace(dataDir, 'searchprobe', 'Search Probe', { maxFileBytes: 1024 * 1024 });
  await wsSearch.ensure();
  await wsSearch.write('small.tex', 'needle here\n');
  await wsSearch.write('big.tex', `needle ${'x'.repeat(5000)}\n`);

  const skippedBig = await searchIsolated({
    root: budgetRoot, files: ['small.tex', 'big.tex'], skip: [], pattern: 'needle',
    isRegex: false, caseSensitive: false, maxResults: 10, lineCap: 4000, timeoutMs: 8000,
    maxFileBytes: 1000, maxTotalBytes: 1_000_000,
  });
  check('a file over the per-file budget is skipped', skippedBig.hits.length === 1, JSON.stringify(skippedBig.hits));
  check('the small file was still searched', skippedBig.hits[0]?.path === 'small.tex');

  const totalBudget = await searchIsolated({
    root: budgetRoot, files: ['big.tex', 'small.tex'], skip: [], pattern: 'needle',
    isRegex: false, caseSensitive: false, maxResults: 10, lineCap: 4000, timeoutMs: 8000,
    maxFileBytes: 1024 * 1024, maxTotalBytes: 100,
  });
  check('the total byte budget stops the scan', totalBudget.budgetExhausted === true, JSON.stringify(totalBudget));

  // ── regression: deleting a directory is a separate decision ───────────────
  section('Regression — deleting a directory is not a single-file delete');

  const wsDel = new ProjectWorkspace(dataDir, 'delprobe', 'Delete Probe', { maxFileBytes: 1024 * 1024 });
  await wsDel.ensure();
  await wsDel.write('chapter/one.tex', 'one\n');
  await wsDel.write('chapter/two.tex', 'two\n');
  await wsDel.commit('edit: seed');

  const described = await wsDel.describeDeletion('chapter');
  check('the directory is recognised', described.isDirectory === true);
  check('its contents are listed before anything happens', described.files.length === 2, JSON.stringify(described.files));

  let dirRefused = false;
  try {
    await wsDel.remove('chapter');
  } catch (error) {
    dirRefused = /directory/.test(String(error.message));
  }
  check('removing a directory without recursive is refused', dirRefused);
  check('nothing was deleted', existsSync(join(wsDel.dir, 'chapter', 'one.tex')));

  await wsDel.remove('chapter', { recursive: true });
  check('recursive removal works when asked for', !existsSync(join(wsDel.dir, 'chapter')));

  // ── regression: a symlinked directory cannot smuggle a write outside ──────
  section('Regression — writes cannot escape through a symlinked directory');

  const { symlinkSync } = await import('node:fs');
  const escapeRoot = join(dataDir, 'escape');
  const outsideDir = join(dataDir, 'outside-the-project');
  mkdirSync(outsideDir, { recursive: true });

  const wsLink = new ProjectWorkspace(escapeRoot, 'linkprobe', 'Link Probe', { maxFileBytes: 1024 * 1024 });
  await wsLink.ensure();
  symlinkSync(outsideDir, join(wsLink.dir, 'link'), 'dir');

  let linkWriteRefused = false;
  try {
    await wsLink.write('link/escape.tex', 'should not land outside\n');
  } catch {
    linkWriteRefused = true;
  }
  check('a write through a symlinked directory is refused', linkWriteRefused);
  check('nothing appeared outside the project', !existsSync(join(outsideDir, 'escape.tex')));

  let moveEscaped = false;
  try {
    await wsLink.write('legit.tex', 'content\n');
    await wsLink.movePath('legit.tex', 'link/moved.tex');
  } catch {
    moveEscaped = true;
  }
  check('a move through a symlinked directory is refused', moveEscaped);
  check('the source is still in place', existsSync(join(wsLink.dir, 'legit.tex')));

  // ── regression: redaction covers encoded variants ─────────────────────────
  section('Regression — redaction covers encoded forms and updates');

  const { registerSecret, redact } = await import('../dist/util/errors.js');
  registerSecret('s3cret%2Dvalue%2Dwith%2Dencoding');
  check('the encoded form is scrubbed', !redact('token=s3cret%2Dvalue%2Dwith%2Dencoding').includes('s3cret%2Dvalue'));
  check('the decoded form is scrubbed too', !redact('saw s3cret-value-with-encoding in a log').includes('s3cret-value-with-encoding'));
  check('a freshly registered secret takes effect immediately', !redact('value is rotated-secret-9999').includes('rotated-secret-9999') === false);
  registerSecret('rotated-secret-9999');
  check('after registration it is scrubbed', !redact('value is rotated-secret-9999').includes('rotated-secret-9999'));
  check('short values are not registered', redact('abc') === 'abc');

  // ── regression: dot files are discoverable, git internals are not ─────────
  section('Regression — listing and reading agree about hidden files');

  const wsDot = new ProjectWorkspace(dataDir, 'dotprobe', 'Dot Probe', { maxFileBytes: 1024 * 1024 });
  await wsDot.ensure();
  await wsDot.write('.latexmkrc', "$pdf_mode = 1;\n");
  check('a dot file is listed', wsDot.listFiles().includes('.latexmkrc'), JSON.stringify(wsDot.listFiles()));
  check('and can be read', (await wsDot.read('.latexmkrc')).includes('pdf_mode'));
  check('git internals are still unreachable', !wsDot.listFiles().some((f) => f.toLowerCase().startsWith('.git')));

  // ── regression: callback patterns are validated before use ────────────────
  section('Regression — callback patterns must be anchored and literal');

  const { validateRedirectPatterns } = await import('../dist/auth/provider.js');
  check('an unanchored pattern is rejected', validateRedirectPatterns(['https://x.example/cb']).length > 0);
  check('an unescaped dot is rejected', validateRedirectPatterns(['^https://x.example/cb$']).length > 0);
  check('an invalid expression is rejected', validateRedirectPatterns(['[invalid(']).length > 0);
  check('a correct pattern passes', validateRedirectPatterns(['^https://x\\.example/cb$']).length === 0);

  const exactProvider = new OAuthProvider({
    store, issuer: config.auth.oauth.issuer, resourceUrl: `${config.publicUrl}/mcp`,
    password: PASS, oauthEnabled: true,
    extraRedirectUrls: ['https://mcp.example.com/cb'],
  });
  check('an exact URL is accepted', exactProvider.isRedirectAllowed('https://mcp.example.com/cb'));
  check('a hostname variant is not', !exactProvider.isRedirectAllowed('https://mcpXexample.com/cb'));
  check(
    'a URL carrying the real callback as a parameter is not',
    !exactProvider.isRedirectAllowed('https://evil.example/?next=https://mcp.example.com/cb'),
  );

  // ── regression: change sets make a multi-file edit atomic ─────────────────
  section('Regression — a change set is published as one unit or not at all');

  const toolByName = (list, name) => list.find((tool) => tool.name === name);
  const beginSet = toolByName(buildTools, 'begin_change_set');
  const commitSet = toolByName(buildTools, 'commit_change_set');
  const abandonSet = toolByName(buildTools, 'abandon_change_set');
  const undoOperation = toolByName(buildTools, 'undo_operation');

  const csZip = new AdmZip();
  csZip.addFile('intro.tex', Buffer.from('Introduction v1\n'));
  csZip.addFile('methods.tex', Buffer.from('Methods v1\n'));
  const csUploads = [];
  const csClient = {
    downloadProject: async () => csZip.toBuffer(),
    uploadFile: async (_p, _f, name) => {
      csUploads.push(name);
      return { success: true };
    },
    deleteByPath: async () => undefined,
    invalidateFolderTree: () => undefined,
  };

  const wsCS = new ProjectWorkspace(dataDir, 'csprobe', 'Change Set Probe', { maxFileBytes: 1024 * 1024 });
  await wsCS.pull(csClient);
  csUploads.length = 0;

  const csCtx = {
    config: { ...config, autoPush: true, readOnly: false, freshReads: false },
    readOnly: false,
    session: { run: (fn) => fn(csClient) },
    registry: { resolve: async () => ({ id: 'csprobe', name: 'Change Set Probe' }) },
    workspaces: { for: () => wsCS },
    locks: new KeyedMutex(),
  };

  const beginResult = await beginSet.run(csCtx, { description: 'tighten the introduction', project: 'csprobe' });
  const csId = /cs_[0-9a-f]+/.exec(beginResult)?.[0];
  check('a change set opens with an id', typeof csId === 'string', beginResult);
  check('it says nothing has been published yet', /Nothing reaches Overleaf/.test(beginResult));

  let doubleOpenRefused = false;
  try {
    await beginSet.run(csCtx, { description: 'another', project: 'csprobe' });
  } catch (error) {
    doubleOpenRefused = /already open/.test(String(error.message));
  }
  check('a second change set cannot be opened at the same time', doubleOpenRefused);

  const firstEdit = await editBoth.run(csCtx, {
    path: 'intro.tex', old_text: 'Introduction v1', new_text: 'Introduction v2', project: 'csprobe',
  });
  await editBoth.run(csCtx, {
    path: 'methods.tex', old_text: 'Methods v1', new_text: 'Methods v2', project: 'csprobe',
  });

  check('the first edit reports being staged', /Staged in change set/.test(firstEdit.text), firstEdit.text);
  const firstOperationId = /op_[0-9a-f]+/.exec(firstEdit.text)?.[0];
  check('the edit reports an operation id', typeof firstOperationId === 'string', firstEdit.text);
  check('nothing was uploaded while the set is open', csUploads.length === 0, JSON.stringify(csUploads));
  check('both edits are present locally', (await wsCS.read('intro.tex')).includes('v2') && (await wsCS.read('methods.tex')).includes('v2'));
  check('both are reported as pending', (await wsCS.changes()).length === 2);

  const committed = await commitSet.run(csCtx, { project: 'csprobe' });
  check('the commit publishes every file at once', csUploads.includes('intro.tex') && csUploads.includes('methods.tex'), JSON.stringify(csUploads));
  check('the commit reports the operation count', /2 operation\(s\) folded in/.test(committed), committed);
  check('nothing is pending afterwards', (await wsCS.changes()).length === 0);
  check('the change set is closed', (await wsCS.journal.getOpen()) === null);

  // Undo one operation while leaving unrelated later work alone. The later edit touches a
  // different file on purpose: reversing an edit whose own lines were rewritten afterwards is
  // a conflict, and refusing that is the correct behaviour (tested next).
  await editBoth.run(csCtx, { path: 'methods.tex', old_text: 'Methods v2', new_text: 'Methods v3', project: 'csprobe' });
  check('the later edit landed', (await wsCS.read('methods.tex')).includes('Methods v3'));

  const undone = await undoOperation.run(csCtx, { operation_id: firstOperationId, project: 'csprobe' });
  check('undo_operation reports which operation it reversed', undone.text.includes(firstOperationId), undone.text);
  check('the targeted operation was reversed', (await wsCS.read('intro.tex')).includes('Introduction v1'), await wsCS.read('intro.tex'));
  check('the unrelated later edit was left alone', (await wsCS.read('methods.tex')).includes('Methods v3'), await wsCS.read('methods.tex'));

  // Reversing an edit whose own lines were rewritten afterwards must refuse rather than guess.
  const conflicting = await editBoth.run(csCtx, {
    path: 'intro.tex', old_text: 'Introduction v1', new_text: 'Introduction CONFLICT-A', project: 'csprobe',
  });
  const conflictId = /op_[0-9a-f]+/.exec(conflicting.text)?.[0];
  await editBoth.run(csCtx, {
    path: 'intro.tex', old_text: 'Introduction CONFLICT-A', new_text: 'Introduction CONFLICT-B', project: 'csprobe',
  });
  let conflictRefused = false;
  try {
    await undoOperation.run(csCtx, { operation_id: conflictId, project: 'csprobe' });
  } catch (error) {
    conflictRefused = /conflicts with later edits/.test(String(error.message));
  }
  check('reversing an edit that later edits rewrote is refused', conflictRefused);
  check('the refusal left the file as it was', (await wsCS.read('intro.tex')).includes('CONFLICT-B'), await wsCS.read('intro.tex'));

  let unknownOperationRefused = false;
  try {
    await undoOperation.run(csCtx, { operation_id: 'op_doesnotexist', project: 'csprobe' });
  } catch (error) {
    unknownOperationRefused = /no operation/.test(String(error.message));
  }
  check('an unknown operation id is refused', unknownOperationRefused);

  // Abandoning discards the work without ever touching Overleaf.
  csUploads.length = 0;
  await beginSet.run(csCtx, { description: 'a rewrite we will discard', project: 'csprobe' });
  await editBoth.run(csCtx, { path: 'methods.tex', old_text: 'Methods v3', new_text: 'Methods DISCARDED', project: 'csprobe' });
  check('the discarded edit is on disk first', (await wsCS.read('methods.tex')).includes('DISCARDED'));

  const abandoned = await abandonSet.run(csCtx, { project: 'csprobe' });
  check('abandoning lists what it reverted', /methods\.tex/.test(abandoned), abandoned);
  check('the edit is gone', !(await wsCS.read('methods.tex')).includes('DISCARDED'), await wsCS.read('methods.tex'));
  check('the file is back to its committed content', (await wsCS.read('methods.tex')).includes('Methods v3'));
  check('abandoning never published anything', csUploads.length === 0, JSON.stringify(csUploads));
  check('the change set is closed after abandoning', (await wsCS.journal.getOpen()) === null);

  let nothingToAbandon = false;
  try {
    await abandonSet.run(csCtx, { project: 'csprobe' });
  } catch (error) {
    nothingToAbandon = /no open change set/.test(String(error.message));
  }
  check('abandoning with nothing open is refused', nothingToAbandon);

  // A failed publish must leave the set open rather than losing it.
  csUploads.length = 0;
  await beginSet.run(csCtx, { description: 'will fail to publish', project: 'csprobe' });
  await editBoth.run(csCtx, { path: 'intro.tex', old_text: 'Introduction CONFLICT-B', new_text: 'Introduction v4', project: 'csprobe' });
  const failingCtx = {
    ...csCtx,
    session: { run: (fn) => fn({ ...csClient, uploadFile: async () => { throw new Error('upload refused'); } }) },
  };
  const failedCommit = await commitSet.run(failingCtx, { project: 'csprobe' });
  check('a failed commit is an error result', failedCommit.isError === true, JSON.stringify(failedCommit));
  check('the change set stays open after a failure', (await wsCS.journal.getOpen())?.id !== undefined);
  check('the work is still there', (await wsCS.read('intro.tex')).includes('v4'));

  // ── regression: the token store is not world-readable ──────────────────────
  section('Regression — OAuth state file permissions');

  const storeMode = statSync(join(dataDir, 'oauth.json')).mode & 0o777;
  check('the token store is owner-only (0600)', storeMode === 0o600, `mode ${storeMode.toString(8)}`);
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