/**
 * A bounded fixed-window rate limiter.
 *
 * Two failure modes shape this design, both raised in review of the first version:
 *
 *  - **Unbounded keys.** One bucket per client address with no ceiling means an anonymous
 *    caller can grow the map without limit by rotating addresses, and the "cleanup" ran a
 *    full scan on every request once the map was large — so the defence became the attack.
 *    The map is now capped and expired entries are dropped from the front, which is O(1)
 *    amortised because keys are inserted in expiry order.
 *
 *  - **Evicting to make room.** Freeing the oldest bucket when full is the obvious fix and it
 *    is wrong: an attacker who keeps presenting new addresses evicts the buckets recording
 *    their own abuse and starts fresh. Instead, once the cap is reached, further unknown keys
 *    share one overflow budget — legitimate clients are unaffected because they already have
 *    a bucket, and a flood is throttled as a single group rather than resetting everyone.
 */

import type { NextFunction, Request, Response } from 'express';

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Permitted requests per window per client. */
  max: number;
  /** Maximum number of distinct clients tracked; beyond this, one shared bucket is used. */
  maxKeys?: number;
  /** Requests allowed per window across all clients that did not get their own bucket. */
  overflowMax?: number;
}

const DEFAULT_MAX_KEYS = 10_000;
const DEFAULT_OVERFLOW_MAX = 50;

/** The key used for every client that arrives once the table is full. */
const OVERFLOW_KEY = '\u0000overflow';

export function rateLimit(options: RateLimitOptions) {
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const overflowMax = options.overflowMax ?? DEFAULT_OVERFLOW_MAX;
  const windows = new Map<string, Window>();

  const tooMany = (res: Response, window: Window, now: number): void => {
    const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'temporarily_unavailable',
      error_description: `too many requests; retry in ${retryAfter}s`,
    });
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    // Entries are inserted with `resetAt = now + windowMs`, so the map is ordered by expiry
    // and the front is always the first to go. This is O(1) amortised rather than the full
    // scan the previous version ran on every request once it grew.
    for (const [key, window] of windows) {
      if (window.resetAt > now) break;
      windows.delete(key);
    }

    const address = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = windows.has(address) || windows.size < maxKeys ? address : OVERFLOW_KEY;
    const limit = key === OVERFLOW_KEY ? overflowMax : options.max;

    const current = windows.get(key);
    if (!current || current.resetAt <= now) {
      // Re-inserting moves the key to the back, keeping insertion order aligned with expiry.
      if (windows.has(key)) windows.delete(key);
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > limit) {
      tooMany(res, current, now);
      return;
    }
    next();
  };
}