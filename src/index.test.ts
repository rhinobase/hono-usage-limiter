import { Hono } from "hono";
import { describe, expect, it, beforeEach } from "vitest";
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
      "transcribe",
      { audioDurationSeconds: 30 },
    );

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(970);
    expect(result.entry.amount).toBe(30);
    expect(result.entry.reason).toBe("transcribe");
    expect(result.entry.metadata).toEqual({ audioDurationSeconds: 30 });
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
      "transcribe",
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

    const result = await manager.deduct(30, "transcribe", {
      audioDurationSeconds: 30,
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

    await manager.deduct(150, "transcribe");

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

    await manager.deduct(10, "transcribe");
    await manager.deduct(20, "post-process");

    const history = await manager.getHistory();
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0].reason).toBe("post-process");
    expect(history.entries[1].reason).toBe("transcribe");
  });

  it("should reset the bucket", async () => {
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    await manager.deduct(500, "transcribe");

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
    await manager.deduct(200, "transcribe");

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
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 100,
      defaultWindowDurationMs: 50, // 50ms window
    });

    await manager.deduct(60, "transcribe");
    const statusBefore = await manager.check();
    expect(statusBefore.remaining).toBe(40);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    const statusAfter = await manager.check();
    expect(statusAfter.remaining).toBe(100);
    expect(statusAfter.hasUsage).toBe(true);
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
    await manager.deduct(200, "transcribe");

    const bucket = await manager.provision({
      usageLimit: 5000,
      windowDurationMs: 30 * 24 * 60 * 60 * 1000,
    });

    expect(bucket.usageLimit).toBe(5000);
    expect(bucket.usageRemaining).toBe(800);
  });
});

describe("usageManager middleware", () => {
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

      const result = await usage.deduct(30, "transcribe", {
        audioDurationSeconds: 30,
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
