/**
 * HTTP surface of the authorization server: discovery metadata, registration, consent,
 * token exchange and revocation.
 *
 * Every endpoint here is on the path to handing out access to someone's Overleaf account,
 * so the failure mode is always "refuse" rather than "allow with a warning".
 */

import { Router, type Request, type Response } from 'express';

import { OAuthError, SUPPORTED_SCOPES, type AuthorizeRequest, type OAuthProvider } from './provider.js';
import { log } from '../util/logger.js';

function oauthErrorResponse(res: Response, error: unknown): void {
  if (error instanceof OAuthError) {
    res
      .status(error.status)
      .json({ error: error.code, error_description: error.message });
    return;
  }
  log.error('unexpected OAuth failure', error);
  res.status(500).json({ error: 'server_error' });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readAuthorizeRequest(source: Record<string, unknown>): AuthorizeRequest {
  return {
    response_type: asString(source.response_type) ?? '',
    client_id: asString(source.client_id) ?? '',
    redirect_uri: asString(source.redirect_uri) ?? '',
    state: asString(source.state),
    code_challenge: asString(source.code_challenge) ?? '',
    code_challenge_method: asString(source.code_challenge_method) ?? '',
    scope: asString(source.scope),
    resource: asString(source.resource),
  };
}

const CONSENT_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 34rem; margin: 8vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .35rem; }
  p.lead { margin: 0 0 1.4rem; opacity: .75; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .4rem .9rem; margin: 0 0 1.5rem;
       padding: .9rem 1rem; border: 1px solid rgba(127,127,127,.32); border-radius: .6rem; }
  dt { opacity: .7; }
  dd { margin: 0; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
       font-size: .86rem; }
  label { display: block; font-weight: 600; margin-bottom: .4rem; }
  input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; box-sizing: border-box;
       border: 1px solid rgba(127,127,127,.5); border-radius: .45rem; background: transparent;
       color: inherit; }
  button { margin-top: 1rem; width: 100%; padding: .7rem 1rem; font-size: 1rem; font-weight: 600;
       border: 0; border-radius: .45rem; background: #138a52; color: #fff; cursor: pointer; }
  .warn { margin-top: 1.4rem; padding: .8rem 1rem; border-radius: .5rem; font-size: .87rem;
       background: rgba(190,120,0,.12); border: 1px solid rgba(190,120,0,.35); }
  .err { margin-bottom: 1rem; padding: .7rem .9rem; border-radius: .5rem;
       background: rgba(200,40,40,.12); border: 1px solid rgba(200,40,40,.4); }
`;

function renderConsent(
  params: AuthorizeRequest,
  clientName: string,
  error?: string,
): string {
  const hidden = [
    'response_type', 'client_id', 'redirect_uri', 'state',
    'code_challenge', 'code_challenge_method', 'scope', 'resource',
  ]
    .map((key) => {
      const value = (params as unknown as Record<string, unknown>)[key];
      return typeof value === 'string' && value !== ''
        ? `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`
        : '';
    })
    .join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Authorize Overleaf MCP access</title>
  <style>${CONSENT_STYLE}</style>
</head>
<body>
  <h1>Authorize access to Overleaf</h1>
  <p class="lead">An assistant is asking to read and edit your Overleaf projects through this MCP server.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  <dl>
    <dt>Application</dt><dd>${escapeHtml(clientName)}</dd>
    <dt>Callback</dt><dd>${escapeHtml(params.redirect_uri)}</dd>
    <dt>Scopes</dt><dd>${escapeHtml(params.scope ?? SUPPORTED_SCOPES.join(' '))}</dd>
  </dl>
  <form method="post" action="/oauth/authorize">
      ${hidden}
    <label for="password">Operator passphrase</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit">Authorize</button>
  </form>
  <div class="warn">
    Only authorize clients you started yourself. This grants the assistant the same access
    to your Overleaf account as your browser session has.
  </div>
</body>
</html>`;
}

export interface AuthRouterOptions {
  provider: OAuthProvider;
  /** Where the browser lands after a successful authorization with no client redirect. */
  landingPage?: string;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { provider } = options;
  const router = Router();

