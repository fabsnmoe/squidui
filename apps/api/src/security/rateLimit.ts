/**
 * In-process sliding window rate limiter.
 *
 * Deliberately not backed by Redis: it guards credential endpoints of a single
 * API process, and a limiter that fails open when Redis is down would be worse
 * than one that is per-process. When the API is scaled horizontally this needs
 * to move to a shared store - tracked in docs/status.md.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitDecision {
    const windowStart = now - this.windowMs;
    const previous = this.hits.get(key) ?? [];
    const recent = previous.filter((timestamp) => timestamp > windowStart);

    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      this.hits.set(key, recent);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: this.limit - recent.length, retryAfterSeconds: 0 };
  }

  /** Called after a successful login so a legitimate user is not punished. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Drops empty buckets; called periodically so the map cannot grow forever. */
  sweep(now = Date.now()): void {
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((timestamp) => timestamp > windowStart);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
