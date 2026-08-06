/// <reference types="@cloudflare/workers-types" />

import type {
  UsageBucket,
  UsageBucketProvisionOptions,
  UsageDeductResult,
  UsageLedgerEntry,
  UsagePaginatedBuckets,
  UsagePaginatedLedger,
  UsageStore,
} from "./types";

function generateId(): string {
  return crypto.randomUUID();
}

export type D1StoreOptions = {
  /** The D1 database binding */
  db: D1Database;
  /** Table name for usage buckets (default: "usage_buckets") */
  bucketsTable?: string;
  /** Table name for usage ledger (default: "usage_ledger") */
  ledgerTable?: string;
};

/**
 * Cloudflare D1-backed implementation of UsageStore.
 *
 * Requires two tables to be created in your D1 database. Use the following
 * SQL to create them:
 *
 * ```sql
 * CREATE TABLE usage_buckets (
 *   id TEXT PRIMARY KEY,
 *   owner_id TEXT NOT NULL UNIQUE,
 *   usage_remaining INTEGER NOT NULL,
 *   usage_limit INTEGER NOT NULL,
 *   window_start INTEGER NOT NULL,
 *   window_duration_ms INTEGER NOT NULL,
 *   total_consumed INTEGER NOT NULL DEFAULT 0,
 *   last_consumed_at INTEGER,
 *   created_at INTEGER NOT NULL,
 *   updated_at INTEGER NOT NULL
 * );
 *
 * CREATE TABLE usage_ledger (
 *   id TEXT PRIMARY KEY,
 *   bucket_id TEXT NOT NULL REFERENCES usage_buckets(id) ON DELETE CASCADE,
 *   owner_id TEXT NOT NULL,
 *   amount INTEGER NOT NULL,
 *   reason TEXT NOT NULL,
 *   metadata TEXT,
 *   created_at INTEGER NOT NULL
 * );
 *
 * CREATE INDEX idx_usage_ledger_bucket ON usage_ledger(bucket_id);
 * CREATE INDEX idx_usage_ledger_owner ON usage_ledger(owner_id);
 * ```
 *
 * @example
 * ```ts
 * import { D1Store } from "hono-usage-limiter/d1";
 *
 * // In a Cloudflare Worker
 * const store = new D1Store({ db: env.DB });
 * ```
 */
export class D1Store implements UsageStore {
  private db: D1Database;
  private bucketsTable: string;
  private ledgerTable: string;

  constructor(options: D1StoreOptions) {
    this.db = options.db;
    this.bucketsTable = options.bucketsTable ?? "usage_buckets";
    this.ledgerTable = options.ledgerTable ?? "usage_ledger";
  }

