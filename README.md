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

// Consume usage
app.post("/inference", async (c) => {
  const usage = c.get("usage");

  // Atomically gate-and-deduct: refuses (and writes nothing) when the caller
  // is out of budget. Prefer this over a manual check()-then-deduct() — the
  // check and the write happen atomically so concurrent requests can't both
  // pass the gate and overspend a shared bucket.
  const gate = await usage.tryDeduct(30, "inference", {
    inputTokens: 500,
    outputTokens: 150,
  });
  if (!gate.success) {
    return c.json({ error: "Usage limit exceeded" }, 429);
  }

  // Do expensive work...
  const result = await runInference(input);

  return c.json(result);
});
```

### Gate up front vs. meter after

`tryDeduct()` refuses when the balance is insufficient — use it when you want a
hard limit before doing the work. If instead you meter *actual* usage after the
work completes (and are fine with the final operation overshooting the balance
as a soft limit), use `check()` to gate and `deduct()` to record the real cost:

```typescript
app.post("/inference", async (c) => {
  const usage = c.get("usage");

  const status = await usage.check();
  if (!status.hasUsage) {
    return c.json({ error: "Usage limit exceeded" }, 429);
  }

  const result = await runInference(input); // cost not known until now
  await usage.deduct(result.tokensUsed, "inference");

  return c.json(result);
});
```

> `deduct()` is unconditional and may drive the balance negative (a soft limit).
> `tryDeduct()` is conditional and never overspends (a hard limit).

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
  getLedger(bucketId, cursor?, limit?) { /* ... */ }
  // Optional: an atomic window refill guarded on windowStart. When omitted,
  // the manager falls back to a best-effort updateBucket on window rollover.
  refillWindow?(bucketId, expectedWindowStart, newWindowStart) { /* ... */ }
}
```

### `CachedUsageStore`

Wraps any `UsageStore` with a short-lived read-through cache over the per-owner
bucket read. On a remote store (e.g. D1) the `getBucket` behind every `check()`
is often the hottest, slowest path; the balance only changes on a write, so
caching it for a short TTL removes that read from the common path. Writes always
go straight to the underlying store, and the cached copy is patched in step
after each write, so the authoritative balance is never served from cache.

Bring your own cache backend by implementing the small `UsageCache` interface
(`get`/`set`/`delete`) — e.g. over the Cloudflare Cache API, a `Map`, or Redis.

```typescript
import { CachedUsageStore } from "hono-usage-limiter/cache";
import { D1Store } from "hono-usage-limiter/d1";

const store = new CachedUsageStore({
  store: new D1Store({ db: env.DB }),
  cache: {
    get: (key) => myCache.get(key),
    set: (key, value, ttlSeconds) => myCache.set(key, value, ttlSeconds),
    delete: (key) => myCache.delete(key),
  },
  ttlSeconds: 120, // default
});
```

## Typed context

Pass your app's `Env` as a type argument to `usageManager` and the context in
both `store` (factory form) and `keyGenerator` is fully typed — no casts:

```typescript
import type { D1Database } from "@cloudflare/workers-types";
import { usageManager, type UsageEnv } from "hono-usage-limiter";
import { D1Store } from "hono-usage-limiter/d1";

type AppEnv = {
  Bindings: { DB: D1Database };
  Variables: { userId: string };
};

const app = new Hono<AppEnv & UsageEnv>();

app.use(
  usageManager<AppEnv>({
    store: (c) => new D1Store({ db: c.env.DB }), // c.env is typed
    keyGenerator: (c) => c.get("userId"), // c.get is typed
  }),
);
```

## API

### `usageManager(config)`

Hono middleware that injects a `UsageManager` onto the context as `c.get("usage")`.

**Config options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `UsageStore` | *required* | Storage adapter |
| `keyGenerator` | `(c) => string` | *required* | Resolves owner ID from context |
| `defaultUsage` | `number` | `1000` | Default usage limit for new buckets |
| `defaultWindowDurationMs` | `number` | `2592000000` (30 days) | Default rolling window duration |
| `autoProvision` | `boolean` | `true` | Auto-create bucket if none exists |

### `UsageManager`

Available via `c.get("usage")` in your handlers:

| Method | Description |
|---|---|
| `check()` | Returns `UsageStatus` with `remaining`, `limit`, `hasUsage`, `resetsAt` |
| `deduct(amount, reason, metadata?)` | Unconditionally deducts usage and records a ledger entry (may go negative) |
| `tryDeduct(amount, reason, metadata?)` | Atomically deducts **only if** the balance allows; returns `{ success: false, entry: null }` when insufficient (nothing written) |
| `getBalance()` | Returns full `UsageBalanceInfo` including `totalConsumed` and window timestamps |
| `getHistory(cursor?, limit?)` | Returns paginated ledger entries (newest first) |
| `reset()` | Refills usage to the limit and starts a new window |
| `provision(options)` | Creates or updates a bucket with new plan settings |

## Contributing

Visit our [contributing docs](https://github.com/rhinobase/hono-usage-limiter/blob/main/CONTRIBUTING.md).

## License

MIT
