/**
 * Central configuration, read once from the environment.
 *
 * Everything the server needs is expressible as env vars so the same build runs
 * locally (stdio, for Cursor/Claude Desktop) and on a server (HTTP, for the web clients).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type AuthMode = 'none' | 'bearer' | 'oauth';

export interface OverleafCreds {
  /** e.g. https://www.overleaf.com — also works for self-hosted ShareLaTeX/Overleaf CE. */
  baseUrl: string;
  /** Value of the session cookie (overleaf_session2 on overleaf.com). */
  session?: string;
  /** Self-hosted only: used to silently re-login when the cookie expires. */
  email?: string;
  password?: string;
  cookieName: string;
}

export interface AuthConfig {
  mode: AuthMode;
  /** Static bearer tokens accepted when mode is 'bearer' (or as an OAuth fallback). */
  tokens: string[];
  /** Only used when mode === 'oauth'. */
  oauth: {
    issuer: string;
    /** Pre-registered client id/secret; if empty, dynamic client registration is enabled. */
    clientId?: string;
    clientSecret?: string;
    /** Where the browser is sent to approve access. Defaults to issuer + /authorize. */
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
  };
}

export interface AppConfig {
  host: string;
  port: number;
  /** Public HTTPS origin the MCP endpoint is reachable at, e.g. https://mcp.example.com */
  publicUrl: string;
  /** Root directory holding one git-versioned mirror per Overleaf project. */
  dataDir: string;
  /** Project (id or exact name) assumed when a tool call omits `project`. */
  defaultProject?: string;
  /** Push each accepted edit straight back to Overleaf so the browser shows it immediately. */
  autoPush: boolean;
  /** Refuse every mutating tool. Useful for a "read-only" share link. */
  readOnly: boolean;
  /** Guard against a runaway model rewriting a huge binary through a tool call. */
  maxFileBytes: number;
  /** Answer MCP requests with a JSON body instead of an SSE stream. */
  jsonResponses: boolean;
  /**
   * Fetch a file from Overleaf before reading or editing it, so the model never works from
   * a stale copy. Costs one request per read; disable to trade correctness for speed.
   */
  freshReads: boolean;
  /**
   * Express `trust proxy` setting: how many reverse proxies sit in front of this server.
   *
   * `1` matches the documented deployment (Caddy in front) and is safe there, because the
   * rightmost X-Forwarded-For entry is the one the proxy itself appended. `true` is never
   * used: it trusts client-supplied headers outright, which lets anyone evade the rate
   * limiter by rotating X-Forwarded-For.
   */
  trustProxy: number | false;
  /**
   * Whether `MCP_AUTH_MODE=none` also grants write access.
   *
   * Anonymous access is read-only unless this is set: an unauthenticated public endpoint
   * that can edit someone's thesis is a footgun, and opting in should be deliberate.
   */
  allowAnonymousWrite: boolean;
  auth: AuthConfig;
  overleaf: OverleafCreds;
}

/** Minimal .env loader — avoids a dependency and keeps `node dist/index.js` self-contained. */
export function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // real env always wins
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    process.env[key] = value;
  }
}

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name)?.toLowerCase();
  if (v === undefined) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string): string[] {
  return (str(name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A hop count, or false to trust nothing. `true` is deliberately not reachable. */
function trustProxySetting(): number | false {
  const raw = (str('TRUST_PROXY') ?? '1').toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  const hops = Number.parseInt(raw, 10);
  return Number.isFinite(hops) && hops > 0 ? hops : false;
}

export function loadConfig(): AppConfig {
  loadDotEnv();

  const mode = (str('MCP_AUTH_MODE') ?? 'bearer').toLowerCase() as AuthMode;
  const publicUrl = (str('PUBLIC_URL') ?? `http://localhost:${int('PORT', 8080)}`).replace(/\/+$/, '');

  return {
    host: str('HOST') ?? '0.0.0.0',
    port: int('PORT', 8080),
    publicUrl,
    dataDir: resolve(str('OLMCP_DATA_DIR') ?? './data'),
    defaultProject: str('OVERLEAF_DEFAULT_PROJECT'),
    autoPush: bool('OLMCP_AUTO_PUSH', true),
    readOnly: bool('OLMCP_READ_ONLY', false),
    maxFileBytes: int('OLMCP_MAX_FILE_BYTES', 2 * 1024 * 1024),
    jsonResponses: bool('MCP_JSON_RESPONSES', true),
    freshReads: bool('OLMCP_FRESH_READS', true),
    trustProxy: trustProxySetting(),
    allowAnonymousWrite: bool('OLMCP_ALLOW_ANONYMOUS_WRITE', false),
    auth: {
      mode: mode === 'none' || mode === 'oauth' ? mode : 'bearer',
      tokens: list('MCP_BEARER_TOKENS'),
      oauth: {
        issuer: (str('MCP_OAUTH_ISSUER') ?? publicUrl).replace(/\/+$/, ''),
        clientId: str('MCP_OAUTH_CLIENT_ID'),
        clientSecret: str('MCP_OAUTH_CLIENT_SECRET'),
        authorizationEndpoint: str('MCP_OAUTH_AUTHORIZE_URL'),
        tokenEndpoint: str('MCP_OAUTH_TOKEN_URL'),
      },
    },
    overleaf: {
      baseUrl: (str('OVERLEAF_BASE_URL') ?? 'https://www.overleaf.com').replace(/\/+$/, ''),
      session: str('OVERLEAF_SESSION'),
      email: str('OVERLEAF_EMAIL'),
      password: str('OVERLEAF_PASSWORD'),
      cookieName: str('OVERLEAF_COOKIE_NAME') ?? 'overleaf_session2',
    },
  };
}