import type { Context, Env } from "hono";

export type UsageBucket = {
  /** Unique identifier for the bucket */
  id: string;
  /** Identifier for the owner of this bucket (e.g., user ID, member ID) */
  ownerId: string;
  /** Number of usage units currently remaining */
  usageRemaining: number;
  /** Maximum usage units allowed in this bucket */
  usageLimit: number;
  /** Start of the current rolling window (epoch ms) */
  windowStart: number;
  /** Duration of the rolling window in milliseconds */
  windowDurationMs: number;
  /** Total usage units consumed in the current window */
  totalConsumed: number;
  /** Timestamp of the last usage deduction (epoch ms), or null if never consumed */
  lastConsumedAt: number | null;
  /** Timestamp when the bucket was created (epoch ms) */
  createdAt: number;
  /** Timestamp when the bucket was last updated (epoch ms) */
  updatedAt: number;
};

export type UsageLedgerEntry = {
  /** Unique identifier for this ledger entry */
  id: string;
  /** ID of the bucket this entry belongs to */
  bucketId: string;
  /** ID of the owner who consumed the usage */
  ownerId: string;
  /** Number of usage units consumed (positive integer) */
  amount: number;
  /** Reason for the deduction (e.g., 'inference', 'embedding') */
  reason: string;
  /** Optional metadata as a JSON-serializable object */
  metadata: Record<string, unknown> | null;
  /** Timestamp when this entry was created (epoch ms) */
  createdAt: number;
};

export type UsageStatus = {
  /** Usage units currently remaining */
  remaining: number;
  /** Maximum usage units for this bucket */
  limit: number;
  /** Whether the bucket has usage remaining */
  hasUsage: boolean;
  /** ISO timestamp when the current window resets */
  resetsAt: string;
};

export type UsageBalanceInfo = {
  /** Usage units currently remaining */
  remaining: number;
  /** Maximum usage units for this bucket */
  limit: number;
  /** Total usage units consumed in the current window */
  totalConsumed: number;
  /** ISO timestamp of the current window start */
  windowStart: string;
  /** ISO timestamp when the current window resets */
  resetsAt: string;
};

export type UsageDeductResult = {
  /** Whether the deduction was successful */
  success: boolean;
  /** Usage units remaining after deduction */
  remaining: number;
  /** The ledger entry created for this deduction */
  entry: UsageLedgerEntry;
};

/**
 * Result of an atomic {@link UsageStore.tryDeduct} / {@link UsageManager.tryDeduct}.
 *
 * Unlike {@link UsageDeductResult}, the deduction is only applied when the
 * bucket has enough usage remaining. When `success` is `false` nothing was
 * written — no balance change, no ledger entry — and `remaining` reflects the
 * unchanged balance.
 */
export type UsageTryDeductResult =
  | {
      /** The deduction was applied. */
      success: true;
      /** Usage units remaining after the deduction. */
      remaining: number;
      /** The ledger entry created for this deduction. */
      entry: UsageLedgerEntry;
    }
  | {
      /** The deduction was refused — the bucket had insufficient usage. */
      success: false;
      /** Usage units remaining (unchanged). */
      remaining: number;
      /** No ledger entry is created when a deduction is refused. */
      entry: null;
    };

export type UsagePaginatedLedger = {
  /** Ledger entries for the current page */
  entries: UsageLedgerEntry[];
  /** Cursor for the next page, or null if no more entries */
  nextCursor: string | null;
};

export type UsageBucketProvisionOptions = {
  /** Maximum usage units for the bucket */
  usageLimit: number;
  /** Duration of the rolling window in milliseconds */
  windowDurationMs: number;
};

/**
 * Storage adapter interface for usage data.
 * Implement this interface to use any database backend.
 */
export interface UsageStore {
  /**
   * Get a usage bucket by owner ID.
   * Returns null if no bucket exists for this owner.
   */
  getBucket(ownerId: string): Promise<UsageBucket | null>;

