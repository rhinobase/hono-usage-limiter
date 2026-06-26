# Hono Usage Limiter

[![npm version](https://img.shields.io/npm/v/hono-usage-limiter.svg)](https://npmjs.org/package/hono-usage-limiter "View this project on NPM")
[![npm downloads](https://img.shields.io/npm/dm/hono-usage-limiter)](https://www.npmjs.com/package/hono-usage-limiter)

A credit-based usage limiter for [Hono](https://hono.dev) applications. Unlike traditional rate limiters that treat every request equally, this library lets you assign weighted costs to operations and track consumption through a rolling usage bucket with a full audit ledger.

**Database-agnostic** -- bring your own storage by implementing the `UsageStore` interface. An in-memory store is included for testing.

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
    defaultWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    keyGenerator: (c) => c.get("userId"),
  }),
);

// Check balance
app.get("/usage", async (c) => {
  const balance = await c.get("usage").getBalance();
  return c.json(balance);
});

// Consume usage
app.post("/transcribe", async (c) => {
  const usage = c.get("usage");

  const status = await usage.check();
  if (!status.hasUsage) {
    return c.json({ error: "Usage limit exceeded" }, 429);
  }

  // Do expensive work...
  const result = await transcribe(audio);

  // Deduct actual cost
  await usage.deduct(30, "transcribe", { audioDurationSeconds: 30 });

  return c.json(result);
});
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
| `defaultWindowMs` | `number` | `2592000000` (30 days) | Default rolling window duration |
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

### `UsageStore` Interface

Implement this interface to use any database:

```typescript
interface UsageStore {
  getBucket(ownerId: string): Promise<UsageBucket | null>;
  createBucket(ownerId: string, options: UsageBucketProvisionOptions): Promise<UsageBucket>;
  updateBucket(bucketId: string, updates: Partial<...>): Promise<UsageBucket>;
  deduct(bucketId: string, ownerId: string, amount: number, reason: string, metadata?: Record<string, unknown>): Promise<UsageDeductResult>;
  getLedger(bucketId: string, cursor?: string, limit?: number): Promise<UsagePaginatedLedger>;
}
```

### `MemoryStore`

An in-memory `UsageStore` implementation for testing and prototyping. Import from `hono-usage-limiter/memory`.

```typescript
import { MemoryStore } from "hono-usage-limiter/memory";
```

## Contributing

Visit our [contributing docs](https://github.com/rhinobase/hono-usage-limiter/blob/main/CONTRIBUTING.md).

## License

MIT
