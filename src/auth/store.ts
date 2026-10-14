/**
 * Persistence for the built-in OAuth 2.1 authorization server.
 *
 * A single JSON file is the right amount of machinery here: this server protects one
 * person's Overleaf account, so the working set is a handful of dynamically-registered
 * clients and their tokens. Anything heavier (a database, JWTs) would add moving parts
 * without removing a failure mode — and opaque tokens have the property we actually want,
 * which is that revoking one is immediate and total.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { log } from '../util/logger.js';

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
  created_at: number;
}

export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope?: string;
  resource?: string;
  expires_at: number;
}

export interface TokenRecord {
  token: string;
  kind: 'access' | 'refresh';
  client_id: string;
  scope?: string;
  resource?: string;
  expires_at: number;
  created_at: number;
  /**
   * Identifier shared by every token descended from one authorization.
   *
   * Refresh rotation only helps if a replayed token can be traced back to the grant it came
   * from, and access tokens have to be reachable from that same grant — otherwise revoking
   * the chain leaves a working access token behind, which is the opposite of the point.
   */
  family: string;
  /**
   * Refresh tokens are marked used rather than deleted.
   *
   * Deleting on use makes a replay indistinguishable from an unknown token, so the server
   * can only say "no" — it cannot notice that a credential has leaked and revoke the
   * successor tokens, which is what RFC 9700 asks for.
   */
  status?: 'active' | 'used';
}

interface StoreShape {
  clients: Record<string, OAuthClient>;
  codes: Record<string, AuthCode>;
  tokens: Record<string, TokenRecord>;
  /**
   * Grants that have been revoked, keyed by family and stamped with when.
   *
   * Deleting the tokens of a grant is not the same as revoking it. A refresh request that
   * already read its record can still be in flight when the revocation happens, and it would
   * then write fresh, valid tokens for a grant that was supposed to be dead. A recorded
   * status is what makes revocation durable: minting consults it, so a late write is refused
   * instead of resurrecting the grant.
   */
  revoked: Record<string, number>;
}

const EMPTY: StoreShape = { clients: {}, codes: {}, tokens: {}, revoked: {} };

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5m