  private rowToBucket(row: Record<string, unknown>): UsageBucket {
    return {
      id: row.id as string,
      ownerId: row.owner_id as string,
      usageRemaining: row.usage_remaining as number,
      usageLimit: row.usage_limit as number,
      windowStart: row.window_start as number,
      windowDurationMs: row.window_duration_ms as number,
      totalConsumed: row.total_consumed as number,
      lastConsumedAt: (row.last_consumed_at as number) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToLedgerEntry(
    row: Record<string, unknown>,
  ): UsageLedgerEntry {
    return {
      id: row.id as string,
      bucketId: row.bucket_id as string,
      ownerId: row.owner_id as string,
      amount: row.amount as number,
      reason: row.reason as string,
      metadata: row.metadata
        ? JSON.parse(row.metadata as string)
        : null,
      createdAt: row.created_at as number,
    };
  }

  async getBucket(ownerId: string): Promise<UsageBucket | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM ${this.bucketsTable} WHERE owner_id = ? LIMIT 1`,
      )
      .bind(ownerId)
      .first();

    return row ? this.rowToBucket(row) : null;
  }

  async createBucket(
    ownerId: string,
    options: UsageBucketProvisionOptions,
  ): Promise<UsageBucket> {
    const now = Date.now();
    const id = generateId();

    await this.db
      .prepare(
        `INSERT INTO ${this.bucketsTable}
          (id, owner_id, usage_remaining, usage_limit, window_start, window_duration_ms, total_consumed, last_consumed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .bind(
        id,
        ownerId,
        options.usageLimit,
        options.usageLimit,
        now,
        options.windowDurationMs,
        now,
        now,
      )
      .run();

    return {
      id,
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
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.usageRemaining !== undefined) {
      setClauses.push("usage_remaining = ?");
      values.push(updates.usageRemaining);
    }
    if (updates.usageLimit !== undefined) {
      setClauses.push("usage_limit = ?");
      values.push(updates.usageLimit);
    }
    if (updates.windowStart !== undefined) {
      setClauses.push("window_start = ?");
      values.push(updates.windowStart);
    }
    if (updates.totalConsumed !== undefined) {
      setClauses.push("total_consumed = ?");
      values.push(updates.totalConsumed);
    }
    if (updates.lastConsumedAt !== undefined) {
      setClauses.push("last_consumed_at = ?");
      values.push(updates.lastConsumedAt);
    }

    const updatedAt = updates.updatedAt ?? Date.now();
    setClauses.push("updated_at = ?");
    values.push(updatedAt);
    values.push(bucketId);

    await this.db
      .prepare(
        `UPDATE ${this.bucketsTable} SET ${setClauses.join(", ")} WHERE id = ?`,
      )
      .bind(...values)
      .run();

    const row = await this.db
      .prepare(
        `SELECT * FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`,
      )
      .bind(bucketId)
      .first();

    if (!row) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    return this.rowToBucket(row);
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult> {
    const now = Date.now();
    const entryId = generateId();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    // Use a batch for atomicity
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE ${this.bucketsTable}
            SET usage_remaining = usage_remaining - ?,
                total_consumed = total_consumed + ?,
                last_consumed_at = ?,
                updated_at = ?
            WHERE id = ?`,
        )
        .bind(amount, amount, now, now, bucketId),
      this.db
        .prepare(
          `INSERT INTO ${this.ledgerTable}
            (id, bucket_id, owner_id, amount, reason, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(entryId, bucketId, ownerId, amount, reason, metadataJson, now),
      this.db
        .prepare(
          `SELECT usage_remaining FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`,
        )
        .bind(bucketId),
    ]);

    const selectResult = results[2] as D1Result<Record<string, unknown>>;
    const remaining = (selectResult.results[0]?.usage_remaining as number) ?? 0;

    const entry: UsageLedgerEntry = {
      id: entryId,
      bucketId,
      ownerId,
      amount,
      reason,
      metadata: metadata ?? null,
      createdAt: now,
    };

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
    let query: string;
    const values: unknown[] = [bucketId];

    if (cursor) {
      // Get the created_at of the cursor entry to paginate from
      const cursorRow = await this.db
        .prepare(
          `SELECT created_at FROM ${this.ledgerTable} WHERE id = ? LIMIT 1`,
        )
        .bind(cursor)
        .first();

      if (cursorRow) {
        query = `SELECT * FROM ${this.ledgerTable}
          WHERE bucket_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?`;
        values.push(
          cursorRow.created_at,
          cursorRow.created_at,
          cursor,
          limit + 1,
        );
      } else {
        query = `SELECT * FROM ${this.ledgerTable}
          WHERE bucket_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`;
        values.push(limit + 1);
      }
    } else {
      query = `SELECT * FROM ${this.ledgerTable}
        WHERE bucket_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`;
      values.push(limit + 1);
    }

    const result = await this.db
      .prepare(query)
      .bind(...values)
      .all();

    const rows = result.results as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const entries = pageRows.map((row) => this.rowToLedgerEntry(row));

    return {
      entries,
      nextCursor: hasMore ? entries[entries.length - 1].id : null,
    };
  }

  async resetAll(): Promise<number> {
    const now = Date.now();
    // Single set-based UPDATE across every bucket — no per-row iteration.
    const result = await this.db
      .prepare(
        `UPDATE ${this.bucketsTable}
          SET usage_remaining = usage_limit,
              total_consumed = 0,
              updated_at = ?`,
      )
      .bind(now)
      .run();
    return result.meta.changes ?? 0;
  }

  async listBuckets(
    cursor?: string,
    limit = 50,
  ): Promise<UsagePaginatedBuckets> {
    // Stable keyset pagination by id so the cursor is deterministic.
    let query: string;
    const values: unknown[] = [];

    if (cursor) {
      query = `SELECT * FROM ${this.bucketsTable}
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`;
      values.push(cursor, limit + 1);
    } else {
      query = `SELECT * FROM ${this.bucketsTable}
        ORDER BY id ASC
        LIMIT ?`;
      values.push(limit + 1);
    }

    const result = await this.db
      .prepare(query)
      .bind(...values)
      .all();

    const rows = result.results as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const buckets = pageRows.map((row) => this.rowToBucket(row));

    return {
      buckets,
      nextCursor: hasMore ? buckets[buckets.length - 1].id : null,
    };
  }
}
