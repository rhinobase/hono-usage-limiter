import type {
  UsageBucket,
  UsageBucketProvisionOptions,
  UsageDeductResult,
  UsagePaginatedLedger,
  UsageStore,
  UsageTryDeductResult,
} from "./types";

/**
 * Minimal key/value cache contract used by {@link CachedUsageStore}.
 *
 * Implement this over whatever cache you have — the Cloudflare Cache API,
 * an in-memory `Map`, an LRU, Redis, `unstorage`, etc. All operations are
 * expected to be best-effort: the store swallows cache errors and falls back
 * to the underlying {@link UsageStore}, so an implementation may throw or
 * reject freely on failure.
 */
export interface UsageCache {
  /** Return the cached value for `key`, or `null`/`undefined` if absent. */
  get(
    key: string,
  ): Promise<string | null | undefined> | string | null | undefined;
  /** Cache `value` under `key`, expiring after `ttlSeconds`. */
  set(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<unknown> | unknown;
  /** Remove `key` from the cache. */
  delete(key: string): Promise<unknown> | unknown;
}

export type CachedUsageStoreOptions = {
  /** The underlying store that owns the authoritative data. */
  store: UsageStore;
  /** The cache backend. */
  cache: UsageCache;
  /**
   * How long (seconds) a bucket read may be served from cache.
   * @default 120
   */
  ttlSeconds?: number;
  /**
   * Key prefix so multiple cached stores can share one cache backend.
   * @default "usage-bucket"
   */
  prefix?: string;
};

/**
 * Wraps a {@link UsageStore} with a short-lived read-through cache over the
 * per-owner bucket read (`getBucket`).
 *
 * Reading the bucket on every request (for a `check()` gate) is often the
 * hottest path and, on a remote store, the slowest. The balance only changes on
 * a write, so this caches the bucket for a short TTL and keeps the cached copy
 * in step by writing the post-write bucket back into the cache instead of
 * invalidating (which would force a re-read on every request in a burst).
 *
 * Safety: all writes (`deduct`, `tryDeduct`, `updateBucket`, `refillWindow`,
 * `createBucket`) go straight to the underlying store — the authoritative data
 * is never served from cache. Only `getBucket` (and therefore the soft
 * `check()` gate) can read a value up to `ttlSeconds` stale. Every cache op is
 * best-effort and falls back to the underlying store on error.
 *
 * @example
 * ```ts
 * import { CachedUsageStore } from "hono-usage-limiter/cache";
 * import { D1Store } from "hono-usage-limiter/d1";
 *
 * const store = new CachedUsageStore({
 *   store: new D1Store({ db: env.DB }),
 *   cache: {
 *     get: (k) => myCache.get(k),
 *     set: (k, v, ttl) => myCache.set(k, v, ttl),
 *     delete: (k) => myCache.delete(k),
 *   },
 *   ttlSeconds: 120,
 * });
 * ```
 */
export class CachedUsageStore implements UsageStore {
  private readonly store: UsageStore;
  private readonly cache: UsageCache;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(options: CachedUsageStoreOptions) {
    this.store = options.store;
    this.cache = options.cache;
    this.ttlSeconds = options.ttlSeconds ?? 120;
    this.prefix = options.prefix ?? "usage-bucket";
  }

  private key(ownerId: string): string {
    return `${this.prefix}:${ownerId}`;
  }

  private async readCache(ownerId: string): Promise<UsageBucket | null> {
    try {
      const cached = await this.cache.get(this.key(ownerId));
      if (cached) return JSON.parse(cached) as UsageBucket;
    } catch {
      // Miss / malformed / cache error — fall through to the store.
    }
    return null;
  }

  private async writeCache(bucket: UsageBucket): Promise<void> {
    try {
      await this.cache.set(
        this.key(bucket.ownerId),
        JSON.stringify(bucket),
        this.ttlSeconds,
      );
    } catch {
      // Best-effort — a failed cache write just means the next read misses.
    }
  }

  private async dropCache(ownerId: string): Promise<void> {
    try {
      await this.cache.delete(this.key(ownerId));
    } catch {
      // Best-effort.
    }
  }

  async getBucket(ownerId: string): Promise<UsageBucket | null> {
    const cached = await this.readCache(ownerId);
    if (cached) return cached;

    const bucket = await this.store.getBucket(ownerId);
    if (bucket) await this.writeCache(bucket);
    return bucket;
  }

  async createBucket(
    ownerId: string,
    options: UsageBucketProvisionOptions,
  ): Promise<UsageBucket> {
    const bucket = await this.store.createBucket(ownerId, options);
    await this.writeCache(bucket);
    return bucket;
  }

  async updateBucket(
    bucketId: string,
    updates: Partial<
      Pick<
        UsageBucket,
        | "usageRemaining"
        | "usageLimit"
        | "windowStart"
        | "totalConsumed"
        | "lastConsumedAt"
        | "updatedAt"
      >
    >,
  ): Promise<UsageBucket> {
    const bucket = await this.store.updateBucket(bucketId, updates);
    await this.writeCache(bucket);
    return bucket;
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult> {
    // Always deduct against the authoritative store — never cached.
    const result = await this.store.deduct(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );
    await this.syncAfterWrite(ownerId, amount, result.remaining, true);
    return result;
  }

  async tryDeduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTryDeductResult> {
    const result = await this.store.tryDeduct(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );
    await this.syncAfterWrite(
      ownerId,
      amount,
      result.remaining,
      result.success,
    );
    return result;
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger> {
    // History is always read straight from the store — never cached.
    return this.store.getLedger(bucketId, cursor, limit);
  }

  async refillWindow(
    bucketId: string,
    expectedWindowStart: number,
    newWindowStart: number,
  ): Promise<UsageBucket> {
    if (!this.store.refillWindow) {
      throw new Error("Underlying store does not implement refillWindow");
    }
    const bucket = await this.store.refillWindow(
      bucketId,
      expectedWindowStart,
      newWindowStart,
    );
    await this.writeCache(bucket);
    return bucket;
  }

  /**
   * Keep the cached balance in step with an applied write. We patch the cached
   * bucket in place (rather than invalidate) so a burst of requests stays warm
   * instead of re-reading the store after every write. When the deduction was
   * refused nothing changed, so we leave the cache untouched.
   */
  private async syncAfterWrite(
    ownerId: string,
    amount: number,
    remaining: number,
    applied: boolean,
  ): Promise<void> {
    if (!applied) return;
    const cached = await this.readCache(ownerId);
    if (!cached) return;
    const now = Date.now();
    await this.writeCache({
      ...cached,
      usageRemaining: remaining,
      totalConsumed: cached.totalConsumed + amount,
      lastConsumedAt: now,
      updatedAt: now,
    });
  }
}
