/**
 * A self-contained OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Why this exists at all: the major web clients will not accept a static API key for a
 * remote MCP server. ChatGPT documents no way to present one, and Gemini's custom-app flow
 * is OAuth-only. So "one server, usable from Gemini, Claude and ChatGPT" forces us to be a
 * real authorization server — authorization code + PKCE + dynamic client registration,
 * with the discovery metadata each vendor insists on.
 *
 * The trust model is deliberately small: one operator (the person who owns the Overleaf
 * account) approves each connecting client by typing a passphrase. Tokens are opaque and
 * server-side, so revocation is immediate.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AUTH_CODE_TTL_MS, ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from './store.js';
import type { AuthCode, OAuthClient, OAuthStore, TokenRecord } from './store.js';
import { log } from '../util/logger.js';

/**
 * Bounds on dynamic client registration.
 *
 * Registration needs no credentials by design (that is how the assistants onboard), which
 * makes it the one place an anonymous caller can make the server do unbounded work: every
 * accepted client is a permanent record in a JSON file that is rewritten wholesale on each
 * token operation.
 */
const MAX_REGISTERED_CLIENTS = 200;
/** How long a registration must have existed, untouched, before it can be reclaimed. */
const IDLE_CLIENT_MS = 15 * 60 * 1000;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_SCOPE_LENGTH = 500;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;

export const SCOPE_READ = 'overleaf.read';
export const SCOPE_WRITE = 'overleaf.write';
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/**
 * Redirect URIs we will send an authorization code to.
 *
 * This allowlist is the single most security-critical value in the file: without it,
 * dynamic client registration turns this server into an open redirector that hands
 * Overleaf-account access to whoever asks. Vendors use fixed, documented callbacks.
 */
const BUILTIN_REDIRECT_PATTERNS: RegExp[] = [
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/claude\.com\/api\/mcp\/auth_callback$/,
  /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9._~-]+$/,
  /^https:\/\/oauth-redirect\.googleusercontent\.com\/r\/[A-Za-z0-9._~/-]+$/,
  // Native/CLI clients (Claude Code, MCP Inspector) use an ephemeral loopback listener.
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?$/,
];

export interface Principal {
  clientId: string;
  scopes: string[];
  /** Present for machine clients authenticated with a static bearer token. */
  staticToken?: boolean;
}

export interface AuthorizeRequest {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  resource?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface OAuthProviderOptions {
  store: OAuthStore;
  /** Public origin of this server, e.g. https://mcp.example.com — used as the AS issuer. */
  issuer: string;
  /** Exact URL of the MCP endpoint the metadata must advertise. */
  resourceUrl: string;
  /** Operator passphrase gating the consent screen. */
  password: string;
  /**
   * Extra callback URLs, matched exactly.
   *
   * Preferred over patterns: a URL compared as a string cannot accidentally accept a
   * neighbouring host, whereas a regular expression built from a URL treats `.` as "any
   * character", so `https://mcp.example.com` would also match `https://mcpXexample.com`.
   */
  extraRedirectUrls?: string[];
  /**
   * Extra callback patterns, as anchored regular expressions.
   *
   * Validated at startup; see `validateRedirectPatterns`.
   */
  extraRedirectPatterns?: string[];
  /** Static bearer tokens for local/CLI clients; always granted full scope. */
  staticTokens?: string[];
  /**
   * Whether this deployment issues its own OAuth tokens.
   *
   * When false, tokens found in the store are refused even if they are unexpired. Without
   * this, switching a deployment from `oauth` to `bearer` would leave already-issued tokens
   * live — a downgrade that silently keeps the old front door unlocked.
   */
  oauthEnabled: boolean;
}

/**
 * Reject callback patterns that are not anchored.
 *
 * An unanchored pattern is matched anywhere in the string, so `claude.ai/api/mcp/auth_callback`
 * would accept `https://evil.example/?next=https://claude.ai/api/mcp/auth_callback` — a URL
 * that carries the real callback as a parameter. Requiring `^…$` is the cheapest way to make
 * that class of mistake impossible to configure.
 */
export function validateRedirectPatterns(patterns: string[]): string[] {
  const problems: string[] = [];
  for (const pattern of patterns) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (error) {
      problems.push(`not a valid regular expression (${error instanceof Error ? error.message : String(error)}): ${pattern}`);
      continue;
    }
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      problems.push(`must be anchored with ^ and $ so it cannot match part of a longer URL: ${pattern}`);
    }
    if (/(?<!\\)\./.test(pattern.replace(/\\\./g, ''))) {
      problems.push(`contains an unescaped "." (matches any character); write \\. for a literal dot: ${pattern}`);
    }
  }
  return problems;
}

