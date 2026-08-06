import type {
  UsageBucketProvisionOptions,
  UsageBucket,
  UsageStore,
  UsageDeductResult,
  UsageLedgerEntry,
  UsagePaginatedLedger,
} from "./types";

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * In-memory implementation of UsageStore.
 * Useful for testing and prototyping. Data is lost when the process exits.
 */
export class MemoryStore implements UsageStore {
  private buckets = new Map<string, UsageBucket>();
  private bucketsByOwner = new Map<string, string>();
  private ledger = new Map<string, UsageLedgerEntry[]>();

  async getBucket(ownerId: string): Promise<UsageBucket | null> {
    const bucketId = this.bucketsByOwner.get(ownerId);
    if (!bucketId) return null;
    const bucket = this.buckets.get(bucketId);
    return bucket ? { ...bucket } : null;
  }

  async createBucket(
    ownerId: string,
    options: UsageBucketProvisionOptions,
  ): Promise<UsageBucket> {
    if (this.bucketsByOwner.has(ownerId)) {
      throw new Error(
        `Usage bucket already exists for owner "${ownerId}"`,
      );
    }

    const now = Date.now();
    const bucket: UsageBucket = {
      id: generateId(),
      ownerId,
      usageRemaining: options.usageLimit,
      usageLimit: options.usageLimit,
      windowStart: now,
      windowDurationMs: options.windowDurationMs,
      totalConsumed: 0,
      lastConsumedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.buckets.set(bucket.id, bucket);
    this.bucketsByOwner.set(ownerId, bucket.id);
    this.ledger.set(bucket.id, []);

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
        | "windowDurationMs"
        | "totalConsumed"
        | "lastConsumedAt"
        | "updatedAt"
      >
    >,
  ): Promise<UsageBucket> {
    const bucket = this.buckets.get(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const updated: UsageBucket = {
      ...bucket,
      ...updates,
      updatedAt: updates.updatedAt ?? Date.now(),
    };

    this.buckets.set(bucketId, updated);
    return updated;
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult> {
    const bucket = this.buckets.get(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const now = Date.now();

    const entry: UsageLedgerEntry = {
      id: generateId(),
      bucketId,
      ownerId,
      amount,
      reason,
      metadata: metadata ?? null,
      createdAt: now,
    };

    // Update the bucket
    const remaining = bucket.usageRemaining - amount;
    const updated: UsageBucket = {
      ...bucket,
      usageRemaining: remaining,
      totalConsumed: bucket.totalConsumed + amount,
      lastConsumedAt: now,
      updatedAt: now,
    };
    this.buckets.set(bucketId, updated);

    // Add ledger entry
    const entries = this.ledger.get(bucketId) ?? [];
    entries.push(entry);
    this.ledger.set(bucketId, entries);

    return {
      success: true,
      remaining,
      entry,
    };
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit = 20,
  ): Promise<UsagePaginatedLedger> {
    const entries = this.ledger.get(bucketId) ?? [];

    // Reverse to get newest first (entries are appended in insertion order)
    const sorted = [...entries].reverse();

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = sorted.findIndex((e) => e.id === cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const page = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < sorted.length;

    return {
      entries: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
