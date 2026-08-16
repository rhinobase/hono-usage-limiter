/// <reference types="@cloudflare/workers-types" />

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

function rowToBucket(row: Record<string, unknown>): UsageBucket {
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

function rowToLedgerEntry<Reason extends string>(
  row: Record<string, unknown>,
): UsageLedgerEntry<Reason> {
  return {
    id: row.id as string,
    bucketId: row.bucket_id as string,
    ownerId: row.owner_id as string,
    amount: row.amount as number,
    reason: row.reason as Reason,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    createdAt: row.created_at as number,
  };
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
export class D1Store<Reason extends string = string>
  implements UsageStore<Reason>
{
  private db: D1Database;
  private bucketsTable: string;
  private ledgerTable: string;

  constructor(options: D1StoreOptions) {
    this.db = options.db;
    this.bucketsTable = options.bucketsTable ?? "usage_buckets";
    this.ledgerTable = options.ledgerTable ?? "usage_ledger";
  }

  private createLedgerEntry(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata: Record<string, unknown> | undefined,
    createdAt: number,
  ): UsageLedgerEntry<Reason> {
    return {
      id: generateId(),
      bucketId,
      ownerId,
      amount,
      reason,
      metadata: metadata ?? null,
      createdAt,
    };
  }

  private prepareLedgerInsert(
    entry: UsageLedgerEntry<Reason>,
    minimumRemaining?: number,
  ): D1PreparedStatement {
    const metadataJson = entry.metadata ? JSON.stringify(entry.metadata) : null;
    const values = [
      entry.id,
      entry.bucketId,
      entry.ownerId,
      entry.amount,
      entry.reason,
      metadataJson,
      entry.createdAt,
      entry.bucketId,
    ];

    if (minimumRemaining !== undefined) {
      return this.db
        .prepare(
          `INSERT INTO ${this.ledgerTable}
            (id, bucket_id, owner_id, amount, reason, metadata, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?
            FROM ${this.bucketsTable}
            WHERE id = ? AND usage_remaining >= ?`,
        )
        .bind(...values, minimumRemaining);
    }

    return this.db
      .prepare(
        `INSERT INTO ${this.ledgerTable}
          (id, bucket_id, owner_id, amount, reason, metadata, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?
          FROM ${this.bucketsTable}
          WHERE id = ?`,
      )
      .bind(...values);
  }

  private readRemaining(
    result: D1Result<Record<string, unknown>>,
    bucketId: string,
  ): number {
    const row = result.results[0];
    if (!row) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }
    return row.usage_remaining as number;
  }

  async getBucket(ownerId: string): Promise<UsageBucket | null> {
    const row = await this.db
      .prepare(`SELECT * FROM ${this.bucketsTable} WHERE owner_id = ? LIMIT 1`)
      .bind(ownerId)
      .first();

    return row ? rowToBucket(row) : null;
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
    updates: UsageBucketUpdates,
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
    if (updates.windowDurationMs !== undefined) {
      setClauses.push("window_duration_ms = ?");
      values.push(updates.windowDurationMs);
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
    values.push(updatedAt, bucketId);

    await this.db
      .prepare(
        `UPDATE ${this.bucketsTable} SET ${setClauses.join(", ")} WHERE id = ?`,
      )
      .bind(...values)
      .run();

    const row = await this.db
      .prepare(`SELECT * FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`)
      .bind(bucketId)
      .first();

    if (!row) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }

    return rowToBucket(row);
  }

  async deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult<Reason>> {
    const now = Date.now();
    const entry = this.createLedgerEntry(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
      now,
    );

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
      this.prepareLedgerInsert(entry),
      this.db
        .prepare(
          `SELECT usage_remaining FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`,
        )
        .bind(bucketId),
    ]);

    const remaining = this.readRemaining(
      results[2] as D1Result<Record<string, unknown>>,
      bucketId,
    );

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
    const now = Date.now();
    const entry = this.createLedgerEntry(
      bucketId,
      ownerId,
      amount,
      reason,
      metadata,
      now,
    );

    const results = await this.db.batch([
      this.prepareLedgerInsert(entry, amount),
      this.db
        .prepare(
          `UPDATE ${this.bucketsTable}
            SET usage_remaining = usage_remaining - ?,
                total_consumed = total_consumed + ?,
                last_consumed_at = ?,
                updated_at = ?
            WHERE id = ? AND usage_remaining >= ?`,
        )
        .bind(amount, amount, now, now, bucketId, amount),
      this.db
        .prepare(
          `SELECT usage_remaining FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`,
        )
        .bind(bucketId),
    ]);

    const remaining = this.readRemaining(
      results[2] as D1Result<Record<string, unknown>>,
      bucketId,
    );
    const updateResult = results[1] as D1Result<Record<string, unknown>>;
    if (updateResult.meta.changes === 0) {
      return { success: false, remaining, entry: null };
    }

    return { success: true, remaining, entry };
  }

  async credit(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: Reason,
    metadata?: Record<string, unknown>,
  ): Promise<UsageCreditResult<Reason>> {
    assertPositiveFiniteAmount(amount, "Credit");
    const now = Date.now();
    const entry = this.createLedgerEntry(
      bucketId,
      ownerId,
      -amount,
      reason,
      metadata,
      now,
    );

    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE ${this.bucketsTable}
            SET usage_remaining = usage_remaining + ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(amount, now, bucketId),
      this.prepareLedgerInsert(entry),
      this.db
        .prepare(
          `SELECT usage_remaining FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`,
        )
        .bind(bucketId),
    ]);

    const remaining = this.readRemaining(
      results[2] as D1Result<Record<string, unknown>>,
      bucketId,
    );
    return { remaining, entry };
  }

  async rolloverWindow(
    bucketId: string,
    expectedWindowStart: number,
    options: UsageRolloverOptions,
  ): Promise<UsageBucket> {
    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE ${this.bucketsTable}
            SET window_start = ?,
                usage_limit = ?,
                window_duration_ms = ?,
                usage_remaining = ?,
                total_consumed = 0,
                updated_at = ?
            WHERE id = ? AND window_start = ?`,
        )
        .bind(
          options.windowStart,
          options.usageLimit,
          options.windowDurationMs,
          options.usageLimit,
          now,
          bucketId,
          expectedWindowStart,
        ),
      this.db
        .prepare(`SELECT * FROM ${this.bucketsTable} WHERE id = ? LIMIT 1`)
        .bind(bucketId),
    ]);

    const row = (results[1] as D1Result<Record<string, unknown>>).results[0];
    if (!row) {
      throw new Error(`Usage bucket "${bucketId}" not found`);
    }
    return rowToBucket(row);
  }

  async getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger<Reason>> {
    const pageLimit = normalizePageLimit(limit);
    let query: string;
    const values: unknown[] = [bucketId];

    if (cursor) {
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
          pageLimit + 1,
        );
      } else {
        query = `SELECT * FROM ${this.ledgerTable}
          WHERE bucket_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`;
        values.push(pageLimit + 1);
      }
    } else {
      query = `SELECT * FROM ${this.ledgerTable}
        WHERE bucket_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`;
      values.push(pageLimit + 1);
    }

    const result = await this.db
      .prepare(query)
      .bind(...values)
      .all();

    const rows = result.results as Record<string, unknown>[];
    const hasMore = rows.length > pageLimit;
    const pageRows = rows.slice(0, pageLimit);
    const entries = pageRows.map((row) => rowToLedgerEntry<Reason>(row));

    return {
      entries,
      nextCursor: hasMore ? entries[entries.length - 1].id : null,
    };
  }

  async resetAll(): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE ${this.bucketsTable}
          SET usage_remaining = usage_limit,
              total_consumed = 0,
              updated_at = ?`,
      )
      .bind(Date.now())
      .run();
    return result.meta.changes;
  }

  async listBuckets(
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedBuckets> {
    const pageLimit = normalizePageLimit(limit);
    const query = cursor
      ? `SELECT * FROM ${this.bucketsTable}
          WHERE id > ?
          ORDER BY id
          LIMIT ?`
      : `SELECT * FROM ${this.bucketsTable}
          ORDER BY id
          LIMIT ?`;
    const values = cursor ? [cursor, pageLimit + 1] : [pageLimit + 1];
    const result = await this.db
      .prepare(query)
      .bind(...values)
      .all();

    const rows = result.results as Record<string, unknown>[];
    const hasMore = rows.length > pageLimit;
    const buckets = rows.slice(0, pageLimit).map(rowToBucket);

    return {
      buckets,
      nextCursor: hasMore ? buckets[buckets.length - 1].id : null,
    };
  }
}
