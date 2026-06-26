export type CreditBucket = {
  /** Unique identifier for the bucket */
  id: string;
  /** Identifier for the owner of this bucket (e.g., user ID, member ID) */
  ownerId: string;
  /** Number of credits currently remaining */
  creditsRemaining: number;
  /** Maximum credits allowed in this bucket */
  creditsLimit: number;
  /** Start of the current rolling window (epoch ms) */
  windowStart: number;
  /** Duration of the rolling window in milliseconds */
  windowDurationMs: number;
  /** Total credits consumed over the lifetime of this bucket */
  totalConsumed: number;
  /** Timestamp of the last credit deduction (epoch ms), or null if never consumed */
  lastConsumedAt: number | null;
  /** Timestamp when the bucket was created (epoch ms) */
  createdAt: number;
  /** Timestamp when the bucket was last updated (epoch ms) */
  updatedAt: number;
};

export type LedgerEntry = {
  /** Unique identifier for this ledger entry */
  id: string;
  /** ID of the bucket this entry belongs to */
  bucketId: string;
  /** ID of the owner who consumed the credits */
  ownerId: string;
  /** Number of credits consumed (positive integer) */
  amount: number;
  /** Reason for the deduction (e.g., 'transcribe', 'post-process') */
  reason: string;
  /** Optional metadata as a JSON-serializable object */
  metadata: Record<string, unknown> | null;
  /** Timestamp when this entry was created (epoch ms) */
  createdAt: number;
};

export type CreditStatus = {
  /** Credits currently remaining */
  remaining: number;
  /** Maximum credits for this bucket */
  limit: number;
  /** Whether the bucket has credits remaining */
  hasCredits: boolean;
  /** ISO timestamp when the current window resets */
  resetsAt: string;
};

export type BalanceInfo = {
  /** Credits currently remaining */
  remaining: number;
  /** Maximum credits for this bucket */
  limit: number;
  /** Total credits consumed in the current window */
  totalConsumed: number;
  /** ISO timestamp of the current window start */
  windowStart: string;
  /** ISO timestamp when the current window resets */
  resetsAt: string;
};

export type DeductResult = {
  /** Whether the deduction was successful */
  success: boolean;
  /** Credits remaining after deduction */
  remaining: number;
  /** The ledger entry created for this deduction */
  entry: LedgerEntry;
};

export type PaginatedLedger = {
  /** Ledger entries for the current page */
  entries: LedgerEntry[];
  /** Cursor for the next page, or null if no more entries */
  nextCursor: string | null;
};

export type BucketProvisionOptions = {
  /** Maximum credits for the bucket */
  creditsLimit: number;
  /** Duration of the rolling window in milliseconds */
  windowDurationMs: number;
};

/**
 * Storage adapter interface for credit data.
 * Implement this interface to use any database backend.
 */
export interface CreditStore {
  /**
   * Get a credit bucket by owner ID.
   * Returns null if no bucket exists for this owner.
   */
  getBucket(ownerId: string): Promise<CreditBucket | null>;

  /**
   * Create a new credit bucket for an owner.
   * Should throw if a bucket already exists for this owner.
   */
  createBucket(
    ownerId: string,
    options: BucketProvisionOptions,
  ): Promise<CreditBucket>;

  /**
   * Update a credit bucket.
   * Only the fields present in `updates` should be modified.
   */
  updateBucket(
    bucketId: string,
    updates: Partial<
      Pick<
        CreditBucket,
        | "creditsRemaining"
        | "creditsLimit"
        | "windowStart"
        | "totalConsumed"
        | "lastConsumedAt"
        | "updatedAt"
      >
    >,
  ): Promise<CreditBucket>;

  /**
   * Record a deduction in the ledger and update the bucket atomically.
   * Should decrement `creditsRemaining`, increment `totalConsumed`,
   * and insert a ledger entry in a single transaction.
   */
  deduct(
    bucketId: string,
    ownerId: string,
    amount: number,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeductResult>;

  /**
   * Get paginated ledger entries for a bucket.
   * Entries should be ordered by `createdAt` descending (newest first).
   */
  getLedger(
    bucketId: string,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedLedger>;
}

export type CreditManagerConfig = {
  /** The storage adapter to use */
  store: CreditStore;
  /** Default credit limit for new buckets (default: 1000) */
  defaultCredits?: number;
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
