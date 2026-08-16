import { normalizePageLimit } from "./pagination";
import type {
  UsageBucket,
  UsageBucketProvisionOptions,
  UsageBucketUpdates,
  UsageCreditResult,
  UsageDeductResult,
  UsageLedgerEntry,
  UsagePaginatedBuckets,
  UsagePaginatedLedger,
  UsageRolloverOptions,
  UsageStore,
  UsageTryDeductResult,
} from "./types";

function generateId(): string {
  return crypto.randomUUID();
}

function assertPositiveFiniteAmount(amount: number, operation: string): void {
  if (amount <= 0 || !Number.isFinite(amount)) {
    throw new Error(`${operation} amount must be a positive finite number`);
  }
}

/**
 * In-memory implementation of UsageStore.
 * Useful for testing and prototyping. Data is lost when the process exits.
 */
export class MemoryStore<Reason extends string = string>
  implements UsageStore<Reason>
{
  private buckets = new Map<string, UsageBucket>();
  private bucketsByOwner = new Map<string, string>();
  private ledger = new Map<string, UsageLedgerEntry<Reason>[]>();

  private appendLedgerEntry(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): UsageLedgerEntry<Reason> {
    const entry: UsageLedgerEntry<Reason> = {
      id: generateId(),
      bucketId,
      ownerId,
      amount,
      reason,
      metadata: metadata ?? null,
      createdAt: Date.now(),
    };
    const entries = this.ledger.get(bucketId) ?? [];
    entries.push(entry);
    this.ledger.set(bucketId, entries);
    return entry;
  }

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
      throw new Error(`Usage bucket already exists for owner "${ownerId}"`);
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

    return { ...bucket };
  }

  async updateBucket(
    bucketId: string,
    updates: UsageBucketUpdates,
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
    return { ...updated };
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult<Reason>> {
    const bucket = this.buckets.get(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const entry = this.appendLedgerEntry(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );
    const remaining = bucket.usageRemaining - amount;
    this.buckets.set(bucketId, {
      ...bucket,
      usageRemaining: remaining,
      totalConsumed: bucket.totalConsumed + amount,
      lastConsumedAt: entry.createdAt,
      updatedAt: entry.createdAt,
    });

    return { success: true, remaining, entry };
  }

  async tryDeduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTryDeductResult<Reason>> {
    assertPositiveFiniteAmount(amount, "Deduction");
    const bucket = this.buckets.get(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }
    if (bucket.usageRemaining < amount) {
      return { success: false, remaining: bucket.usageRemaining, entry: null };
    }
    return this.deduct(bucketId, ownerId, amount, reason, metadata);
  }

  async credit(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageCreditResult<Reason>> {
    assertPositiveFiniteAmount(amount, "Credit");
    const bucket = this.buckets.get(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const entry = this.appendLedgerEntry(
      bucketId,
      ownerId,
      -amount,
      reason,
      metadata,
    );
    const remaining = bucket.usageRemaining + amount;
    this.buckets.set(bucketId, {
      ...bucket,
      usageRemaining: remaining,
      updatedAt: entry.createdAt,
    });

    return { remaining, entry };
  }

  async rolloverWindow(
    bucketId: string,
    expectedWindowStart: number,
    options: UsageRolloverOptions,
  ): Promise<UsageBucket> {
    const bucket = this.buckets.get(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }
    if (bucket.windowStart !== expectedWindowStart) {
      return { ...bucket };
    }

    const updated: UsageBucket = {
      ...bucket,
      windowStart: options.windowStart,
      usageLimit: options.usageLimit,
      windowDurationMs: options.windowDurationMs,
      usageRemaining: options.usageLimit,
      totalConsumed: 0,
      updatedAt: Date.now(),
    };
    this.buckets.set(bucketId, updated);
    return { ...updated };
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger<Reason>> {
    if (!this.buckets.has(bucketId)) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }
    const pageLimit = normalizePageLimit(limit);
    const sorted = [...(this.ledger.get(bucketId) ?? [])].reverse();
    const startIndex = cursor
      ? Math.max(0, sorted.findIndex((entry) => entry.id === cursor) + 1)
      : 0;
    const candidates = sorted.slice(startIndex, startIndex + pageLimit + 1);
    const entries = candidates.slice(0, pageLimit);

    return {
      entries,
      nextCursor:
        candidates.length > pageLimit ? entries[entries.length - 1].id : null,
    };
  }

  async resetAll(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [bucketId, bucket] of this.buckets) {
      this.buckets.set(bucketId, {
        ...bucket,
        usageRemaining: bucket.usageLimit,
        totalConsumed: 0,
        updatedAt: now,
      });
      count++;
    }
    return count;
  }

  async listBuckets(
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedBuckets> {
    const pageLimit = normalizePageLimit(limit);
    const candidates = [...this.buckets.entries()]
      .sort(([leftId], [rightId]) =>
        leftId < rightId ? -1 : leftId > rightId ? 1 : 0,
      )
      .filter(([bucketId]) => !cursor || bucketId > cursor)
      .slice(0, pageLimit + 1);
    const buckets = candidates
      .slice(0, pageLimit)
      .map(([, bucket]) => ({ ...bucket }));

    return {
      buckets,
      nextCursor:
        candidates.length > pageLimit ? buckets[buckets.length - 1].id : null,
    };
  }
}
