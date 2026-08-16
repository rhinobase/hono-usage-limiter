# Usage Store Integration Design

## Purpose

Replace the overlapping feature branches from pull requests #5, #7, #8, #9,
and #10 with one coherent, breaking store-contract update. The package has no
known third-party `UsageStore` implementations, so every built-in store and
any future store must implement the complete contract.

## Goals

- Provide a hard, gate-and-deduct operation for callers that must not
  overspend a bucket.
- Keep `deduct()` as the existing soft-limit operation for callers that
  intentionally allow a negative balance.
- Provide current-window grants through `credit()` without inventing refund
  correlation state or restricting grants to the configured plan limit.
- Make window rollover a single compare-and-set operation that can reconcile
  a changed limit and window duration without overwriting concurrent work.
- Make cache, pagination, reverse lookup, and administration features obey
  the same store contract.

## Non-goals

- Correlating credits to a prior deduction, supporting partial refunds, or
  preventing a caller from granting usage more than once.
- Making a generic Unstorage driver strongly atomic across isolates. Its
  underlying key-value abstraction has no compare-and-set primitive.
- Retaining source compatibility for custom `UsageStore` implementations.

## Public contract

`UsageStore` becomes generic over the allowed ledger reasons and requires all
operations below. Its generic defaults to `string`, while a caller can use a
literal union such as `UsageStore<"inference" | "embedding">`.

```ts
type UsageRolloverOptions = {
  windowStart: number;
  usageLimit: number;
  windowDurationMs: number;
};

type UsageBucketUpdates = Partial<
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
>;

interface UsageStore<Reason extends string = string> {
  getBucket(ownerId: string): Promise<UsageBucket | null>;
  createBucket(ownerId: string, options: UsageBucketProvisionOptions): Promise<UsageBucket>;
  updateBucket(bucketId: string, updates: UsageBucketUpdates): Promise<UsageBucket>;
  deduct(bucketId: string, ownerId: string, amount: number, reason: Reason, metadata?: Record<string, unknown>): Promise<UsageDeductResult<Reason>>;
  tryDeduct(bucketId: string, ownerId: string, amount: number, reason: Reason, metadata?: Record<string, unknown>): Promise<UsageTryDeductResult<Reason>>;
  credit(bucketId: string, ownerId: string, amount: number, reason: Reason, metadata?: Record<string, unknown>): Promise<UsageCreditResult<Reason>>;
  rolloverWindow(bucketId: string, expectedWindowStart: number, options: UsageRolloverOptions): Promise<UsageBucket>;
  getLedger(bucketId: string, cursor?: string, limit?: number): Promise<UsagePaginatedLedger<Reason>>;
  resetAll(): Promise<number>;
  listBuckets(cursor?: string, limit?: number): Promise<UsagePaginatedBuckets>;
}
```

`UsageLedgerEntry`, `UsageDeductResult`, `UsageTryDeductResult`,
`UsageCreditResult`, and `UsagePaginatedLedger` carry the same `Reason`
generic. `UsageManager`, its constructor options, and `usageManager()` also
carry it, so `deduct`, `tryDeduct`, and `credit` reject an unknown reason at
compile time. Middleware additionally remains generic over Hono's `Env`, so
store factories and key generators receive the app's typed `Context`.

This is a breaking release: any existing custom store must implement the new
methods before it can be passed to a manager.

## Operation semantics

### Soft deduction

`deduct()` preserves the package's current behavior. It always writes a
positive ledger entry, subtracts the amount from `usageRemaining`, adds it to
`totalConsumed`, and may drive the balance below zero.

### Hard deduction

`tryDeduct()` validates a positive finite amount, then performs the balance
test and the ledger/bucket write as one store operation. A successful result
contains a positive entry. If the available balance is smaller than the
amount, it returns `{ success: false, remaining, entry: null }` and must not
write either a ledger entry or a bucket update.

`D1Store` must make the conditional bucket change and ledger insert part of a
single D1 transaction. `MemoryStore` is serial within its JavaScript turn.
`UnstorageStore` implements the required API, but its read-modify-write path
is explicitly documented as best-effort for drivers without conditional
writes; callers requiring cross-instance atomicity use `D1Store` or another
transactional store.

