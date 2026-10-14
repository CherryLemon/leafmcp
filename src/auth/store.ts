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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  /** Refresh tokens are rotated: the old one is dropped the moment it is redeemed. */
  parent?: string;
}

interface StoreShape {
  clients: Record<string, OAuthClient>;
  codes: Record<string, AuthCode>;
  tokens: Record<string, TokenRecord>;
}

const EMPTY: StoreShape = { clients: {}, codes: {}, tokens: {} };

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
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }

  private prune(): void {
    const now = Date.now();
    for (const [code, record] of Object.entries(this.data.codes)) {
      if (record.expires_at <= now) delete this.data.codes[code];
    }
    for (const [token, record] of Object.entries(this.data.tokens)) {
      if (record.expires_at <= now) delete this.data.tokens[token];
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
   * Atomically consume a token, returning it to exactly one caller.
   *
   * The delete happens synchronously after the (single) `await this.load()`, before any
   * further suspension point, so two concurrent refreshes holding the same token cannot
   * both proceed. A read-then-delete across separate awaits would let both mint new tokens
   * from one credential.
   */
  async claimToken(token: string): Promise<TokenRecord | undefined> {
    await this.load();
    const record = this.data.tokens[token];
    if (!record) return undefined;
    delete this.data.tokens[token];
    await this.persist();
    return record.expires_at > Date.now() ? record : undefined;
  }

  async deleteToken(token: string): Promise<void> {
    await this.load();
    if (this.data.tokens[token]) {
      delete this.data.tokens[token];
      await this.persist();
    }
  }

  /** Drop a refresh token and everything minted from it (rotation hygiene). */
  async revokeFamily(refreshToken: string): Promise<void> {
    await this.load();
    let changed = false;
    for (const [token, record] of Object.entries(this.data.tokens)) {
      if (token === refreshToken || record.parent === refreshToken) {
        delete this.data.tokens[token];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }
}