import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/modules/widget-keys/rate-limiter.ts';

describe('createRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) expect(limiter.tryConsume('k1', 3)).toBe(true);
  });

  it('rejects the request once the limit is reached', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) limiter.tryConsume('k1', 3);
    expect(limiter.tryConsume('k1', 3)).toBe(false);
  });

  it('tracks each key independently', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) limiter.tryConsume('k1', 3);
    expect(limiter.tryConsume('k2', 3)).toBe(true);
  });

  it('resets the window after it elapses', () => {
    vi.useFakeTimers();
    try {
      const limiter = createRateLimiter();
      for (let i = 0; i < 3; i++) limiter.tryConsume('k1', 3);
      expect(limiter.tryConsume('k1', 3)).toBe(false);

      vi.advanceTimersByTime(61_000);
      expect(limiter.tryConsume('k1', 3)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an in-progress window\'s limit change take effect immediately', () => {
    // A key's rpm is read fresh from its row on every call, so an admin
    // raising a client's limit does not require waiting out the old window.
    const limiter = createRateLimiter();
    expect(limiter.tryConsume('k1', 1)).toBe(true);
    expect(limiter.tryConsume('k1', 1)).toBe(false);
    expect(limiter.tryConsume('k1', 5)).toBe(true);
  });
});