  /**
   * Create a new usage bucket for an owner.
   * Should throw if a bucket already exists for this owner.
   */
  createBucket(
    ownerId: string,
    options: UsageBucketProvisionOptions,
  ): Promise<UsageBucket>;

  /**
   * Update a usage bucket.
   * Only the fields present in `updates` should be modified.
   */
  updateBucket(
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
  ): Promise<UsageBucket>;

  /**
   * Record a deduction in the ledger and update the bucket atomically.
   * Should decrement `usageRemaining`, increment `totalConsumed`,
   * and insert a ledger entry in a single transaction.
   */
  deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageDeductResult>;

  /**
   * Atomically deduct usage **only if** the bucket has enough remaining.
   *
   * This is the safe, gate-and-deduct primitive: the balance check and the
   * write happen in a single atomic operation, so concurrent callers can't both
   * pass a check and overspend a shared bucket. When the bucket has fewer than
   * `amount` units remaining, nothing is written and the result is
   * `{ success: false, remaining, entry: null }`.
   *
   * On success it behaves like {@link UsageStore.deduct}: it decrements
   * `usageRemaining`, increments `totalConsumed`, and inserts a ledger entry.
   */
  tryDeduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<UsageTryDeductResult>;

  /**
   * Get paginated ledger entries for a bucket.
   * Entries should be ordered by `createdAt` descending (newest first).
   */
  getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger>;

  /**
   * Atomically refill a bucket's window **only if** its window has not already
   * been advanced past `expectedWindowStart`.
   *
   * Optional. When a store implements this, {@link UsageManager} uses it to roll
   * a bucket over to a fresh window without a read-then-write race: two
   * concurrent requests that both observe an expired window can't both reset it
   * (which would double the allowance or clobber `totalConsumed`). The refill
   * resets `usageRemaining` to `usageLimit`, sets `windowStart` to `newWindowStart`,
   * and zeroes `totalConsumed`.
   *
   * Returns the bucket as it stands after the operation — the freshly refilled
   * bucket when this call performed the reset, or the bucket a concurrent caller
   * already refilled (its `windowStart` will differ from `expectedWindowStart`).
   *
   * Stores whose backend has no conditional write (e.g. plain KV) may leave this
   * unimplemented; the manager then falls back to a best-effort
   * {@link updateBucket}.
   */
  refillWindow?(
    bucketId: string,
    expectedWindowStart: number,
    newWindowStart: number,
  ): Promise<UsageBucket>;
}

/**
 * A factory function that receives the Hono context and returns a UsageStore.
 * Use this when the store requires request-scoped resources (e.g., Cloudflare D1 bindings).
 *
 * The context is typed to your app's `Env` when you pass it as a type argument
 * to {@link usageManager}, so `c.env` and `c.get(...)` are fully typed with no
 * casts required.
 *
 * @example
 * ```ts
 * app.use(usageManager<{ Bindings: { DB: D1Database } }>({
 *   store: (c) => new D1Store({ db: c.env.DB }),
 *   keyGenerator: (c) => c.get("userId"),
 * }));
 * ```
 */
export type UsageStoreFactory<E extends Env = Env> = (
  c: Context<E>,
) => UsageStore;

export type UsageManagerConfig<E extends Env = Env> = {
  /**
   * The storage adapter to use, either as a pre-constructed instance
   * or a factory function that receives the Hono context.
   *
   * Use a factory when the store depends on request-scoped bindings
   * (e.g., `c.env.DB` in Cloudflare Workers):
   *
   * ```ts
   * store: (c) => new D1Store({ db: c.env.DB })
   * ```
   */
  store: UsageStore | UsageStoreFactory<E>;
  /** Default usage limit for new buckets (default: 1000) */
  defaultUsage?: number;
  /** Default window duration in milliseconds (default: 30 days) */
  defaultWindowDurationMs?: number;
  /**
   * Function to resolve the owner ID from the Hono context.
   * This is called by the middleware to determine whose bucket to load.
   */
  keyGenerator: (c: Context<E>) => string | Promise<string>;
  /** Whether to auto-provision a bucket if one doesn't exist (default: true) */
  autoProvision?: boolean;
};
