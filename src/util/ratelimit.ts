/**
 * A minimal fixed-window rate limiter.
 *
 * The endpoints that need this are the ones an attacker can reach without credentials:
 * dynamic client registration and the token endpoint. The goal is not precise shaping, it
 * is that a public endpoint cannot be used to fill the disk with client registrations.
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
}

export function rateLimit(options: RateLimitOptions) {
  const windows = new Map<string, Window>();

  // Opportunistic sweep so a long-running process does not accumulate keys forever.
  const sweep = (now: number): void => {
    if (windows.size < 1000) return;
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    sweep(now);

    const current = windows.get(key);
    if (!current || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > options.max) {
      const retryAfter = Math.ceil((current.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'temporarily_unavailable',
        error_description: `too many requests; retry in ${retryAfter}s`,
      });
      return;
    }
    next();
  };
}