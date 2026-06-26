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
  /** Total usage units consumed over the lifetime of this bucket */
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
  /** Reason for the deduction (e.g., 'transcribe', 'post-process') */
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
   * Get paginated ledger entries for a bucket.
   * Entries should be ordered by `createdAt` descending (newest first).
   */
  getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<UsagePaginatedLedger>;
}

export type UsageManagerConfig = {
  /** The storage adapter to use */
  store: UsageStore;
  /** Default usage limit for new buckets (default: 1000) */
  defaultUsage?: number;
  /** Default window duration in milliseconds (default: 30 days) */
  defaultWindowMs?: number;
  /**
   * Function to resolve the owner ID from the Hono context.
   * This is called by the middleware to determine whose bucket to load.
   */
  keyGenerator: (c: unknown) => string | Promise<string>;
  /** Whether to auto-provision a bucket if one doesn't exist (default: true) */
  autoProvision?: boolean;
};