  // The consent screen is the one page where a click decides whether a stranger gets write
  // access to someone's papers, so it refuses to be framed and refuses to be cached.
  // `form-action 'self'` is what keeps an injected form from posting the passphrase elsewhere;
  // there is no script on the page at all, hence `script-src 'none'`.
  router.use((_req, res, next) => {
    res.set('Content-Security-Policy', [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '));
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    next();
  });

  const serveProtectedResourceMetadata = (_req: Request, res: Response): void => {
    res.json(provider.protectedResourceMetadata());
  };
  // Both the bare and the path-aware form are required: clients differ on which they probe.
  router.get('/.well-known/oauth-protected-resource', serveProtectedResourceMetadata);
  router.get('/.well-known/oauth-protected-resource/mcp', serveProtectedResourceMetadata);
  router.get('/.well-known/oauth-protected-resource/*splat', serveProtectedResourceMetadata);

  const serveAsMetadata = (_req: Request, res: Response): void => {
    res.json(provider.authorizationServerMetadata());
  };
  router.get('/.well-known/oauth-authorization-server', serveAsMetadata);
  router.get('/.well-known/oauth-authorization-server/*splat', serveAsMetadata);
  // OIDC-style discovery, which some clients try first.
  router.get('/.well-known/openid-configuration', serveAsMetadata);

  router.post('/oauth/register', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const client = await provider.registerClient(body);
      log.info(`registered OAuth client ${String(client.client_id)}`);
      res.status(201).json(client);
    } catch (error) {
      oauthErrorResponse(res, error);
    }
  });

  router.get('/oauth/authorize', async (req: Request, res: Response) => {
    try {
      const params = readAuthorizeRequest(req.query as Record<string, unknown>);
      const client = await provider.validateAuthorize(params);
      res.type('html').send(renderConsent(params, client.client_name ?? client.client_id));
    } catch (error) {
      if (error instanceof OAuthError) {
        res.status(error.status).type('html').send(
          `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
            `<body style="font:15px/1.55 system-ui;max-width:34rem;margin:8vh auto;padding:0 1.25rem">` +
            `<h1 style="font-size:1.2rem">Authorization failed</h1>` +
            `<p><strong>${escapeHtml(error.code)}</strong> — ${escapeHtml(error.message)}</p></body>`,
        );
        return;
      }
      oauthErrorResponse(res, error);
    }
  });

  router.post('/oauth/authorize', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const params = readAuthorizeRequest(body);
      const client = await provider.validateAuthorize(params);

      const password = asString(body.password) ?? '';
      if (!provider.verifyPassword(password)) {
        log.warn(`rejected consent attempt for client ${params.client_id}`);
        res
          .status(401)
          .type('html')
          .send(renderConsent(params, client.client_name ?? client.client_id, 'Incorrect passphrase.'));
        return;
      }

      const code = await provider.issueCode(params);
      const location = new URL(params.redirect_uri);
      location.searchParams.set('code', code);
      if (params.state) location.searchParams.set('state', params.state);
      log.info(`issued authorization code to ${client.client_name ?? client.client_id}`);
      res.redirect(302, location.toString());
    } catch (error) {
      oauthErrorResponse(res, error);
    }
  });

  router.post('/oauth/token', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grantType = asString(body.grant_type);

      // RFC 6749 §2.3: a client must not use more than one authentication method. Silently
      // letting the body win over the Basic header would mean the two disagree without
      // anyone noticing, so a mismatch is refused instead.
      const bodyClientId = asString(body.client_id);
      const basic = basicAuthClientId(req);
      if (bodyClientId && basic && bodyClientId !== basic.id) {
        throw new OAuthError(
          'invalid_request',
          'client_id in the request body does not match the Basic authorization credentials',
        );
      }

      const clientId = bodyClientId ?? basic?.id ?? '';
      const clientSecret = asString(body.client_secret) ?? basic?.secret;

      if (grantType === 'authorization_code') {
        const code = asString(body.code);
        const verifier = asString(body.code_verifier);
        if (!code || !verifier) {
          throw new OAuthError('invalid_request', 'code and code_verifier are required');
        }
        res.json(
          await provider.exchangeAuthorizationCode({
            code,
            clientId,
            clientSecret,
            redirectUri: asString(body.redirect_uri),
            codeVerifier: verifier,
          }),
        );
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = asString(body.refresh_token);
        if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
        res.json(await provider.refresh(refreshToken, clientId, clientSecret));
        return;
      }

      throw new OAuthError('unsupported_grant_type', `unsupported grant_type: ${grantType ?? '(missing)'}`);
    } catch (error) {
      oauthErrorResponse(res, error);
    }
  });

  /** RFC 7009. Always 200 so a client cannot probe which tokens exist. */
  router.post('/oauth/revoke', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = asString(body.token);
      if (token) {
        await provider.revoke(token);
        log.info('revoked a token');
      }
      res.status(200).json({});
    } catch (error) {
      oauthErrorResponse(res, error);
    }
  });

  return router;
}

/** `Authorization: Basic base64(client_id:client_secret)` — RFC 6749 §2.3.1. */
function basicAuthClientId(req: Request): { id: string; secret: string } | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return undefined;
    const id = decodeURIComponent(decoded.slice(0, separator));
    const secret = decodeURIComponent(decoded.slice(separator + 1));
    return { id, secret };
  } catch {
    return undefined;
  }
}