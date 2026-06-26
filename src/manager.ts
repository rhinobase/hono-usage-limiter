import type {
  BalanceInfo,
  BucketProvisionOptions,
  CreditBucket,
  CreditManagerConfig,
  CreditStatus,
  CreditStore,
  DeductResult,
  PaginatedLedger,
} from "./types";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export class CreditManager {
  private store: CreditStore;
  private defaultCredits: number;
  private defaultWindowMs: number;
  private autoProvision: boolean;
  private bucket: CreditBucket | null = null;
  private ownerId: string;

  constructor(
    ownerId: string,
    config: Omit<CreditManagerConfig, "keyGenerator">,
  ) {
    this.ownerId = ownerId;
    this.store = config.store;
    this.defaultCredits = config.defaultCredits ?? 1000;
    this.defaultWindowMs = config.defaultWindowMs ?? THIRTY_DAYS_MS;
    this.autoProvision = config.autoProvision ?? true;
  }

  /**
   * Ensures the bucket is loaded and the window is current.
   * If the bucket doesn't exist and autoProvision is enabled, creates one.
   */
  private async resolveBucket(): Promise<CreditBucket> {
    if (!this.bucket) {
      this.bucket = await this.store.getBucket(this.ownerId);
    }

    if (!this.bucket) {
      if (!this.autoProvision) {
        throw new Error(`No credit bucket found for owner "${this.ownerId}"`);
      }
      this.bucket = await this.store.createBucket(this.ownerId, {
        creditsLimit: this.defaultCredits,
        windowDurationMs: this.defaultWindowMs,
      });
    }

    // Auto-refill: if the window has expired, reset the bucket
    const windowEnd =
      this.bucket.windowStart + this.bucket.windowDurationMs;
    if (Date.now() >= windowEnd) {
      this.bucket = await this.store.updateBucket(this.bucket.id, {
        creditsRemaining: this.bucket.creditsLimit,
        windowStart: Date.now(),
        totalConsumed: 0,
        updatedAt: Date.now(),
      });
    }

    return this.bucket;
  }

  /**
   * Check current credit status.
   * Returns remaining credits, limit, and whether the owner has credits.
   */
  async check(): Promise<CreditStatus> {
    const bucket = await this.resolveBucket();
    const resetsAt = new Date(
      bucket.windowStart + bucket.windowDurationMs,
    ).toISOString();

    return {
      remaining: bucket.creditsRemaining,
      limit: bucket.creditsLimit,
      hasCredits: bucket.creditsRemaining > 0,
      resetsAt,
    };
  }

  /**
   * Deduct credits from the bucket.
   * Records a ledger entry with the reason and optional metadata.
   */
  async deduct(
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeductResult> {
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
      creditsRemaining: result.remaining,
      totalConsumed: bucket.totalConsumed + amount,
      lastConsumedAt: Date.now(),
      updatedAt: Date.now(),
    };

    return result;
  }

  /**
   * Get the full balance information for this owner.
   */
  async getBalance(): Promise<BalanceInfo> {
    const bucket = await this.resolveBucket();

    return {
      remaining: bucket.creditsRemaining,
      limit: bucket.creditsLimit,
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
  ): Promise<PaginatedLedger> {
    const bucket = await this.resolveBucket();
    return this.store.getLedger(bucket.id, cursor, limit);
  }

  /**
   * Reset the bucket: refill credits to the limit and start a new window.
   */
  async reset(): Promise<CreditBucket> {
    const bucket = await this.resolveBucket();
    this.bucket = await this.store.updateBucket(bucket.id, {
      creditsRemaining: bucket.creditsLimit,
      windowStart: Date.now(),
      totalConsumed: 0,
      updatedAt: Date.now(),
    });
    return this.bucket;
  }

  /**
   * Provision or update the bucket with new plan settings.
   * If the bucket doesn't exist, creates one.
   * If it exists, updates the credit limit (and optionally resets remaining).
   */
  async provision(
    options: BucketProvisionOptions & { resetRemaining?: boolean },
  ): Promise<CreditBucket> {
    let bucket = await this.store.getBucket(this.ownerId);

    if (!bucket) {
      bucket = await this.store.createBucket(this.ownerId, options);
      this.bucket = bucket;
      return bucket;
    }

    const updates: Parameters<CreditStore["updateBucket"]>[1] = {
      creditsLimit: options.creditsLimit,
      updatedAt: Date.now(),
    };

    if (options.resetRemaining) {
      updates.creditsRemaining = options.creditsLimit;
      updates.windowStart = Date.now();
      updates.totalConsumed = 0;
    }

    this.bucket = await this.store.updateBucket(bucket.id, updates);
    return this.bucket;
  }
}