export class OAuthProvider {
  private readonly patterns: RegExp[];
  private readonly exactUrls: Set<string>;

  constructor(private readonly options: OAuthProviderOptions) {
    this.patterns = [
      ...BUILTIN_REDIRECT_PATTERNS,
      ...(options.extraRedirectPatterns ?? []).map((source) => new RegExp(source)),
    ];
    this.exactUrls = new Set(options.extraRedirectUrls ?? []);
  }

  isRedirectAllowed(uri: string): boolean {
    return this.exactUrls.has(uri) || this.patterns.some((pattern) => pattern.test(uri));
  }

  private checkResource(resource: string | undefined): void {
    if (!resource) return;
    const normalize = (value: string): string => value.replace(/\/+$/, '');
    if (normalize(resource) !== normalize(this.options.resourceUrl)) {
      throw new OAuthError(
        'invalid_target',
        `resource must be ${this.options.resourceUrl}`,
        400,
      );
    }
  }

  // ── discovery metadata ───────────────────────────────────────────────────

  /** RFC 9728. `resource` must equal the MCP URL exactly, including its path. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.options.resourceUrl,
      authorization_servers: [this.options.issuer],
      scopes_supported: [...SUPPORTED_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Overleaf MCP',
      resource_documentation: `${this.options.issuer}/`,
    };
  }

  /** RFC 8414. */
  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.options.issuer,
      authorization_endpoint: `${this.options.issuer}/oauth/authorize`,
      token_endpoint: `${this.options.issuer}/oauth/token`,
      registration_endpoint: `${this.options.issuer}/oauth/register`,
      revocation_endpoint: `${this.options.issuer}/oauth/revoke`,
      scopes_supported: [...SUPPORTED_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_post',
        'client_secret_basic',
      ],
      code_challenge_methods_supported: ['S256'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    };
  }

  // ── dynamic client registration (RFC 7591) ───────────────────────────────

  async registerClient(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Registration is unauthenticated, so every value it accepts is bounded. Without this a
    // caller can grow the client table without limit, and each stored record is rewritten in
    // full on every token operation.
    const name = typeof body.client_name === 'string' ? body.client_name : undefined;
    if (name !== undefined && name.length > MAX_CLIENT_NAME_LENGTH) {
      throw new OAuthError('invalid_client_metadata', `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`);
    }
    const scope = typeof body.scope === 'string' ? body.scope : undefined;
    if (scope !== undefined && scope.length > MAX_SCOPE_LENGTH) {
      throw new OAuthError('invalid_client_metadata', `scope must be at most ${MAX_SCOPE_LENGTH} characters`);
    }

    const rawUris = body.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
    }
    if (rawUris.length > MAX_REDIRECT_URIS) {
      throw new OAuthError('invalid_redirect_uri', `at most ${MAX_REDIRECT_URIS} redirect_uris are accepted`);
    }
    const redirectUris = rawUris.filter((u): u is string => typeof u === 'string');
    const tooLong = redirectUris.find((uri) => uri.length > MAX_REDIRECT_URI_LENGTH);
    if (tooLong !== undefined) {
      throw new OAuthError('invalid_redirect_uri', `each redirect_uri must be at most ${MAX_REDIRECT_URI_LENGTH} characters`);
    }
    const rejected = redirectUris.filter((uri) => !this.isRedirectAllowed(uri));
    if (rejected.length > 0 || redirectUris.length === 0) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect_uri not allowed: ${rejected.join(', ') || '(none valid)'}. ` +
          'Only known assistant callbacks and loopback addresses are accepted.',
      );
    }

    let existing = await this.options.store.listClients();
    if (existing.length >= MAX_REGISTERED_CLIENTS) {
      // Make room from registrations that never became anything, rather than refusing a
      // legitimate client because abandoned ones are still on the books.
      const reclaimed = await this.options.store.reclaimIdleClients(IDLE_CLIENT_MS);
      if (reclaimed > 0) log.info(`reclaimed ${reclaimed} idle OAuth client registration(s)`);
      existing = await this.options.store.listClients();
    }
    if (existing.length >= MAX_REGISTERED_CLIENTS) {
      throw new OAuthError(
        'invalid_client_metadata',
        `this server already holds the maximum of ${MAX_REGISTERED_CLIENTS} registered clients, ` +
          'all of them in use; remove unused entries from the OAuth state file before registering more',
        403,
      );
    }

    const authMethod =
      typeof body.token_endpoint_auth_method === 'string'
        ? body.token_endpoint_auth_method
        : 'none';
    const isPublic = authMethod === 'none';
    const clientId = `mcp_${randomBytes(16).toString('hex')}`;
    // Public clients (PKCE, no secret) are the norm for native/CLI connectors; a secret is
    // only issued when the client explicitly asks for a confidential auth method.
    const clientSecret = isPublic ? undefined : randomBytes(32).toString('hex');

    const client: OAuthClient = {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      scope: scope ?? SUPPORTED_SCOPES.join(' '),
      created_at: Date.now(),
    };
    await this.options.store.putClient(client);

    return {
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
      client_id_issued_at: Math.floor(client.created_at / 1000),
      ...(client.client_secret
        ? { client_secret_expires_at: 0 }
        : {}),
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      scope: client.scope,
    };
  }

  // ── authorization endpoint ───────────────────────────────────────────────

  /** Validate an authorization request before showing the consent screen. */
  async validateAuthorize(params: AuthorizeRequest): Promise<OAuthClient> {
    if (params.response_type !== 'code') {
      throw new OAuthError('unsupported_response_type', 'only response_type=code is supported');
    }
    if (params.code_challenge_method !== 'S256') {
      throw new OAuthError('invalid_request', 'code_challenge_method must be S256');
    }
    if (!params.code_challenge || params.code_challenge.length < 43) {
      throw new OAuthError('invalid_request', 'a PKCE code_challenge is required');
    }
    const client = await this.options.store.getClient(params.client_id);
    if (!client) throw new OAuthError('invalid_client', 'unknown client_id', 401);
    if (!client.redirect_uris.includes(params.redirect_uri)) {
      throw new OAuthError('invalid_request', 'redirect_uri was not registered for this client');
    }
    this.checkResource(params.resource);
    return client;
  }

  verifyPassword(candidate: string): boolean {
    const expected = Buffer.from(this.options.password, 'utf8');
    const given = Buffer.from(candidate ?? '', 'utf8');
    // An unset passphrase must never authenticate anyone. Hashing both sides makes '' equal
    // '', which would turn the consent screen into a rubber stamp for any caller — so the
    // empty configuration is rejected before the comparison, not by it.
    if (expected.length === 0 || given.length === 0) return false;
    // timingSafeEqual throws on length mismatch, so compare a fixed-size digest instead.
    const a = createHash('sha256').update(expected).digest();
    const b = createHash('sha256').update(given).digest();
    return timingSafeEqual(a, b);
  }

  async issueCode(params: AuthorizeRequest): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const record: AuthCode = {
      code,
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scope: params.scope,
      resource: params.resource,
      expires_at: Date.now() + AUTH_CODE_TTL_MS,
    };
    await this.options.store.putCode(record);
    return code;
  }

  // ── token endpoint ───────────────────────────────────────────────────────

  async exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri?: string;
    codeVerifier: string;
  }): Promise<Record<string, unknown>> {
    const record = await this.options.store.takeCode(input.code);
    if (!record) {
      throw new OAuthError('invalid_grant', 'authorization code is unknown or has expired');
    }
    if (record.client_id !== input.clientId) {
      throw new OAuthError('invalid_grant', 'authorization code was issued to another client');
    }
    if (input.redirectUri && input.redirectUri !== record.redirect_uri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    const client = await this.options.store.getClient(input.clientId);
    if (!client) throw new OAuthError('invalid_client', 'unknown client', 401);
    this.authenticateClient(client, input.clientSecret);

    const expected = createHash('sha256').update(input.codeVerifier).digest('base64url');
    if (expected !== record.code_challenge) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }

    return this.mintTokens(client.client_id, record.scope, record.resource);
  }

  async refresh(refreshToken: string, clientId: string, clientSecret?: string): Promise<Record<string, unknown>> {
    const client = await this.options.store.getClient(clientId);
    if (!client) throw new OAuthError('invalid_client', 'unknown client', 401);
    this.authenticateClient(client, clientSecret);

    // Check ownership *without* consuming, so one client cannot destroy another's refresh
    // token just by presenting it.
    const peek = await this.options.store.getToken(refreshToken);
    if (!peek || peek.kind !== 'refresh' || peek.client_id !== clientId) {
      throw new OAuthError('invalid_grant', 'refresh token is unknown or has expired');
    }

    // A refresh token that has already been redeemed means the credential leaked: either the
    // legitimate client or a thief is replaying it. Both hold tokens from the same grant, so
    // the grant is revoked and the user re-authorizes. That revocation is the entire point of
    // rotation — without it, "the old token no longer works" would be all that was achieved,
    // while a stolen successor kept full access.
    if (peek.status === 'used') {
      const revoked = await this.options.store.revokeFamily(peek.family);
      log.warn(`replayed refresh token detected; revoked ${revoked} token(s) in its grant`);
      throw new OAuthError(
        'invalid_grant',
        'refresh token was already used; the grant has been revoked, please authorize again',
      );
    }

    // Then consume atomically: whoever claims it first is the only one who gets new tokens.
    const record = await this.options.store.claimToken(refreshToken);
    if (!record) {
      throw new OAuthError('invalid_grant', 'refresh token is unknown or has expired');
    }

    // Checked again at mint time rather than only here: between claiming the token and
    // writing its successors there is an await, and a revocation can land inside it.
    if (this.options.store.isGrantRevoked(record.family)) {
      throw new OAuthError('invalid_grant', 'this authorization has been revoked; please authorize again');
    }

    return this.mintTokens(clientId, record.scope, record.resource, record.family);
  }

  private authenticateClient(client: OAuthClient, secret: string | undefined): void {
    if (client.token_endpoint_auth_method === 'none' || !client.client_secret) return;
    if (!secret || secret !== client.client_secret) {
      throw new OAuthError('invalid_client', 'client authentication failed', 401);
    }
  }

  private async mintTokens(
    clientId: string,
    scope: string | undefined,
    resource: string | undefined,
    /** The grant this rotation belongs to; a fresh one is created when absent. */
    family?: string,
  ): Promise<Record<string, unknown>> {
    const now = Date.now();
    const grant = family ?? randomBytes(16).toString('hex');
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const grantedScope = scope && scope.trim() !== '' ? scope : SUPPORTED_SCOPES.join(' ');

    const access: TokenRecord = {
      token: accessToken,
      kind: 'access',
      client_id: clientId,
      scope: grantedScope,
      resource,
      expires_at: now + ACCESS_TOKEN_TTL_MS,
      created_at: now,
      family: grant,
      status: 'active',
    };
    const refresh: TokenRecord = {
      token: refreshToken,
      kind: 'refresh',
      client_id: clientId,
      scope: grantedScope,
      resource,
      expires_at: now + REFRESH_TOKEN_TTL_MS,
      created_at: now,
      family: grant,
      status: 'active',
    };
    // Inserted through the store so the revocation check and the write are one atomic step;
    // a refresh that was already in flight when its grant was revoked must not be able to
    // write itself back to life.
    const inserted = await this.options.store.mintTokens([access, refresh], grant);
    if (!inserted) {
      throw new OAuthError('invalid_grant', 'this authorization has been revoked; please authorize again');
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: grantedScope,
    };
  }

  // ── request authentication ───────────────────────────────────────────────

  /** RFC 7009 revocation. Unknown tokens are a no-op, so this leaks nothing. */
  async revoke(token: string): Promise<void> {
    await this.options.store.deleteToken(token);
  }

  /** Resolve a bearer token to a principal, or null when it is not valid. */
  async authenticate(token: string): Promise<Principal | null> {
    // Compare digests so the loop does not leak which token prefix was closest, and so a
    // length mismatch cannot short-circuit either.
    const statics = this.options.staticTokens ?? [];
    if (statics.length > 0) {
      const given = createHash('sha256').update(token).digest();
      let matched = false;
      for (const candidate of statics) {
        const expected = createHash('sha256').update(candidate).digest();
        if (timingSafeEqual(given, expected)) matched = true;
      }
      if (matched) {
        return { clientId: 'static-token', scopes: [...SUPPORTED_SCOPES], staticToken: true };
      }
    }

    // Tokens minted by this server are only honoured while OAuth is actually enabled.
    if (!this.options.oauthEnabled) return null;

    const record = await this.options.store.getToken(token);
    if (!record || record.kind !== 'access') return null;
    return {
      clientId: record.client_id,
      scopes: (record.scope ?? '').split(/\s+/).filter(Boolean),
    };
  }

  /** The `WWW-Authenticate` value clients use to discover where to authenticate. */
  challenge(error?: string): string {
    const parts = [`Bearer resource_metadata="${this.options.issuer}/.well-known/oauth-protected-resource/mcp"`];
    if (error) parts.push(`error="${error}"`);
    parts.push(`scope="${SUPPORTED_SCOPES.join(' ')}"`);
    return parts.join(', ');
  }
}