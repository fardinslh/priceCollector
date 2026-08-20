interface RateLimitWindow {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateLimitWindow>();
  private static readonly MAX_TRACKED_KEYS = 50_000;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  consume(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.windows.size >= FixedWindowRateLimiter.MAX_TRACKED_KEYS) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey !== undefined) this.windows.delete(oldestKey);
      }
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (current.count >= this.limit) {
      return false;
    }

    current.count += 1;
    return true;
  }
}
