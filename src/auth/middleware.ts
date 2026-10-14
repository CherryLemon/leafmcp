/**
 * Bearer-token enforcement for the MCP endpoint.
 *
 * The 401 body and header matter more than they look: `WWW-Authenticate` pointing at the
 * protected-resource metadata is the *only* way a client discovers it should start an OAuth
 * flow. Without it, Gemini/Claude/ChatGPT report "not a valid MCP server" instead of
 * prompting the user to authorize.
 */

import type { NextFunction, Request, Response } from 'express';

import type { AuthMode } from '../config.js';
import { SCOPE_WRITE } from './provider.js';
import type { OAuthProvider, Principal } from './provider.js';
import { log } from '../util/logger.js';

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

export function readPrincipal(req: Request): Principal | undefined {
  return (req as AuthenticatedRequest).principal;
}

function unauthorized(res: Response, provider: OAuthProvider, reason: string): void {
  // `error="invalid_token"` only once a token was actually presented (RFC 6750 §3.1).
  res.set('WWW-Authenticate', provider.challenge(reason || undefined));
  res.status(401).json({
    error: 'invalid_token',
    error_description: 'A valid bearer token is required to use this MCP server.',
  });
}

export function requireBearer(provider: OAuthProvider, mode: AuthMode, allowAnonymousWrite = false) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (mode === 'none') {
      // Read-only unless the operator explicitly opted in. An unauthenticated endpoint that
      // can edit is a footgun, and the default should not be the dangerous one.
      (req as AuthenticatedRequest).principal = {
        clientId: 'anonymous',
        scopes: allowAnonymousWrite ? ['overleaf.read', SCOPE_WRITE] : ['overleaf.read'],
      };
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      unauthorized(res, provider, '');
      return;
    }
    const token = header.slice(7).trim();
    if (token === '') {
      unauthorized(res, provider, '');
      return;
    }

    try {
      const principal = await provider.authenticate(token);
      if (!principal) {
        log.warn(`rejected unknown bearer token from ${req.ip ?? 'unknown'}`);
        unauthorized(res, provider, 'invalid_token');
        return;
      }
      (req as AuthenticatedRequest).principal = principal;
      next();
    } catch (error) {
      log.error('bearer authentication failed', error);
      res.status(500).json({ error: 'server_error' });
    }
  };
}

/** True when the request may mutate Overleaf. */
export function mayWrite(principal: Principal | undefined): boolean {
  if (!principal) return false;
  if (principal.staticToken) return true;
  return principal.scopes.includes(SCOPE_WRITE);
}