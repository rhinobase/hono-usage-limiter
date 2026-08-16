import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageManager, type UsageEnv } from "./middleware";
import { UsageManager } from "./manager";
import { MemoryStore } from "./memory";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("should return null for non-existent bucket", async () => {
    const bucket = await store.getBucket("unknown");
    expect(bucket).toBeNull();
  });

  it("should create a bucket", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 500,
      windowDurationMs: 1000 * 60 * 60,
    });

    expect(bucket.ownerId).toBe("user-1");
    expect(bucket.usageRemaining).toBe(500);
    expect(bucket.usageLimit).toBe(500);
    expect(bucket.totalConsumed).toBe(0);
    expect(bucket.lastConsumedAt).toBeNull();
  });

  it("should throw when creating a duplicate bucket", async () => {
    await store.createBucket("user-1", {
      usageLimit: 500,
      windowDurationMs: 1000,
    });

    await expect(
      store.createBucket("user-1", {
        usageLimit: 500,
        windowDurationMs: 1000,
      }),
    ).rejects.toThrow('Usage bucket already exists for owner "user-1"');
  });

  it("should get a bucket by owner ID", async () => {
    await store.createBucket("user-1", {
      usageLimit: 1000,
      windowDurationMs: 1000,
    });

    const bucket = await store.getBucket("user-1");
    expect(bucket).not.toBeNull();
    expect(bucket?.ownerId).toBe("user-1");
    expect(bucket?.usageRemaining).toBe(1000);
  });

  it("should update a bucket", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 1000,
      windowDurationMs: 1000,
    });

    const updated = await store.updateBucket(bucket.id, {
      usageRemaining: 800,
      totalConsumed: 200,
    });

    expect(updated.usageRemaining).toBe(800);
    expect(updated.totalConsumed).toBe(200);
    expect(updated.usageLimit).toBe(1000);
  });

  it("should throw when updating a non-existent bucket", async () => {
    await expect(
      store.updateBucket("unknown", { usageRemaining: 0 }),
    ).rejects.toThrow('Usage bucket "unknown" not found');
  });

  it("should deduct usage and create a ledger entry", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 1000,
      windowDurationMs: 1000,
    });

    const result = await store.deduct(
      bucket.id,
      "user-1",
      30,
      "inference",
      { inputTokens: 30 },
    );

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(970);
    expect(result.entry.amount).toBe(30);
    expect(result.entry.reason).toBe("inference");
    expect(result.entry.metadata).toEqual({ inputTokens: 30 });
  });

  it("should allow going negative", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });

    const result = await store.deduct(
      bucket.id,
      "user-1",
      25,
      "inference",
    );

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(-15);
  });

  it("should return paginated ledger entries", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 1000,
      windowDurationMs: 1000,
    });

    // Create 5 entries
    for (let i = 0; i < 5; i++) {
      await store.deduct(bucket.id, "user-1", 10, `op-${i}`);
    }

    // Get first page (limit 2)
    const page1 = await store.getLedger(bucket.id, undefined, 2);
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // Get second page
    const page2 = await store.getLedger(
      bucket.id,
      page1.nextCursor!,
      2,
    );
    expect(page2.entries).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    // Get third page
    const page3 = await store.getLedger(
      bucket.id,
      page2.nextCursor!,
      2,
    );
    expect(page3.entries).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it("should return ledger entries newest first", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 1000,
      windowDurationMs: 1000,
    });

    await store.deduct(bucket.id, "user-1", 10, "first");
    await store.deduct(bucket.id, "user-1", 20, "second");
    await store.deduct(bucket.id, "user-1", 30, "third");

    const { entries } = await store.getLedger(bucket.id);
    expect(entries[0].reason).toBe("third");
    expect(entries[1].reason).toBe("second");
    expect(entries[2].reason).toBe("first");
  });

  it("refuses tryDeduct without mutating balance or ledger", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });

    const result = await store.tryDeduct(
      bucket.id,
      "user-1",
      11,
      "inference",
    );

    expect(result).toEqual({ success: false, remaining: 10, entry: null });
    expect((await store.getLedger(bucket.id)).entries).toHaveLength(0);
  });

  it("allows tryDeduct at the exact remaining balance", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });

    const result = await store.tryDeduct(
      bucket.id,
      "user-1",
      10,
      "inference",
    );

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.entry.amount).toBe(10);
  });

  it("credits above the configured limit without changing consumed usage", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await store.deduct(bucket.id, "user-1", 4, "inference");

    const result = await store.credit(
      bucket.id,
      "user-1",
      20,
      "admin-grant",
    );

    expect(result.remaining).toBe(26);
    expect((await store.getBucket("user-1"))?.totalConsumed).toBe(4);
    expect(result.entry.amount).toBe(-20);
  });

  it("returns the winning rollover unchanged to a stale caller", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });

    const winning = await store.rolloverWindow(bucket.id, bucket.windowStart, {
      windowStart: bucket.windowStart + 1000,
      usageLimit: 20,
      windowDurationMs: 2000,
    });
    const stale = await store.rolloverWindow(bucket.id, bucket.windowStart, {
      windowStart: bucket.windowStart + 2000,
      usageLimit: 30,
      windowDurationMs: 3000,
    });

    expect(stale).toEqual(winning);
    expect(stale.usageRemaining).toBe(20);
    expect(stale.totalConsumed).toBe(0);
  });

  it("resets all balances while preserving windows and ledger history", async () => {
    const first = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    const second = await store.createBucket("user-2", {
      usageLimit: 20,
      windowDurationMs: 2000,
    });
    await store.deduct(first.id, "user-1", 4, "inference");
    await store.deduct(second.id, "user-2", 8, "inference");

    expect(await store.resetAll()).toBe(2);
    expect(await store.getBucket("user-1")).toMatchObject({
      usageRemaining: 10,
      totalConsumed: 0,
      windowStart: first.windowStart,
      windowDurationMs: first.windowDurationMs,
    });
    expect(await store.getBucket("user-2")).toMatchObject({
      usageRemaining: 20,
      totalConsumed: 0,
      windowStart: second.windowStart,
      windowDurationMs: second.windowDurationMs,
    });
    expect((await store.getLedger(first.id)).entries).toHaveLength(1);
  });

  it("uses exclusive bucket cursors at keyset page boundaries", async () => {
    await store.createBucket("user-1", { usageLimit: 10, windowDurationMs: 1000 });
    await store.createBucket("user-2", { usageLimit: 10, windowDurationMs: 1000 });
    await store.createBucket("user-3", { usageLimit: 10, windowDurationMs: 1000 });

    const firstPage = await store.listBuckets(undefined, 2);
    const secondPage = await store.listBuckets(firstPage.nextCursor!, 2);
    const ids = [...firstPage.buckets, ...secondPage.buckets].map(
      (bucket) => bucket.id,
    );

    expect(firstPage.buckets).toHaveLength(2);
    expect(firstPage.nextCursor).toBe(firstPage.buckets[1].id);
    expect(secondPage.buckets).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([...ids].sort());
  });

  it("normalizes zero and oversized ledger limits", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 200,
      windowDurationMs: 1000,
    });
    for (let index = 0; index < 101; index++) {
      await store.deduct(bucket.id, "user-1", 1, "inference");
    }

    expect((await store.getLedger(bucket.id, undefined, 0)).entries).toHaveLength(1);
    const page = await store.getLedger(bucket.id, undefined, 101);
    expect(page.entries).toHaveLength(100);
    expect(page.nextCursor).toBe(page.entries[99].id);
  });
});

