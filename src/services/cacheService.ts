/**
 * In-Memory TTL Cache for storing scraping results and API responses.
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class MemoryCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private defaultTtlMs: number;

  /**
   * @param defaultTtlSeconds Default time-to-live in seconds (defaults to 15 minutes = 900s)
   */
  constructor(defaultTtlSeconds: number = 15 * 60) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;

    // Periodically evict expired items every 5 minutes
    if (typeof setInterval !== 'undefined') {
      const interval = setInterval(() => {
        this.cleanup();
      }, 5 * 60 * 1000);
      
      // Unref to prevent keeping process alive during shutdown
      if (interval && typeof interval === 'object' && 'unref' in interval) {
        interval.unref();
      }
    }
  }

  /**
   * Normalizes search key for case-insensitive and whitespace-invariant lookups.
   */
  private normalizeKey(key: string): string {
    return key.trim().toLowerCase();
  }

  /**
   * Retrieve cached value if present and not expired.
   */
  get(key: string): T | null {
    const normalizedKey = this.normalizeKey(key);
    const entry = this.cache.get(normalizedKey);

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(normalizedKey);
      return null;
    }

    return entry.data;
  }

  /**
   * Store data in cache with an optional custom TTL.
   */
  set(key: string, data: T, ttlSeconds?: number): void {
    const normalizedKey = this.normalizeKey(key);
    const ttlMs = ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtlMs;

    this.cache.set(normalizedKey, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Check if a valid entry exists in cache.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Evict a single entry.
   */
  delete(key: string): boolean {
    return this.cache.delete(this.normalizeKey(key));
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Total number of cached items.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clean up all expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

// Global price comparison cache instance with 15-minute TTL
export const priceCache = new MemoryCache<any>(15 * 60);
