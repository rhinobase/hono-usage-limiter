import type {
  UsageBucket,
  UsageBucketProvisionOptions,
  UsageBucketUpdates,
  UsageCreditResult,
  UsageDeductResult,
  UsagePaginatedBuckets,
  UsagePaginatedLedger,
  UsageRolloverOptions,
  UsageStore,
  UsageTryDeductResult,
} from "./types";

/** Minimal asynchronous cache interface used by CachedUsageStore. */
export interface UsageCache {
  get<Value>(key: string): Promise<Value | null | undefined>;
  set<Value>(key: string, value: Value): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CachedUsageStoreOptions<Reason extends string = string> = {
  /** Store that remains the source of truth for all operations. */
  inner: UsageStore<Reason>;
  /** Cache used for short-lived bucket reads. */
  cache: UsageCache;
  /** Namespace used for cache keys. */
  prefix?: string;
};

function generateEpoch(): string {
  return crypto.randomUUID();
}

/**
 * UsageStore wrapper that caches bucket reads while leaving the inner store as
 * the source of truth for every mutation.
 */
export class CachedUsageStore<Reason extends string = string>
  implements UsageStore<Reason>
{
  private readonly cache: UsageCache;
  private readonly inner: UsageStore<Reason>;
  private readonly prefix: string;
  private localEpoch: string | null = null;

  constructor(options: CachedUsageStoreOptions<Reason>) {
    this.inner = options.inner;
    this.cache = options.cache;
    this.prefix = options.prefix ?? "usage-cache";
  }

  private epochKey(): string {
    return `${this.prefix}:epoch`;
  }

  private bucketKey(epoch: string, ownerId: string): string {
    return `${this.prefix}:bucket:${epoch}:${encodeURIComponent(ownerId)}`;
  }

  private async getEpoch(): Promise<string> {
    if (this.localEpoch) return this.localEpoch;

    const epoch = await this.cache.get<string>(this.epochKey());
    if (epoch !== null && epoch !== undefined) return epoch;

    const freshEpoch = generateEpoch();
    await this.cache.set(this.epochKey(), freshEpoch);
    return freshEpoch;
  }

  private async cacheBucket(epoch: string, bucket: UsageBucket): Promise<void> {
    await this.cache.set(this.bucketKey(epoch, bucket.ownerId), { ...bucket });
  }

  private async refreshBucket(epoch: string, ownerId: string): Promise<void> {
    const bucket = await this.inner.getBucket(ownerId);
    const key = this.bucketKey(epoch, ownerId);
    if (bucket) {
      await this.cache.set(key, { ...bucket });
      return;
    }
    await this.cache.delete(key);
  }

  async getBucket(ownerId: string): Promise<UsageBucket | null> {
    const epoch = await this.getEpoch();
    const key = this.bucketKey(epoch, ownerId);
    const cached = await this.cache.get<UsageBucket>(key);
    if (cached !== null && cached !== undefined) return { ...cached };

    const bucket = await this.inner.getBucket(ownerId);
    if (bucket) await this.cacheBucket(epoch, bucket);
    return bucket;
  }

  async createBucket(
    ownerId: string,
    options: UsageBucketProvisionOptions,
  ): Promise<UsageBucket> {
    const epoch = await this.getEpoch();
    const bucket = await this.inner.createBucket(ownerId, options);
    await this.cacheBucket(epoch, bucket);
    return bucket;
  }

  async updateBucket(
    bucketId: string,
    updates: UsageBucketUpdates,
  ): Promise<UsageBucket> {
    const epoch = await this.getEpoch();
    const bucket = await this.inner.updateBucket(bucketId, updates);
    await this.cacheBucket(epoch, bucket);
    return bucket;
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult<Reason>> {
    const epoch = await this.getEpoch();
    const deduction = await this.inner.deduct(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );
    await this.refreshBucket(epoch, ownerId);
    return deduction;
  }

  async tryDeduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTryDeductResult<Reason>> {
    const epoch = await this.getEpoch();
    const deduction = await this.inner.tryDeduct(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );
    await this.refreshBucket(epoch, ownerId);
    return deduction;
  }

  async credit(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageCreditResult<Reason>> {
    const epoch = await this.getEpoch();
    const credit = await this.inner.credit(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );
    await this.refreshBucket(epoch, ownerId);
    return credit;
  }

  async rolloverWindow(
    bucketId: string,
    expectedWindowStart: number,
    options: UsageRolloverOptions,
  ): Promise<UsageBucket> {
    const epoch = await this.getEpoch();
    const bucket = await this.inner.rolloverWindow(
      bucketId,
      expectedWindowStart,
      options,
    );
    await this.cacheBucket(epoch, bucket);
    return bucket;
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger<Reason>> {
    return this.inner.getLedger(bucketId, cursor, limit);
  }

  async resetAll(): Promise<number> {
    let count: number | undefined;
    let resetFailure: unknown;
    try {
      count = await this.inner.resetAll();
    } catch (error) {
      resetFailure = error;
    }

    const nextEpoch = generateEpoch();
    this.localEpoch = nextEpoch;
    let invalidationFailure: unknown;
    try {
      await this.cache.set(this.epochKey(), nextEpoch);
      if (this.localEpoch === nextEpoch) this.localEpoch = null;
    } catch (error) {
      invalidationFailure = error;
    }

    if (resetFailure !== undefined) {
      if (invalidationFailure !== undefined) {
        throw new AggregateError(
          [resetFailure, invalidationFailure],
          "Usage reset and cache invalidation both failed",
        );
      }
      throw resetFailure;
    }
    if (invalidationFailure !== undefined) {
      throw new Error("Usage reset succeeded, but cache invalidation failed", {
        cause: invalidationFailure,
      });
    }

    return count as number;
  }

  async listBuckets(
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedBuckets> {
    return this.inner.listBuckets(cursor, limit);
  }
}