describe("UsageManager", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("should auto-provision a bucket on check()", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 500,
      defaultWindowDurationMs: 1000 * 60 * 60,
    });

    const status = await manager.check();
    expect(status.remaining).toBe(500);
    expect(status.limit).toBe(500);
    expect(status.hasUsage).toBe(true);
  });

  it("should throw on check() if autoProvision is false and no bucket exists", async () => {
    const manager = new UsageManager("user-1", {
      store,
      autoProvision: false,
    });

    await expect(manager.check()).rejects.toThrow(
      'No usage bucket found for owner "user-1"',
    );
  });

  it("should deduct usage", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 100,
    });

    // Trigger auto-provision
    await manager.check();

    const result = await manager.deduct(30, "inference", {
      inputTokens: 30,
    });

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(70);

    const status = await manager.check();
    expect(status.remaining).toBe(70);
  });

  it("should return full balance info", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    await manager.deduct(150, "inference");

    const balance = await manager.getBalance();
    expect(balance.remaining).toBe(850);
    expect(balance.limit).toBe(1000);
    expect(balance.totalConsumed).toBe(150);
    expect(balance.windowStart).toBeTruthy();
    expect(balance.resetsAt).toBeTruthy();
  });

  it("should return ledger history", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    await manager.deduct(10, "inference");
    await manager.deduct(20, "post-process");

    const history = await manager.getHistory();
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0].reason).toBe("post-process");
    expect(history.entries[1].reason).toBe("inference");
  });

  it("should reset the bucket", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    await manager.deduct(500, "inference");

    const statusBefore = await manager.check();
    expect(statusBefore.remaining).toBe(500);

    await manager.reset();

    const statusAfter = await manager.check();
    expect(statusAfter.remaining).toBe(1000);
  });

  it("should provision a new bucket with custom settings", async () => {
    const manager = new UsageManager("user-1", { store });

    const bucket = await manager.provision({
      usageLimit: 5000,
      windowDurationMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(bucket.usageLimit).toBe(5000);
    expect(bucket.usageRemaining).toBe(5000);
  });

  it("should update an existing bucket via provision()", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    // Create initial bucket
    await manager.check();
    await manager.deduct(200, "inference");

    // Upgrade plan
    const bucket = await manager.provision({
      usageLimit: 5000,
      windowDurationMs: 30 * 24 * 60 * 60 * 1000,
      resetRemaining: true,
    });

    expect(bucket.usageLimit).toBe(5000);
    expect(bucket.usageRemaining).toBe(5000);
  });

  it("should auto-refill when window expires", async () => {
    vi.useFakeTimers();
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 100,
      defaultWindowDurationMs: 50, // 50ms window
    });

    await manager.deduct(60, "inference");
    const statusBefore = await manager.check();
    expect(statusBefore.remaining).toBe(40);

    vi.advanceTimersByTime(50);

    const statusAfter = await manager.check();
    expect(statusAfter.remaining).toBe(100);
    expect(statusAfter.hasUsage).toBe(true);
    vi.useRealTimers();
  });

  it("should throw on invalid deduct amount", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 100,
    });

    await expect(manager.deduct(0, "test")).rejects.toThrow(
      "Deduction amount must be a positive finite number",
    );
    await expect(manager.deduct(-5, "test")).rejects.toThrow(
      "Deduction amount must be a positive finite number",
    );
    await expect(manager.deduct(NaN, "test")).rejects.toThrow(
      "Deduction amount must be a positive finite number",
    );
    await expect(manager.deduct(Infinity, "test")).rejects.toThrow(
      "Deduction amount must be a positive finite number",
    );
  });

  it("should update limit without resetting remaining", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    await manager.check();
    await manager.deduct(200, "inference");

    const bucket = await manager.provision({
      usageLimit: 5000,
      windowDurationMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(bucket.usageLimit).toBe(5000);
    expect(bucket.usageRemaining).toBe(800);
  });

  it("refuses tryDeduct without changing the available balance", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 10,
    });

    const result = await manager.tryDeduct(11, "inference");

    expect(result).toEqual({ success: false, remaining: 10, entry: null });
    expect((await manager.check()).remaining).toBe(10);
    expect((await manager.getHistory()).entries).toHaveLength(0);
  });

  it("rejects invalid credit amounts", async () => {
    const manager = new UsageManager("user-1", { store });

    await expect(manager.credit(0, "admin-grant")).rejects.toThrow(
      "Credit amount must be a positive finite number",
    );
    await expect(manager.credit(Number.NaN, "admin-grant")).rejects.toThrow(
      "Credit amount must be a positive finite number",
    );
  });

  it("expires current-window credit when the window rolls over", async () => {
    vi.useFakeTimers();
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 10,
      defaultWindowDurationMs: 50,
    });

    await manager.credit(20, "admin-grant");
    expect((await manager.check()).remaining).toBe(30);
    vi.advanceTimersByTime(50);

    expect((await manager.check()).remaining).toBe(10);
    vi.useRealTimers();
  });

  it("reconciles the configured plan only during rollover", async () => {
    vi.useFakeTimers();
    await store.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 50,
    });
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 200,
      defaultWindowDurationMs: 100,
      reconcileLimit: true,
    });

    expect((await manager.check()).limit).toBe(100);
    vi.advanceTimersByTime(50);

    expect((await manager.check()).limit).toBe(200);
    vi.useRealTimers();
  });

  it("keeps stored plan settings during rollover by default", async () => {
    vi.useFakeTimers();
    await store.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 50,
    });
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 200,
      defaultWindowDurationMs: 100,
    });

    vi.advanceTimersByTime(50);

    const balance = await manager.getBalance();
    expect(balance.limit).toBe(100);
    expect(new Date(balance.resetsAt).getTime() - new Date(balance.windowStart).getTime()).toBe(50);
    vi.useRealTimers();
  });

  it("uses the winning rollover bucket when another manager advances the window", async () => {
    vi.useFakeTimers();
    const first = new UsageManager("user-1", {
      store,
      defaultUsage: 300,
      defaultWindowDurationMs: 50,
      reconcileLimit: true,
    });
    const second = new UsageManager("user-1", {
      store,
      defaultUsage: 200,
      defaultWindowDurationMs: 50,
      reconcileLimit: true,
    });

    await first.check();
    vi.advanceTimersByTime(50);
    expect((await second.check()).limit).toBe(200);

    expect((await first.check()).limit).toBe(200);
    vi.useRealTimers();
  });
});

