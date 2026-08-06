import type { Storage } from "unstorage";
import type {
  UsageBucket,
  UsageBucketProvisionOptions,
  UsageCreditResult,
  UsageDeductResult,
  UsageLedgerEntry,
  UsagePaginatedLedger,
  UsageStore,
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
    // We need to find the bucket by ID — scan by looking it up via the stored data
    // Since unstorage is KV and we key by ownerId, we store a reverse lookup
    const keys = await this.storage.getKeys(`${this.prefix}:bucket`);
    let found: UsageBucket | null = null;

    for (const key of keys) {
      const bucket = await this.storage.getItem<UsageBucket>(key);
      if (bucket && bucket.id === bucketId) {
        found = bucket;
        break;
      }
    }

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
    await this.storage.setItem(
      this.ledgerKey(bucketId, entry.id),
      entry,
    );

    const index =
      (await this.storage.getItem<string[]>(
        this.ledgerIndexKey(bucketId),
      )) ?? [];
    index.unshift(entry.id);
    await this.storage.setItem(this.ledgerIndexKey(bucketId), index);

    return {
      success: true,
      remaining,
      entry,
    };
  }

  async credit(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageCreditResult> {
    const bucket = await this.getBucket(ownerId);
    if (!bucket || bucket.id !== bucketId) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    const now = Date.now();

    // Inverse of deduct: add back to remaining, subtract from total_consumed,
    // and record a ledger entry with a NEGATIVE amount.
    const entry: UsageLedgerEntry = {
      id: generateId(),
      bucketId,
      ownerId,
      amount: -amount,
      reason,
      metadata: metadata ?? null,
      createdAt: now,
    };

    const remaining = bucket.usageRemaining + amount;
    const updated: UsageBucket = {
      ...bucket,
      usageRemaining: remaining,
      totalConsumed: bucket.totalConsumed - amount,
      updatedAt: now,
    };

    await this.storage.setItem(this.bucketKey(ownerId), updated);
    await this.storage.setItem(this.ledgerKey(bucketId, entry.id), entry);

    const index =
      (await this.storage.getItem<string[]>(
        this.ledgerIndexKey(bucketId),
      )) ?? [];
    index.unshift(entry.id);
    await this.storage.setItem(this.ledgerIndexKey(bucketId), index);

    return {
      remaining,
      entry,
    };
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit = 20,
  ): Promise<UsagePaginatedLedger> {
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
}
