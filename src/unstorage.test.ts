import { createStorage } from "unstorage";
import { describe, expect, it, beforeEach } from "vitest";
import { UnstorageStore } from "./unstorage";
import { UsageManager } from "./manager";

describe("UnstorageStore", () => {
  let store: UnstorageStore;

  beforeEach(() => {
    const storage = createStorage();
    store = new UnstorageStore({ storage });
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

    for (let i = 0; i < 5; i++) {
      await store.deduct(bucket.id, "user-1", 10, `op-${i}`);
    }

    const page1 = await store.getLedger(bucket.id, undefined, 2);
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.getLedger(
      bucket.id,
      page1.nextCursor!,
      2,
    );
    expect(page2.entries).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

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

  it("should credit (refund) usage back with a negative ledger entry", async () => {
    const bucket = await store.createBucket("user-1", {
      usageLimit: 1000,
      windowDurationMs: 1000,
    });

    await store.deduct(bucket.id, "user-1", 100, "inference");
    const result = await store.credit(bucket.id, "user-1", 40, "refund");

    expect(result.remaining).toBe(940);
    expect(result.entry.amount).toBe(-40);

    const after = await store.getBucket("user-1");
    expect(after?.usageRemaining).toBe(940);
    expect(after?.totalConsumed).toBe(60);
  });

  it("should support custom prefix", async () => {
    const storage = createStorage();
    const store1 = new UnstorageStore({ storage, prefix: "app1" });
    const store2 = new UnstorageStore({ storage, prefix: "app2" });

    await store1.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 1000,
    });

    await store2.createBucket("user-1", {
      usageLimit: 500,
      windowDurationMs: 1000,
    });

    const bucket1 = await store1.getBucket("user-1");
    const bucket2 = await store2.getBucket("user-1");

    expect(bucket1?.usageLimit).toBe(100);
    expect(bucket2?.usageLimit).toBe(500);
  });
});

describe("UsageManager with UnstorageStore", () => {
  it("should work end-to-end with unstorage", async () => {
    const storage = createStorage();
    const store = new UnstorageStore({ storage });
    const manager = new UsageManager("user-1", {
      store,
      defaultUsage: 1000,
    });

    const status = await manager.check();
    expect(status.remaining).toBe(1000);
    expect(status.hasUsage).toBe(true);

    await manager.deduct(300, "inference", {
      inputTokens: 300,
    });

    const balance = await manager.getBalance();
    expect(balance.remaining).toBe(700);
    expect(balance.totalConsumed).toBe(300);

    const history = await manager.getHistory();
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].reason).toBe("inference");
  });
});