describe("usageManager middleware", () => {
  it("should support a store factory function", async () => {
    const store = new MemoryStore();
    const factory = () => store;

    const app = new Hono<UsageEnv & { Variables: { userId: string } }>();

    app.use(async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });

    app.use(
      usageManager({
        store: factory,
        defaultUsage: 200,
        keyGenerator: (c) =>
          (c as { get: (key: string) => string }).get("userId"),
      }),
    );

    app.get("/balance", async (c) => {
      const balance = await c.get("usage").getBalance();
      return c.json(balance);
    });

    const res = await app.request("/balance");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.remaining).toBe(200);
    expect(body.limit).toBe(200);
  });

  it("should call store factory with the Hono context on each request", async () => {
    const stores: Record<string, MemoryStore> = {};
    let factoryCallCount = 0;

    const factory = (c: unknown) => {
      factoryCallCount++;
      const ctx = c as { get: (key: string) => string };
      const userId = ctx.get("userId");
      // Return a per-user store to prove context is being passed
      if (!stores[userId]) {
        stores[userId] = new MemoryStore();
      }
      return stores[userId];
    };

    const app = new Hono<UsageEnv & { Variables: { userId: string } }>();

    app.use(async (c, next) => {
      const id = c.req.header("x-user-id") ?? "unknown";
      c.set("userId", id);
      await next();
    });

    app.use(
      usageManager({
        store: factory,
        defaultUsage: 100,
        keyGenerator: (c) =>
          (c as { get: (key: string) => string }).get("userId"),
      }),
    );

    app.get("/balance", async (c) => {
      const balance = await c.get("usage").getBalance();
      return c.json(balance);
    });

    // Two requests — factory should be called each time
    const res1 = await app.request("/balance", {
      headers: { "x-user-id": "user-a" },
    });
    const res2 = await app.request("/balance", {
      headers: { "x-user-id": "user-b" },
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(factoryCallCount).toBe(2);

    // Each user should have their own isolated store
    expect(Object.keys(stores)).toEqual(["user-a", "user-b"]);
  });

  it("should inject UsageManager onto context", async () => {
    const store = new MemoryStore();
    const app = new Hono<UsageEnv & { Variables: { userId: string } }>();

    app.use(async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });

    app.use(
      usageManager({
        store,
        defaultUsage: 500,
        keyGenerator: (c) =>
          (c as { get: (key: string) => string }).get("userId"),
      }),
    );

    app.get("/balance", async (c) => {
      const balance = await c.get("usage").getBalance();
      return c.json(balance);
    });

    const res = await app.request("/balance");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.remaining).toBe(500);
    expect(body.limit).toBe(500);
  });

  it("should support deducting usage via context", async () => {
    const store = new MemoryStore();
    const app = new Hono<UsageEnv & { Variables: { userId: string } }>();

    app.use(async (c, next) => {
      c.set("userId", "user-1");
      await next();
    });

    app.use(
      usageManager({
        store,
        defaultUsage: 100,
        keyGenerator: (c) =>
          (c as { get: (key: string) => string }).get("userId"),
      }),
    );

    app.post("/consume", async (c) => {
      const usage = c.get("usage");

      const status = await usage.check();
      if (!status.hasUsage) {
        return c.json({ error: "Usage limit exceeded" }, 429);
      }

      const result = await usage.deduct(30, "inference", {
        inputTokens: 30,
      });

      return c.json({
        remaining: result.remaining,
        success: result.success,
      });
    });

    // First request
    const res1 = await app.request("/consume", { method: "POST" });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.remaining).toBe(70);

    // Second request
    const res2 = await app.request("/consume", { method: "POST" });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.remaining).toBe(40);
  });
});
