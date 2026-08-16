import type { Storage } from "unstorage";
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
 * Unstorage-backed implementation of UsageStore.
 *
 * Uses a key-value storage backend via unstorage. Works with any unstorage
 * driver (fs, redis, cloudflare-kv, etc.).
 *
 * Key layout:
 * - `bucket:{ownerId}` — the UsageBucket object
 * - `bucket-owner:{bucketId}` — owner ID reverse lookup
 * - `ledger:{bucketId}:{entryId}` — individual ledger entries
 * - `ledger-index:{bucketId}` — array of entry IDs (newest first)
 *
 * `tryDeduct()` and `rolloverWindow()` are best-effort read-modify-write
 * operations. Generic Unstorage drivers do not provide cross-isolate
 * compare-and-set semantics, so use a transactional store when strict
 * concurrency is required. `credit()` writes a negative ledger entry and can
 * raise a current-window balance above its configured limit. `resetAll()` and
 * `listBuckets()` enumerate stored buckets and are administrative O(n)
 * operations.
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
export class UnstorageStore<Reason extends string = string>
  implements UsageStore<Reason>
{
  private storage: Storage;
  private prefix: string;

  constructor(options: { storage: Storage; prefix?: string }) {
    this.storage = options.storage;
    this.prefix = options.prefix ?? "usage";
  }

  private bucketKey(ownerId: string): string {
    return `${this.prefix}:bucket:${ownerId}`;
  }

  private bucketKeyPrefix(): string {
    return `${this.prefix}:bucket:`;
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

  private async findBucketById(bucketId: string): Promise<UsageBucket | null> {
    const ownerId = await this.storage.getItem<string>(
      this.bucketOwnerKey(bucketId),
    );
    if (ownerId) {
      return (await this.storage.getItem<UsageBucket>(this.bucketKey(ownerId))) ?? null;
    }

    const bucketKeyPrefix = this.bucketKeyPrefix();
    const keys = await this.storage.getKeys(bucketKeyPrefix);
    for (const key of keys) {
      if (!key.startsWith(bucketKeyPrefix)) continue;
      const bucket = await this.storage.getItem<UsageBucket>(key);
      if (bucket?.id !== bucketId) continue;
      await this.storage.setItem(this.bucketOwnerKey(bucketId), bucket.ownerId);
      return bucket;
    }

    return null;
  }

  private async appendLedgerEntry(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageLedgerEntry<Reason>> {
    const entry: UsageLedgerEntry<Reason> = {
      id: generateId(),
      bucketId,
      ownerId,
      amount,
      reason,
      metadata: metadata ?? null,
      createdAt: Date.now(),
    };

    await this.storage.setItem(this.ledgerKey(bucketId, entry.id), entry);
    const index =
      (await this.storage.getItem<string[]>(this.ledgerIndexKey(bucketId))) ??
      [];
    index.unshift(entry.id);
    await this.storage.setItem(this.ledgerIndexKey(bucketId), index);

    return entry;
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
    updates: UsageBucketUpdates,
  ): Promise<UsageBucket> {
    const bucket = await this.findBucketById(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const updated: UsageBucket = {
      ...bucket,
      ...updates,
      updatedAt: updates.updatedAt ?? Date.now(),
    };

    await this.storage.setItem(this.bucketKey(bucket.ownerId), updated);
    return updated;
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult<Reason>> {
    const bucket = await this.findBucketById(bucketId);
    if (!bucket || bucket.ownerId !== ownerId) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const remaining = bucket.usageRemaining - amount;
    const now = Date.now();
    const updated: UsageBucket = {
      ...bucket,
      usageRemaining: remaining,
      totalConsumed: bucket.totalConsumed + amount,
      lastConsumedAt: now,
      updatedAt: now,
    };

    await this.storage.setItem(this.bucketKey(ownerId), updated);
    const entry = await this.appendLedgerEntry(
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
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTryDeductResult<Reason>> {
    assertPositiveFiniteAmount(amount, "Deduction");
    const bucket = await this.findBucketById(bucketId);
    if (!bucket || bucket.ownerId !== ownerId) {
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
    const bucket = await this.findBucketById(bucketId);
    if (!bucket || bucket.ownerId !== ownerId) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const entry = await this.appendLedgerEntry(
      bucketId,
      ownerId,
      -amount,
      reason,
      metadata,
    );
    const remaining = bucket.usageRemaining + amount;
    await this.storage.setItem(this.bucketKey(bucket.ownerId), {
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
    const bucket = await this.findBucketById(bucketId);
    if (!bucket) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }
    if (bucket.windowStart !== expectedWindowStart) {
      return bucket;
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
    await this.storage.setItem(this.bucketKey(bucket.ownerId), updated);
    return updated;
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger<Reason>> {
    const pageLimit = normalizePageLimit(limit);
    const index =
      (await this.storage.getItem<string[]>(
        this.ledgerIndexKey(bucketId),
      )) ?? [];

    let startIndex = 0;
    if (cursor) {
      const cursorIndex = index.indexOf(cursor);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const pageIds = index.slice(startIndex, startIndex + pageLimit + 1);
    const entries: UsageLedgerEntry<Reason>[] = [];

    for (const id of pageIds) {
      const entry = await this.storage.getItem<UsageLedgerEntry<Reason>>(
        this.ledgerKey(bucketId, id),
      );
      if (entry) {
        entries.push(entry);
      }
    }

    const hasMore = entries.length > pageLimit;
    const pageEntries = hasMore ? entries.slice(0, pageLimit) : entries;

    return {
      entries: pageEntries,
      nextCursor: hasMore ? pageEntries[pageEntries.length - 1].id : null,
    };
  }

  async resetAll(): Promise<number> {
    const now = Date.now();
    let count = 0;
    const bucketKeyPrefix = this.bucketKeyPrefix();
    const keys = await this.storage.getKeys(bucketKeyPrefix);
    for (const key of keys) {
      if (!key.startsWith(bucketKeyPrefix)) continue;
      const bucket = await this.storage.getItem<UsageBucket>(key);
      if (!bucket) continue;
      await this.storage.setItem(key, {
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
    const bucketKeyPrefix = this.bucketKeyPrefix();
    const keys = await this.storage.getKeys(bucketKeyPrefix);
    const buckets: UsageBucket[] = [];

    for (const key of keys) {
      if (!key.startsWith(bucketKeyPrefix)) continue;
      const bucket = await this.storage.getItem<UsageBucket>(key);
      if (bucket) buckets.push(bucket);
    }

    const candidates = buckets
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )
      .filter((bucket) => !cursor || bucket.id > cursor)
      .slice(0, pageLimit + 1);
    const pageBuckets = candidates.slice(0, pageLimit);

    return {
      buckets: pageBuckets,
      nextCursor:
        candidates.length > pageLimit
          ? pageBuckets[pageBuckets.length - 1].id
          : null,
    };
  }
}
