const WINDOW_MS = 60_000;

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * In-process fixed-window rate limiter, keyed by widget key id.
 *
 * In-memory rather than Postgres-backed: a rate limiter that itself costs a
 * database round trip per chat message defeats its own purpose, and Neon's
 * free-tier compute-suspend design (see docs/DECISIONS.md) makes an
 * always-open connection for this expensive in a different way. The tradeoff
 * is real and worth stating: state resets on process restart and is not
 * shared across multiple instances. Both are acceptable for a single-instance
 * deployment; a multi-instance one would move this to Redis.
 *
 * The limit is passed in on every call rather than fixed at creation, so a
 * widget key's configured rpm is read fresh each time — raising a client's
 * limit takes effect immediately rather than waiting out the current window.
 */
export function createRateLimiter() {
  const buckets = new Map<string, Bucket>();

  return {
    tryConsume(key: string, limit: number, now = Date.now()): boolean {
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
        buckets.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
