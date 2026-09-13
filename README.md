# Hono Usage Limiter

[![npm version](https://img.shields.io/npm/v/hono-usage-limiter.svg)](https://npmjs.org/package/hono-usage-limiter "View this project on NPM")
[![npm downloads](https://img.shields.io/npm/dm/hono-usage-limiter)](https://www.npmjs.com/package/hono-usage-limiter)

A credit-based usage limiter for [Hono](https://hono.dev) applications. Unlike traditional rate limiters that treat every request equally, this library lets you assign weighted costs to operations and track consumption through a rolling usage bucket with a full audit ledger.

**Database-agnostic** -- bring your own storage by implementing the `UsageStore` interface, or use one of the built-in adapters.

## Installation

```sh
npm install hono-usage-limiter
```

## Quick Start

```typescript
import { Hono } from "hono";
import { usageManager, type UsageEnv } from "hono-usage-limiter";
import { MemoryStore } from "hono-usage-limiter/memory";

const app = new Hono<UsageEnv>();

app.use(
  usageManager({
    store: new MemoryStore(),
    defaultUsage: 1000,
    defaultWindowDurationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    keyGenerator: (c) => c.get("userId"),
  }),
);

// Check balance
app.get("/usage", async (c) => {
  const balance = await c.get("usage").getBalance();
  return c.json(balance);
});

// Atomically reserve usage before starting expensive work.
app.post("/inference", async (c) => {
  const usage = c.get("usage");

  const deduction = await usage.tryDeduct(
    30,
    "inference",
    { inputTokens: 500, outputTokens: 150 },
  );
  if (!deduction.success) {
    return c.json({ error: "Usage limit exceeded" }, 429);
  }

  // It is now safe to do expensive work.
  const result = await runInference(input);

  return c.json(result);
});
```

Use `tryDeduct()` to gate work that must not exceed the available balance. It
checks the balance and records the deduction as one store operation. Do not use
`check()` followed by `deduct()` for this gate: another request can consume the
balance between those calls. `deduct()` remains a soft operation for workflows
that intentionally permit a negative balance.

## Storage Adapters

### `MemoryStore`

In-memory adapter for testing and prototyping. Data is lost when the process exits.

```typescript
import { MemoryStore } from "hono-usage-limiter/memory";

const store = new MemoryStore();
```

### `UnstorageStore`

Adapter backed by [unstorage](https://unstorage.unjs.io), giving you access to 20+ storage drivers (Redis, Cloudflare KV, filesystem, etc.).

```sh
npm install unstorage
```

```typescript
import { createStorage } from "unstorage";
import { UnstorageStore } from "hono-usage-limiter/unstorage";

const storage = createStorage(); // or any unstorage driver
const store = new UnstorageStore({ storage });

// With a custom prefix to namespace keys
const store = new UnstorageStore({ storage, prefix: "my-app" });
```

### `D1Store`

Adapter for [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite at the edge). Requires creating two tables in your D1 database:

```sql
CREATE TABLE usage_buckets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE,
  usage_remaining INTEGER NOT NULL,
  usage_limit INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_duration_ms INTEGER NOT NULL,
  total_consumed INTEGER NOT NULL DEFAULT 0,
  last_consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  bucket_id TEXT NOT NULL REFERENCES usage_buckets(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_usage_ledger_bucket ON usage_ledger(bucket_id);
CREATE INDEX idx_usage_ledger_owner ON usage_ledger(owner_id);
```

```sh
npm install @cloudflare/workers-types
```

```typescript
import { D1Store } from "hono-usage-limiter/d1";

// In a Cloudflare Worker
const store = new D1Store({ db: env.DB });

// With custom table names
const store = new D1Store({
  db: env.DB,
  bucketsTable: "my_buckets",
  ledgerTable: "my_ledger",
});
```

### Request-scoped stores

Pass a store factory when an adapter depends on a binding from the Hono context.
The factory runs for each request, so it can create a `D1Store` from a
Cloudflare Worker's `DB` binding.

```typescript
import { Hono } from "hono";
import { usageManager } from "hono-usage-limiter";
import { D1Store } from "hono-usage-limiter/d1";

type Bindings = { DB: D1Database };

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  usageManager<{ Bindings: Bindings }>({
    store: (c) => new D1Store({ db: c.env.DB }),
    keyGenerator: (c) => c.req.header("x-user-id") ?? "anonymous",
  }),
);
```

### Custom Store

Implement the `UsageStore` interface to use any database:

```typescript
import type { UsageStore } from "hono-usage-limiter";

class MyStore implements UsageStore {
  getBucket(ownerId) { /* ... */ }
  createBucket(ownerId, options) { /* ... */ }
  updateBucket(bucketId, updates) { /* ... */ }
  deduct(bucketId, ownerId, amount, reason, metadata?) { /* ... */ }
  tryDeduct(bucketId, ownerId, amount, reason, metadata?) { /* ... */ }
  credit(bucketId, ownerId, amount, reason, metadata?) { /* ... */ }
  rolloverWindow(bucketId, expectedWindowStart, options) { /* ... */ }
  getLedger(bucketId, cursor?, limit?) { /* ... */ }
  resetAll() { /* ... */ }
  listBuckets(cursor?, limit?) { /* ... */ }
}
```

All of these methods are mandatory. `tryDeduct()` must make its balance check
and successful deduction atomic; a refused deduction returns
`{ success: false, remaining, entry: null }` without changing the bucket or
ledger. `rolloverWindow()` must only advance a window when its start still
matches `expectedWindowStart`.

## API

### `usageManager(config)`

Hono middleware that injects a `UsageManager` onto the context as `c.get("usage")`.

**Config options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `UsageStore \| (c) => UsageStore` | *required* | Storage adapter or request-scoped store factory |
| `keyGenerator` | `(c) => string` | *required* | Resolves owner ID from context |
| `defaultUsage` | `number` | `1000` | Default usage limit for new buckets |
| `defaultWindowDurationMs` | `number` | `2592000000` (30 days) | Default rolling window duration |
| `autoProvision` | `boolean` | `true` | Auto-create bucket if none exists |
| `reconcileLimit` | `boolean` | `false` | Apply configured defaults when an expired window rolls over |

### `UsageManager`

Available via `c.get("usage")` in your handlers:

| Method | Description |
|---|---|
| `check()` | Returns `UsageStatus` with `remaining`, `limit`, `hasUsage`, `resetsAt` |
| `deduct(amount, reason, metadata?)` | Soft deduction: records usage even when it makes the balance negative |
| `tryDeduct(amount, reason, metadata?)` | Hard deduction: atomically refuses when the balance is insufficient |
| `credit(amount, reason, metadata?)` | Grants usage and records a negative ledger entry |
| `getBalance()` | Returns full `UsageBalanceInfo` including `totalConsumed` and window timestamps |
| `getHistory(cursor?, limit?)` | Returns paginated ledger entries (newest first) |
| `reset()` | Refills usage to the limit and starts a new window |
| `provision(options)` | Creates or updates a bucket with new plan settings |

### Grant usage with `credit()`

Use `credit()` for administrator grants in the active window:

```typescript
await c.get("usage").credit(250, "administrator-grant", {
  ticket: "SUP-123",
});
```

Credits are not capped at `usageLimit`: a grant can take the current window's
remaining usage above its plan limit. Each grant writes a negative ledger
record and does not alter `totalConsumed`, which continues to represent only
positive usage consumed in the active window. Credits expire with that window.

### Reconcile plan settings at rollover

By default, an existing bucket keeps its stored limit and duration when its
window rolls over. Set `reconcileLimit: true` to apply `defaultUsage` and
`defaultWindowDurationMs` at the next rollover instead. This never rewrites an
active window.

### `CachedUsageStore`

`CachedUsageStore` is available from `hono-usage-limiter/cache` when you have a
short-lived asynchronous cache for bucket reads:

```typescript
import { CachedUsageStore } from "hono-usage-limiter/cache";
import { D1Store } from "hono-usage-limiter/d1";

const store = new CachedUsageStore({
  inner: new D1Store({ db: env.DB }),
  cache,
});
```

The wrapped store remains authoritative. Every mutation, including
`tryDeduct()`, runs against the inner store before the cache is refreshed, so a
cached balance is never used to approve a hard deduction. Ledger history and
bucket administration also use the inner store.

### Administration

`resetAll()` and `listBuckets()` are store-level operations for administrative
jobs. `resetAll()` refills every bucket to its own configured limit, resets
`totalConsumed`, preserves its window dates, and returns the number of buckets
changed; ledger history remains intact.

```typescript
const changed = await store.resetAll();
const page = await store.listBuckets(cursor, 50);
```

`listBuckets()` orders buckets by ID and uses keyset pagination. The same
pagination bounds apply to `listBuckets()` and `getHistory()`: the default is
20 entries, finite limits are truncated and clamped to the inclusive range 1
through 100, and non-finite limits throw an error.

## Contributing

Visit our [contributing docs](https://github.com/rhinobase/hono-usage-limiter/blob/main/CONTRIBUTING.md).

## License

MIT