export class OAuthStore {
  private data: StoreShape = { ...EMPTY };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      if (existsSync(this.path)) {
        const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoreShape>;
        this.data = {
          clients: parsed.clients ?? {},
          codes: parsed.codes ?? {},
          tokens: parsed.tokens ?? {},
          revoked: parsed.revoked ?? {},
        };
      }
    } catch (error) {
      log.warn(`could not read the OAuth store, starting empty: ${String(error)}`);
      this.data = { ...EMPTY };
    }
    this.loaded = true;
    this.prune();
  }

  /**
   * Serialized, atomic-ish write; concurrent tool calls must not interleave a save.
   *
   * The chain itself is kept permanently settled. Chaining directly onto the previous
   * attempt would mean one failed write (a full disk, a transient permission error) leaves
   * a rejected promise in the chain and every later save rejects too — the store would stay
   * broken long after the filesystem recovered. The caller still sees the real error.
   */
  private persist(): Promise<void> {
    const attempt = this.writeChain.then(() => this.writeNow());
    this.writeChain = attempt.catch(() => undefined);
    return attempt;
  }

  private async writeNow(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    // 0600: this file holds live access and refresh tokens, so it must not be readable by
    // anything else on the machine. The rename below carries the mode onto the final file.
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => undefined);
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, record] of Object.entries(this.data.codes)) {
      if (record.expires_at <= now) delete this.data.codes[code];
    }
    for (const [token, record] of Object.entries(this.data.tokens)) {
      if (record.expires_at <= now) delete this.data.tokens[token];
    }
    // A revocation only needs remembering for as long as a token from that grant could still
    // be presented, which is the refresh lifetime.
    for (const [family, revokedAt] of Object.entries(this.data.revoked)) {
      if (now - revokedAt > REFRESH_TOKEN_TTL_MS) delete this.data.revoked[family];
    }
  }

  async putClient(client: OAuthClient): Promise<void> {
    await this.load();
    this.data.clients[client.client_id] = client;
    await this.persist();
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    await this.load();
    return this.data.clients[clientId];
  }

  async listClients(): Promise<OAuthClient[]> {
    await this.load();
    return Object.values(this.data.clients);
  }

  async putCode(code: AuthCode): Promise<void> {
    await this.load();
    this.prune();
    this.data.codes[code.code] = code;
    await this.persist();
  }

  /** Single-use: redeeming a code deletes it, which also defeats replay. */
  async takeCode(code: string): Promise<AuthCode | undefined> {
    await this.load();
    const record = this.data.codes[code];
    if (!record) return undefined;
    delete this.data.codes[code];
    await this.persist();
    return record.expires_at > Date.now() ? record : undefined;
  }

  async putToken(record: TokenRecord): Promise<void> {
    await this.load();
    this.data.tokens[record.token] = record;
    await this.persist();
  }

  /** Synchronous on purpose: callers use it inside a critical section. */
  isGrantRevoked(family: string): boolean {
    return this.data.revoked[family] !== undefined;
  }

  async getToken(token: string): Promise<TokenRecord | undefined> {
    await this.load();
    const record = this.data.tokens[token];
    if (!record) return undefined;
    if (record.expires_at <= Date.now()) {
      delete this.data.tokens[token];
      await this.persist();
      return undefined;
    }
    return record;
  }

  /**
   * Atomically consume a refresh token, returning it to exactly one caller.
   *
   * The status flip happens synchronously after the single `await this.load()`, before any
   * further suspension point, so two concurrent refreshes holding the same token cannot both
   * proceed. A read-then-write across separate awaits would let both mint new tokens from one
   * credential.
   *
   * The record is kept (marked `used`) so a later replay is recognisable; see `TokenRecord`.
   */
  async claimToken(token: string): Promise<TokenRecord | undefined> {
    await this.load();
    const record = this.data.tokens[token];
    if (!record) return undefined;
    if (record.expires_at <= Date.now()) {
      delete this.data.tokens[token];
      await this.persist();
      return undefined;
    }
    if (record.status === 'used') return undefined;
    record.status = 'used';
    await this.persist();
    return record;
  }

  async deleteToken(token: string): Promise<void> {
    await this.load();
    if (this.data.tokens[token]) {
      delete this.data.tokens[token];
      await this.persist();
    }
  }

  /**
   * Delete every token descended from one authorization.
   *
   * This is the response to a replayed refresh token: the credential has leaked, so the
   * whole grant goes — access tokens included — and the user re-authorizes. Removing the
   * access tokens is what makes the revocation take effect immediately rather than whenever
   * the next access token happens to expire.
   */
  async revokeFamily(family: string): Promise<number> {
    await this.load();

    // Marking and deleting happen in one synchronous block, with no await between them. That
    // is what makes the outcome independent of interleaving: a concurrent mint either
    // completes first and has its records deleted here, or observes the mark and refuses.
    this.data.revoked[family] = Date.now();
    let removed = 0;
    for (const [token, record] of Object.entries(this.data.tokens)) {
      if (record.family === family) {
        delete this.data.tokens[token];
        removed += 1;
      }
    }

    await this.persist();
    return removed;
  }

  /**
   * Insert freshly minted tokens, unless the grant has been revoked.
   *
   * The check and the insertion share a synchronous block for the reason above: an in-flight
   * refresh must not be able to write tokens for a grant that was revoked while it was
   * waiting. Returns false when the grant is dead, and the caller turns that into an error.
   */
  async mintTokens(records: TokenRecord[], family: string): Promise<boolean> {
    await this.load();
    if (this.data.revoked[family] !== undefined) return false;
    for (const record of records) this.data.tokens[record.token] = record;
    await this.persist();
    return true;
  }
}