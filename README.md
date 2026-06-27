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

  const status = await usage.check();
  if (!status.hasUsage) {
    return c.json({ error: "Usage limit exceeded" }, 429);
  }

  // Do expensive work...
  const result = await runInference(input);

  // Deduct actual cost
  await usage.deduct(30, "inference", { inputTokens: 500, outputTokens: 150 });

  return c.json(result);
});
```

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
  getLedger(bucketId, cursor?, limit?) { /* ... */ }
}
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
| `deduct(amount, reason, metadata?)` | Deducts usage and records a ledger entry |
| `getBalance()` | Returns full `UsageBalanceInfo` including `totalConsumed` and window timestamps |
| `getHistory(cursor?, limit?)` | Returns paginated ledger entries (newest first) |
| `reset()` | Refills usage to the limit and starts a new window |
| `provision(options)` | Creates or updates a bucket with new plan settings |

## Contributing

Visit our [contributing docs](https://github.com/rhinobase/hono-usage-limiter/blob/main/CONTRIBUTING.md).

## License

MIT
