# Hono Usage Limiter

[![npm version](https://img.shields.io/npm/v/hono-usage-limiter.svg)](https://npmjs.org/package/hono-usage-limiter "View this project on NPM")
[![npm downloads](https://img.shields.io/npm/dm/hono-usage-limiter)](https://www.npmjs.com/package/hono-usage-limiter)

A credit-based usage limiter for [Hono](https://hono.dev) applications. Unlike traditional rate limiters that treat every request equally, this library lets you assign weighted costs to operations and track consumption through a rolling credit bucket with a full audit ledger.

**Database-agnostic** -- bring your own storage by implementing the `CreditStore` interface. An in-memory store is included for testing.

## Installation

```sh
npm install hono-usage-limiter
```

## Quick Start

```typescript
import { Hono } from "hono";
import { creditManager, type CreditEnv } from "hono-usage-limiter";
import { MemoryStore } from "hono-usage-limiter/memory";

const app = new Hono<CreditEnv>();

app.use(
  creditManager({
    store: new MemoryStore(),
    defaultCredits: 1000,
    defaultWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    keyGenerator: (c) => c.get("userId"),
  }),
);

// Check balance
app.get("/credits", async (c) => {
  const balance = await c.get("credit").getBalance();
  return c.json(balance);
});

// Consume credits
app.post("/transcribe", async (c) => {
  const credit = c.get("credit");

  const status = await credit.check();
  if (!status.hasCredits) {
    return c.json({ error: "Credit limit exceeded" }, 429);
  }

  // Do expensive work...
  const result = await transcribe(audio);

  // Deduct actual cost
  await credit.deduct(30, "transcribe", { audioDurationSeconds: 30 });

  return c.json(result);
});
```

## API

### `creditManager(config)`

Hono middleware that injects a `CreditManager` onto the context as `c.get("credit")`.

**Config options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `store` | `CreditStore` | *required* | Storage adapter |
| `keyGenerator` | `(c) => string` | *required* | Resolves owner ID from context |
| `defaultCredits` | `number` | `1000` | Default credit limit for new buckets |
| `defaultWindowMs` | `number` | `2592000000` (30 days) | Default rolling window duration |
| `autoProvision` | `boolean` | `true` | Auto-create bucket if none exists |

### `CreditManager`

Available via `c.get("credit")` in your handlers:

| Method | Description |
|---|---|
| `check()` | Returns `CreditStatus` with `remaining`, `limit`, `hasCredits`, `resetsAt` |
| `deduct(amount, reason, metadata?)` | Deducts credits and records a ledger entry |
| `getBalance()` | Returns full `BalanceInfo` including `totalConsumed` and window timestamps |
| `getHistory(cursor?, limit?)` | Returns paginated ledger entries (newest first) |
| `reset()` | Refills credits to the limit and starts a new window |
| `provision(options)` | Creates or updates a bucket with new plan settings |

### `CreditStore` Interface

Implement this interface to use any database:

```typescript
interface CreditStore {
  getBucket(ownerId: string): Promise<CreditBucket | null>;
  createBucket(ownerId: string, options: BucketProvisionOptions): Promise<CreditBucket>;
  updateBucket(bucketId: string, updates: Partial<...>): Promise<CreditBucket>;
  deduct(bucketId: string, ownerId: string, amount: number, reason: string, metadata?: Record<string, unknown>): Promise<DeductResult>;
  getLedger(bucketId: string, cursor?: string, limit?: number): Promise<PaginatedLedger>;
}
```

### `MemoryStore`

An in-memory `CreditStore` implementation for testing and prototyping. Import from `hono-usage-limiter/memory`.

```typescript
import { MemoryStore } from "hono-usage-limiter/memory";
```

## Contributing

Visit our [contributing docs](https://github.com/rhinobase/hono-usage-limiter/blob/main/CONTRIBUTING.md).

## License

MIT
