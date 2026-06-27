import type {
  UsageBalanceInfo,
  UsageBucketProvisionOptions,
  UsageBucket,
  UsageStatus,
  UsageStore,
  UsageDeductResult,
  UsagePaginatedLedger,
} from "./types";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Options accepted by the UsageManager constructor (store must be a resolved instance). */
export type UsageManagerOptions = {
  store: UsageStore;
  defaultUsage?: number;
  defaultWindowDurationMs?: number;
  autoProvision?: boolean;
};

export class UsageManager {
  private store: UsageStore;
  private defaultUsage: number;
  private defaultWindowDurationMs: number;
  private autoProvision: boolean;
  private bucket: UsageBucket | null = null;
  private ownerId: string;

  constructor(ownerId: string, config: UsageManagerOptions) {
    this.ownerId = ownerId;
    this.store = config.store;
    this.defaultUsage = config.defaultUsage ?? 1000;
    this.defaultWindowDurationMs = config.defaultWindowDurationMs ?? THIRTY_DAYS_MS;
    this.autoProvision = config.autoProvision ?? true;
  }

  /**
   * Ensures the bucket is loaded and the window is current.
   * If the bucket doesn't exist and autoProvision is enabled, creates one.
   */
  private async resolveBucket(): Promise<UsageBucket> {
    if (!this.bucket) {
      this.bucket = await this.store.getBucket(this.ownerId);
    }

    if (!this.bucket) {
      if (!this.autoProvision) {
        throw new Error(`No usage bucket found for owner "${this.ownerId}"`);
      }
      this.bucket = await this.store.createBucket(this.ownerId, {
        usageLimit: this.defaultUsage,
        windowDurationMs: this.defaultWindowDurationMs,
      });
    }

    // Auto-refill: if the window has expired, reset the bucket
    const windowEnd =
      this.bucket.windowStart + this.bucket.windowDurationMs;
    if (Date.now() >= windowEnd) {
      this.bucket = await this.store.updateBucket(this.bucket.id, {
        usageRemaining: this.bucket.usageLimit,
        windowStart: Date.now(),
        totalConsumed: 0,
        updatedAt: Date.now(),
      });
    }

    return this.bucket;
  }

  /**
   * Check current usage status.
   * Returns remaining usage, limit, and whether the owner has usage remaining.
   */
  async check(): Promise<UsageStatus> {
    const bucket = await this.resolveBucket();
    const resetsAt = new Date(
      bucket.windowStart + bucket.windowDurationMs,
    ).toISOString();

    return {
      remaining: bucket.usageRemaining,
      limit: bucket.usageLimit,
      hasUsage: bucket.usageRemaining > 0,
      resetsAt,
    };
  }

  /**
   * Deduct usage from the bucket.
   * Records a ledger entry with the reason and optional metadata.
   */
  async deduct(
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult> {
    if (amount <= 0 || !Number.isFinite(amount)) {
      throw new Error("Deduction amount must be a positive finite number");
    }

    const bucket = await this.resolveBucket();
    const result = await this.store.deduct(
      bucket.id,
      this.ownerId,
      amount,
      reason,
      metadata,
    );

    // Update the cached bucket
    this.bucket = {
      ...bucket,
      usageRemaining: result.remaining,
      totalConsumed: bucket.totalConsumed + amount,
      lastConsumedAt: Date.now(),
      updatedAt: Date.now(),
    };

    return result;
  }

  /**
   * Get the full balance information for this owner.
   */
  async getBalance(): Promise<UsageBalanceInfo> {
    const bucket = await this.resolveBucket();

    return {
      remaining: bucket.usageRemaining,
      limit: bucket.usageLimit,
      totalConsumed: bucket.totalConsumed,
      windowStart: new Date(bucket.windowStart).toISOString(),
      resetsAt: new Date(
        bucket.windowStart + bucket.windowDurationMs,
      ).toISOString(),
    };
  }

  /**
   * Get paginated ledger history for this owner.
   */
  async getHistory(
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger> {
    const bucket = await this.resolveBucket();
    return this.store.getLedger(bucket.id, cursor, limit);
  }

  /**
   * Reset the bucket: refill usage to the limit and start a new window.
   */
  async reset(): Promise<UsageBucket> {
    const bucket = await this.resolveBucket();
    this.bucket = await this.store.updateBucket(bucket.id, {
      usageRemaining: bucket.usageLimit,
      windowStart: Date.now(),
      totalConsumed: 0,
      updatedAt: Date.now(),
    });
    return this.bucket;
  }

  /**
   * Provision or update the bucket with new plan settings.
   * If the bucket doesn't exist, creates one.
   * If it exists, updates the usage limit (and optionally resets remaining).
   */
  async provision(
    options: UsageBucketProvisionOptions & { resetRemaining?: boolean },
  ): Promise<UsageBucket> {
    let bucket = await this.store.getBucket(this.ownerId);

    if (!bucket) {
      bucket = await this.store.createBucket(this.ownerId, options);
      this.bucket = bucket;
      return bucket;
    }

    const updates: Parameters<UsageStore["updateBucket"]>[1] = {
      usageLimit: options.usageLimit,
      updatedAt: Date.now(),
    };

    if (options.resetRemaining) {
      updates.usageRemaining = options.usageLimit;
      updates.windowStart = Date.now();
      updates.totalConsumed = 0;
    }

    this.bucket = await this.store.updateBucket(bucket.id, updates);
    return this.bucket;
  }
}
