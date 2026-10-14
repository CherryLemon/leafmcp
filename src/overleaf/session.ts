/**
 * Owns the authenticated Overleaf client.
 *
 * Two things worth knowing about the shape of this file:
 *
 * 1. `OverleafClient` is stateless per request but its *construction* performs a network
 *    round trip (it scrapes a CSRF token off /project), so it is built lazily and cached.
 * 2. Overleaf invalidates session cookies on a schedule. When that happens every tool
 *    would start failing with an opaque 403. So the first request that looks like an auth
 *    failure tears down the cached client and rebuilds it once — using saved email/password
 *    to re-login when the deployment is self-hosted and has them.
 */

// First import, deliberately: it redirects the Overleaf client's config directory, and ESM
// evaluates imports in declaration order — so this has run by the time the line below is
// evaluated. See bootstrap.ts for the failure this prevents.
import '../bootstrap.js';

import { OverleafClient } from '@aloth/olcli';
import type { OverleafCreds } from '../config.js';
import { ToolError, errorMessage } from '../util/errors.js';
import { log } from '../util/logger.js';

/** Heuristics for "the cookie died", kept narrow so we never retry a real 404 forever. */
function looksLikeAuthFailure(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  return (
    /\b(401|403)\b/.test(text) ||
    text.includes('not logged in') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('session expired') ||
    text.includes('login')
  );
}

export class OverleafSession {
  private client: OverleafClient | null = null;
  private inflight: Promise<OverleafClient> | null = null;

  constructor(private readonly creds: OverleafCreds) {}

  get baseUrl(): string {
    return this.creds.baseUrl;
  }

  /** True when we have *some* credential configured; not a liveness check. */
  get configured(): boolean {
    return Boolean(this.creds.session || (this.creds.email && this.creds.password));
  }

  private async build(): Promise<OverleafClient> {
    if (this.creds.session) {
      try {
        return await OverleafClient.fromSessionCookie(
          this.creds.session,
          this.creds.baseUrl,
          this.creds.cookieName,
        );
      } catch (error) {
        if (!this.creds.email || !this.creds.password) {
          throw new ToolError(
            `Overleaf rejected the configured session cookie: ${errorMessage(error)}`,
            'Re-copy OVERLEAF_SESSION from your browser: DevTools → Application → Cookies → ' +
              `${this.creds.cookieName}. The value changes every time you log out or the session expires.`,
          );
        }
        log.warn('session cookie rejected, falling back to password login');
      }
    }

    if (this.creds.email && this.creds.password) {
      return OverleafClient.fromPasswordLogin(
        this.creds.email,
        this.creds.password,
        this.creds.baseUrl,
      );
    }

    throw new ToolError(
      'no Overleaf credentials configured',
      'Set OVERLEAF_SESSION (recommended) or OVERLEAF_EMAIL + OVERLEAF_PASSWORD.',
    );
  }

  async get(): Promise<OverleafClient> {
    if (this.client) return this.client;
    // Collapse concurrent first-calls into a single bootstrap round trip.
    this.inflight ??= this.build()
      .then((client) => {
        this.client = client;
        return client;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Run an operation, rebuilding the client once if the first attempt looks like an auth failure. */
  async run<T>(operation: (client: OverleafClient) => Promise<T>): Promise<T> {
    const client = await this.get();
    try {
      return await operation(client);
    } catch (error) {
      if (!looksLikeAuthFailure(error)) throw error;
      log.warn(`overleaf call failed, rebuilding session and retrying once: ${errorMessage(error)}`);
      this.client = null;
      const fresh = await this.get();
      return operation(fresh);
    }
  }
}