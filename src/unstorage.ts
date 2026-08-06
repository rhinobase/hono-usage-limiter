import type { Storage } from "unstorage";
import type {
  UsageBucket,
  UsageBucketProvisionOptions,
  UsageDeductResult,
  UsageLedgerEntry,
  UsagePaginatedLedger,
  UsageStore,
  UsageTryDeductResult,
} from "./types";

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Unstorage-backed implementation of UsageStore.
 *
 * Uses a key-value storage backend via unstorage. Works with any unstorage
 * driver (fs, redis, cloudflare-kv, etc.).
 *
 * Key layout:
 * - `bucket:{ownerId}` — the UsageBucket object
 * - `bucket-owner:{bucketId}` — reverse lookup: the ownerId for a bucket id
 * - `ledger:{bucketId}:{entryId}` — individual ledger entries
 * - `ledger-index:{bucketId}` — array of entry IDs (newest first)
 *
 * @example
 * ```ts
 * import { createStorage } from "unstorage";
 * import { UnstorageStore } from "hono-usage-limiter/unstorage";
 *
 * const storage = createStorage(); // or any driver
 * const store = new UnstorageStore({ storage });
 * ```
 */
export class UnstorageStore implements UsageStore {
  private storage: Storage;
  private prefix: string;

  constructor(options: { storage: Storage; prefix?: string }) {
    this.storage = options.storage;
    this.prefix = options.prefix ?? "usage";
  }

  private bucketKey(ownerId: string): string {
    return `${this.prefix}:bucket:${ownerId}`;
  }

  private bucketOwnerKey(bucketId: string): string {
    return `${this.prefix}:bucket-owner:${bucketId}`;
  }

  private ledgerKey(bucketId: string, entryId: string): string {
    return `${this.prefix}:ledger:${bucketId}:${entryId}`;
  }

  private ledgerIndexKey(bucketId: string): string {
    return `${this.prefix}:ledger-index:${bucketId}`;
  }

  async getBucket(ownerId: string): Promise<UsageBucket | null> {
    const bucket =
      await this.storage.getItem<UsageBucket>(this.bucketKey(ownerId));
    return bucket ?? null;
  }

  async createBucket(
    ownerId: string,
    options: UsageBucketProvisionOptions,
  ): Promise<UsageBucket> {
    const existing = await this.getBucket(ownerId);
    if (existing) {
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

    await this.storage.setItem(this.bucketKey(ownerId), bucket);
    await this.storage.setItem(this.bucketOwnerKey(bucket.id), ownerId);
    await this.storage.setItem(this.ledgerIndexKey(bucket.id), []);

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
    // Resolve the owner via the reverse-lookup key written on createBucket —
    // an O(1) read instead of scanning every bucket key.
    const ownerId = await this.storage.getItem<string>(
      this.bucketOwnerKey(bucketId),
    );
    const found = ownerId ? await this.getBucket(ownerId) : null;

    if (!found) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const updated: UsageBucket = {
      ...found,
      ...updates,
      updatedAt: updates.updatedAt ?? Date.now(),
    };

    await this.storage.setItem(this.bucketKey(found.ownerId), updated);
    return updated;
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult> {
    const bucket = await this.getBucket(ownerId);
    if (!bucket || bucket.id !== bucketId) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const { remaining, entry } = await this.applyDeduction(
      bucket,
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );

    return {
      success: true,
      remaining,
      entry,
    };
  }

  async tryDeduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTryDeductResult> {
    const bucket = await this.getBucket(ownerId);
    if (!bucket || bucket.id !== bucketId) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    // NOTE: unstorage is a plain KV store with no compare-and-swap, so this
    // gate is a read-modify-write and is NOT safe against truly concurrent
    // writers to the same key. It prevents accidental overspend for the common
    // (serialized) case; for strong atomicity under concurrency use a store
    // whose backend supports it (e.g. the D1Store).
    if (bucket.usageRemaining < amount) {
      return {
        success: false,
        remaining: bucket.usageRemaining,
        entry: null,
      };
    }

    const { remaining, entry } = await this.applyDeduction(
      bucket,
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
    );

    return {
      success: true,
      remaining,
      entry,
    };
  }

  /** Shared write path for {@link deduct} and {@link tryDeduct}. */
  private async applyDeduction(
    bucket: UsageBucket,
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ remaining: number; entry: UsageLedgerEntry }> {
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

    const remaining = bucket.usageRemaining - amount;
    const updated: UsageBucket = {
      ...bucket,
      usageRemaining: remaining,
      totalConsumed: bucket.totalConsumed + amount,
      lastConsumedAt: now,
      updatedAt: now,
    };

    // Store the updated bucket, the ledger entry, and update the index
    await this.storage.setItem(this.bucketKey(ownerId), updated);
    await this.storage.setItem(this.ledgerKey(bucketId, entry.id), entry);

    const index =
      (await this.storage.getItem<string[]>(this.ledgerIndexKey(bucketId))) ??
      [];
    index.unshift(entry.id);
    await this.storage.setItem(this.ledgerIndexKey(bucketId), index);

    return { remaining, entry };
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit = 20,
  ): Promise<UsagePaginatedLedger> {
    const index =
      (await this.storage.getItem<string[]>(this.ledgerIndexKey(bucketId))) ??
      [];

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = index.indexOf(cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const pageIds = index.slice(startIndex, startIndex + limit);
    const entries: UsageLedgerEntry[] = [];

    for (const id of pageIds) {
      const entry = await this.storage.getItem<UsageLedgerEntry>(
        this.ledgerKey(bucketId, id),
      );
      if (entry) {
        entries.push(entry);
      }
    }

    const hasMore = startIndex + limit < index.length;

    return {
      entries,
      nextCursor: hasMore ? pageIds[pageIds.length - 1] : null,
    };
  }

  async refillWindow(
    bucketId: string,
    expectedWindowStart: number,
    newWindowStart: number,
  ): Promise<UsageBucket> {
    const ownerId = await this.storage.getItem<string>(
      this.bucketOwnerKey(bucketId),
    );
    const bucket = ownerId ? await this.getBucket(ownerId) : null;
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    // Only refill if the window hasn't already advanced. As with tryDeduct,
    // unstorage has no compare-and-swap so this is best-effort and not safe
    // against truly concurrent writers.
    if (bucket.windowStart !== expectedWindowStart) {
      return bucket;
    }

    const now = Date.now();
    const updated: UsageBucket = {
      ...bucket,
      usageRemaining: bucket.usageLimit,
      windowStart: newWindowStart,
      totalConsumed: 0,
      updatedAt: now,
    };
    await this.storage.setItem(this.bucketKey(bucket.ownerId), updated);
    return updated;
  }
}
