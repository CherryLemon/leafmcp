/**
 * The HTTP surface: OAuth endpoints, discovery metadata, and the MCP endpoint itself.
 *
 * Two deliberate choices worth stating:
 *
 *  - **Stateless MCP.** A fresh `McpServer` is built per request and torn down when the
 *    response closes. The clients of a remote MCP server are clouds, not a single session:
 *    Gemini, Claude and ChatGPT may all call concurrently, and a session-scoped server
 *    would leak one client's project selection into another's request.
 *  - **JSON responses by default.** Streamable HTTP permits either a JSON body or an SSE
 *    stream; a self-hosted deployment sits behind a reverse proxy, and JSON is immune to
 *    the buffering and idle-timeout problems that make SSE fail there.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { AppConfig } from '../config.js';
import type { OAuthProvider } from '../auth/provider.js';
import type { OAuthStore } from '../auth/store.js';
import { createAuthRouter } from '../auth/routes.js';
import { mayWrite, readPrincipal, requireBearer } from '../auth/middleware.js';
import { ProjectRegistry, WorkspaceManager } from '../overleaf/registry.js';
import { OverleafSession } from '../overleaf/session.js';
import { ALL_TOOLS, SERVER_INSTRUCTIONS, registerTools } from '../tools/index.js';
import { rateLimit } from '../util/ratelimit.js';
import { errorMessage } from '../util/errors.js';
import { log } from '../util/logger.js';

export interface HttpDependencies {
  config: AppConfig;
  provider: OAuthProvider;
  store: OAuthStore;
}

const SERVER_NAME = 'overleaf-mcp';
const SERVER_VERSION = '0.1.0';

/** Conservative ceiling on a single JSON-RPC request body. */
const BODY_LIMIT = '4mb';

function buildServer(ctx: Parameters<typeof registerTools>[1]): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, ctx);
  return server;
}

export function createHttpApp(deps: HttpDependencies): Express {
  const { config, provider, store } = deps;
  const app = express();

  // Behind the operator's reverse proxy the client address lives in X-Forwarded-For, so the
// rate limiter needs this to bucket per real client instead of lumping the whole internet
// together. It is a hop count rather than `true` for a reason — see AppConfig.trustProxy.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  const session = new OverleafSession(config.overleaf);
  const registry = new ProjectRegistry(session, config);
  const workspaces = new WorkspaceManager(config);

  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      project: config.defaultProject ?? null,
      overleaf: config.overleaf.baseUrl,
      credentialsConfigured: session.configured,
      authMode: config.auth.mode,
      tools: ALL_TOOLS.length,
    });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(landingPage(config, provider));
  });

  // The OAuth endpoints only exist when this server actually issues tokens. Mounting them in
  // `bearer` mode would expose a consent flow whose passphrase may never have been
  // configured at all — an easy way to hand out access nobody asked for.
  if (config.auth.mode === 'oauth') {
    // Every one of these is reachable without credentials, so each gets its own budget.
    app.use('/oauth/register', rateLimit({ windowMs: 60_000, max: 10 }));
    app.use('/oauth/token', rateLimit({ windowMs: 60_000, max: 30 }));
    // The consent screen is the one endpoint where guessing a secret pays off, so it is
    // throttled as well; otherwise the operator passphrase can be brute-forced at full speed.
    app.use('/oauth/authorize', rateLimit({ windowMs: 60_000, max: 15 }));
    app.use(createAuthRouter({ provider }));
  }

  const guard = requireBearer(provider, config.auth.mode, config.allowAnonymousWrite);

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    const principal = readPrincipal(req);
    const readOnly = config.readOnly || !mayWrite(principal);

    const server = buildServer({ config, session, registry, workspaces, readOnly });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: config.jsonResponses,
    });

    // Tear down per-request state even if the client vanishes mid-call, otherwise a long
    // run of abandoned requests leaks a server object each.
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      (req as Request & { auth?: unknown }).auth = principal
        ? { token: 'redacted', clientId: principal.clientId, scopes: principal.scopes }
        : undefined;
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log.error(`MCP request failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
    }
  };

  app.post('/mcp', guard, (req, res) => {
    void handleMcp(req, res);
  });

  // The spec lets a server answer a bare GET with 405 when it offers no server-initiated
  // stream. Saying so explicitly is friendlier than a 404, which clients read as "wrong URL".
  const methodNotAllowed = (req: Request, res: Response): void => {
    res.set('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: `method ${req.method} is not supported; use POST` },
      id: null,
    });
  };
  app.get('/mcp', guard, methodNotAllowed);
  app.delete('/mcp', guard, methodNotAllowed);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Anything the handlers did not catch would otherwise kill the process on an unhandled
// rejection during a long tool call.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Body-parser rejects malformed JSON with a 400-tagged error; reporting that as a 500
    // would send a client hunting for a server fault that does not exist.
    const status = (error as { status?: number; statusCode?: number } | null)?.status
      ?? (error as { statusCode?: number } | null)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      if (!res.headersSent) {
        res.status(status).json({
          jsonrpc: '2.0',
          error: { code: -32700, message: errorMessage(error) },
          id: null,
        });
      }
      return;
    }
    log.error('unhandled request error', error);
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });

  void store.load();
  return app;
}

function landingPage(config: AppConfig, provider: OAuthProvider): string {
  const metadata = provider.protectedResourceMetadata();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overleaf MCP</title>
<style>
 body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:38rem;
      margin:9vh auto;padding:0 1.25rem;color-scheme:light dark}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;
      background:rgba(127,127,127,.14);padding:.12em .38em;border-radius:.3em}
 h1{font-size:1.35rem} .muted{opacity:.7} li{margin:.3rem 0}
</style></head>
<body>
  <h1>Overleaf MCP server</h1>
  <p class="muted">A remote MCP server that lets an assistant read and edit your Overleaf
  projects. It is running.</p>
  <ul>
    <li>MCP endpoint: <code>${config.publicUrl}/mcp</code></li>
    <li>Discovery: <code>/.well-known/oauth-protected-resource</code></li>
    <li>Health: <code>/healthz</code></li>
    <li>Auth mode: <code>${config.auth.mode}</code></li>
    <li>Read-only: <code>${config.readOnly ? 'yes' : 'no'}</code></li>
    <li>Auto-publish edits: <code>${config.autoPush ? 'yes' : 'no'}</code></li>
  </ul>
  <p class="muted">Resource identifier: <code>${String(metadata.resource)}</code></p>
</body></html>`;
}