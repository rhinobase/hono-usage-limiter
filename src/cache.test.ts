import { describe, expect, it, vi } from "vitest";
import { CachedUsageStore, type UsageCache } from "./cache";
import { MemoryStore } from "./memory";

class InMemoryUsageCache implements UsageCache {
  readonly entries = new Map<string, unknown>();
  failNextEpochSetWith: Error | null = null;

  async get<Value>(key: string): Promise<Value | null> {
    return (this.entries.get(key) as Value | undefined) ?? null;
  }

  async set<Value>(key: string, value: Value): Promise<void> {
    if (key.endsWith(":epoch") && this.failNextEpochSetWith) {
      const error = this.failNextEpochSetWith;
      this.failNextEpochSetWith = null;
      throw error;
    }
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

function createCachedStore() {
  const inner = new MemoryStore<"inference" | "admin-grant">();
  const cache = new InMemoryUsageCache();
  const store = new CachedUsageStore({ inner, cache });
  return { cache, inner, store };
}

describe("CachedUsageStore", () => {
  it("reads a bucket through the cache", async () => {
    const { inner, store } = createCachedStore();
    await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    const getBucket = vi.spyOn(inner, "getBucket");

    expect((await store.getBucket("user-1"))?.usageRemaining).toBe(10);
    expect((await store.getBucket("user-1"))?.usageRemaining).toBe(10);
    expect(getBucket).toHaveBeenCalledTimes(1);
  });

  it("delegates tryDeduct to the inner store and refreshes the cache", async () => {
    const { inner, store } = createCachedStore();
    const bucket = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await store.getBucket("user-1");
    const tryDeduct = vi.spyOn(inner, "tryDeduct");

    await expect(
      store.tryDeduct(bucket.id, "user-1", 3, "inference"),
    ).resolves.toMatchObject({ success: true, remaining: 7 });
    expect(tryDeduct).toHaveBeenCalledWith(
      bucket.id,
      "user-1",
      3,
      "inference",
      undefined,
    );

    const getBucket = vi.spyOn(inner, "getBucket");
    expect((await store.getBucket("user-1"))?.usageRemaining).toBe(7);
    expect(getBucket).not.toHaveBeenCalled();
  });

  it("refreshes the cache after a credit", async () => {
    const { inner, store } = createCachedStore();
    const bucket = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await store.getBucket("user-1");

    await store.credit(bucket.id, "user-1", 4, "admin-grant");

    const getBucket = vi.spyOn(inner, "getBucket");
    expect((await store.getBucket("user-1"))?.usageRemaining).toBe(14);
    expect(getBucket).not.toHaveBeenCalled();
  });

  it("refreshes the cache after a window rollover", async () => {
    const { inner, store } = createCachedStore();
    const bucket = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await store.getBucket("user-1");

    await store.rolloverWindow(bucket.id, bucket.windowStart, {
      windowStart: bucket.windowStart + 1000,
      usageLimit: 20,
      windowDurationMs: 2000,
    });

    const getBucket = vi.spyOn(inner, "getBucket");
    await expect(store.getBucket("user-1")).resolves.toMatchObject({
      usageRemaining: 20,
      usageLimit: 20,
      windowDurationMs: 2000,
    });
    expect(getBucket).not.toHaveBeenCalled();
  });

  it("refreshes the cache after a direct bucket update", async () => {
    const { inner, store } = createCachedStore();
    const bucket = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await store.getBucket("user-1");

    await store.updateBucket(bucket.id, { usageRemaining: 8 });

    const getBucket = vi.spyOn(inner, "getBucket");
    expect((await store.getBucket("user-1"))?.usageRemaining).toBe(8);
    expect(getBucket).not.toHaveBeenCalled();
  });

  it("makes cached buckets unreachable after resetAll", async () => {
    const { inner, store } = createCachedStore();
    const first = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    const second = await inner.createBucket("user-2", {
      usageLimit: 20,
      windowDurationMs: 1000,
    });
    await inner.deduct(first.id, "user-1", 3, "inference");
    await inner.deduct(second.id, "user-2", 4, "inference");
    await store.getBucket("user-1");
    await store.getBucket("user-2");

    await expect(store.resetAll()).resolves.toBe(2);

    const getBucket = vi.spyOn(inner, "getBucket");
    await expect(store.getBucket("user-1")).resolves.toMatchObject({
      usageRemaining: 10,
    });
    await expect(store.getBucket("user-2")).resolves.toMatchObject({
      usageRemaining: 20,
    });
    expect(getBucket).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached buckets when the inner reset partially succeeds then throws", async () => {
    const { inner, store } = createCachedStore();
    const bucket = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await inner.deduct(bucket.id, "user-1", 3, "inference");
    await store.getBucket("user-1");
    const resetError = new Error("reset stopped after first bucket");
    vi.spyOn(inner, "resetAll").mockImplementation(async () => {
      await inner.updateBucket(bucket.id, {
        usageRemaining: bucket.usageLimit,
        totalConsumed: 0,
      });
      throw resetError;
    });

    await expect(store.resetAll()).rejects.toBe(resetError);

    const getBucket = vi.spyOn(inner, "getBucket");
    await expect(store.getBucket("user-1")).resolves.toMatchObject({
      usageRemaining: 10,
      totalConsumed: 0,
    });
    expect(getBucket).toHaveBeenCalledTimes(1);
  });

  it("keeps stale buckets unreachable when persisting the reset epoch fails", async () => {
    const { cache, inner, store } = createCachedStore();
    const bucket = await inner.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await inner.deduct(bucket.id, "user-1", 3, "inference");
    await store.getBucket("user-1");
    const epochError = new Error("cache unavailable");
    cache.failNextEpochSetWith = epochError;

    let thrown: unknown;
    try {
      await store.resetAll();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "Usage reset succeeded, but cache invalidation failed",
    );
    expect((thrown as Error).cause).toBe(epochError);

    const getBucket = vi.spyOn(inner, "getBucket");
    await expect(store.getBucket("user-1")).resolves.toMatchObject({
      usageRemaining: 10,
      totalConsumed: 0,
    });
    expect(getBucket).toHaveBeenCalledTimes(1);
  });
});
