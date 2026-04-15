import type { Context, MiddlewareHandler } from 'hono';

type Entry = { count: number; resetAt: number };

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per key per window. */
  max: number;
  /** Label used in logs and error bodies. */
  label?: string;
}

/**
 * Simple in-memory sliding-window rate limiter keyed by client IP.
 *
 * Good enough for a single instance. If you scale to multiple instances,
 * move state to a shared store (Redis, Fly's Upstash, etc.).
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { windowMs, max, label = 'rate' } = options;
  const buckets = new Map<string, Entry>();

  let lastSweep = Date.now();
  const SWEEP_INTERVAL = 60_000;

  return async (c, next) => {
    const now = Date.now();

    // Opportunistic cleanup of expired entries. Cheap and bounded because
    // total keys at steady state are bounded by unique-IPs-per-minute.
    if (now - lastSweep > SWEEP_INTERVAL) {
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) buckets.delete(k);
      }
      lastSweep = now;
    }

    const key = getClientIp(c);
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (existing.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      console.warn(`[rate-limit:${label}] blocked ${key} (${existing.count}/${max})`);
      return c.json(
        { error: 'Too many requests', retryAfter },
        429
      );
    }

    existing.count++;
    return next();
  };
}

function getClientIp(c: Context): string {
  // Fly.io sets Fly-Client-IP; generic proxies set X-Forwarded-For.
  const fly = c.req.header('fly-client-ip');
  if (fly) return fly;
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}