### General-purpose credit

`credit()` validates a positive finite amount and grants usage in the current
window. It increases `usageRemaining` without capping it at `usageLimit` and
writes a negative ledger entry. It does not change `totalConsumed`: that field
means actual positive consumption in the current window, not net allowance
after manual grants. Credits reset with the next rollover because rollover
sets the balance to the new window's configured allowance.

### Atomic window rollover

When a bucket window is expired, `UsageManager` calls `rolloverWindow()` with
the window it observed and the complete next-window configuration. The store
updates only when `windowStart` still equals `expectedWindowStart`; on success
it sets the new window start, limit, duration, balance, zero consumption, and
updated timestamp together. If another request already advanced the window,
the store returns that current bucket unchanged. The manager uses that result
instead of issuing a second blind update.

With `reconcileLimit: false` (the default), rollover supplies the bucket's
stored limit and duration. With `reconcileLimit: true`, it supplies the
manager defaults. Thus plan changes take effect only at rollover and never
rewrite an active window.

### Administrative operations and pagination

`resetAll()` refills every bucket to its own configured `usageLimit`, resets
`totalConsumed`, preserves each window start and duration, and returns the
number of affected buckets. It does not delete ledger history.

`listBuckets()` orders by bucket ID and uses keyset pagination. A shared
`normalizePageLimit()` helper is the sole implementation of limits for both
bucket and ledger pages: `undefined` becomes 20, finite values are truncated
and clamped to the inclusive range 1 through 100, and non-finite values throw
a clear error. This prevents the prior empty-page cursor error for zero and
the unbounded negative-limit behavior in SQLite.

## Built-in stores

`MemoryStore`, `D1Store`, and `UnstorageStore` implement every method.

- `D1Store` uses conditional SQL and transaction batches for hard deduction
  and rollover; bulk reset is one set-based update; bucket listing is keyset
  paginated SQL.
- `MemoryStore` updates cloned bucket values, keeps positive and negative
  ledger entries in its existing index, and performs deterministic pagination.
- `UnstorageStore` writes `bucket-owner:{bucketId}` when creating a bucket.
  If an existing bucket lacks that key, operations fall back to a one-time scan
  for the bucket ID, save the reverse key, then continue. Bucket enumeration
  filters reverse-index keys and remains an explicitly administrative O(n)
  operation.

## Cached store

`CachedUsageStore` remains an exported `./cache` wrapper and implements the
entire mandatory store interface. Read methods may return a short-lived cached
bucket, but every mutation delegates to the wrapped store first and only then
patches or replaces the cache. `tryDeduct()` never relies on a cached balance.

Cache keys include a cache epoch. After a successful `resetAll()`, the wrapper
advances that epoch so all previous cached buckets become unreachable without
requiring a non-portable prefix-delete capability from `UsageCache`. A mutation
that races this epoch change can only populate an old epoch key; it cannot
replace a post-reset cached value.

## Error handling

Managers reject non-positive and non-finite amounts before calling any store.
Stores throw a not-found error when the supplied bucket ID does not exist.
`tryDeduct()` uses its refusal result only for insufficient remaining balance;
it does not turn database, serialization, or cache failures into a refusal.

## Test strategy

Tests are written before production code and must cover:

- hard deduction success, exact-balance success, and refusal with no bucket or
  ledger mutation;
- general-purpose credits above the configured limit, negative ledger entries,
  unchanged positive-consumption total, and rollover expiry of granted usage;
- compare-and-set rollover, concurrent-winner result handling, and both
  `reconcileLimit` modes;
- page-limit normalization for undefined, zero, negative, oversized, decimal,
  and non-finite values, plus no overlap between pages;
- `resetAll` behavior and cache-epoch invalidation;
- Unstorage lazy backfill for a bucket created before the reverse index;
- typed-reason compile assertions covering `deduct`, `tryDeduct`, and
  `credit`;
- cache delegation and cache patching for every mutation.

The full Vitest suite, Biome check, and pkgroll build must pass before the
replacement PR is opened.
