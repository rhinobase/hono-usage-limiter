import { beforeEach, describe, expect, it, vi } from "vitest";
import { CachedUsageStore, type UsageCache } from "./cache";
import { UsageManager } from "./manager";
import { MemoryStore } from "./memory";

/** A trivial in-memory cache with TTL ignored (fine for synchronous tests). */
function createMapCache(): UsageCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
    delete: (k) => {
      store.delete(k);
    },
  };
}

describe("CachedUsageStore", () => {
  let inner: MemoryStore;
  let cache: ReturnType<typeof createMapCache>;
  let store: CachedUsageStore;

  beforeEach(() => {
    inner = new MemoryStore();
    cache = createMapCache();
    store = new CachedUsageStore({ store: inner, cache });
  });

  it("caches the bucket after the first read (read-through)", async () => {
    await inner.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 1000,
    });
    const getSpy = vi.spyOn(inner, "getBucket");

    const first = await store.getBucket("user-1");
    expect(first?.usageRemaining).toBe(100);
    expect(getSpy).toHaveBeenCalledTimes(1);

    // Second read is served from cache — the inner store isn't hit again.
    const second = await store.getBucket("user-1");
    expect(second?.usageRemaining).toBe(100);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached balance in step after a deduct without re-reading", async () => {
    const created = await store.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 1000,
    });
    // Warm the cache.
    await store.getBucket("user-1");

    await store.deduct(created.id, "user-1", 30, "inference");

    const getSpy = vi.spyOn(inner, "getBucket");
    const bucket = await store.getBucket("user-1");
    // Served from the patched cache — no inner read.
    expect(getSpy).not.toHaveBeenCalled();
    expect(bucket?.usageRemaining).toBe(70);
    expect(bucket?.totalConsumed).toBe(30);
  });

  it("does not touch the cache when tryDeduct is refused", async () => {
    const created = await store.createBucket("user-1", {
      usageLimit: 10,
      windowDurationMs: 1000,
    });
    await store.getBucket("user-1");

    const result = await store.tryDeduct(created.id, "user-1", 50, "inference");
    expect(result.success).toBe(false);

    const bucket = await store.getBucket("user-1");
    expect(bucket?.usageRemaining).toBe(10);
    expect(bucket?.totalConsumed).toBe(0);
  });

  it("always deducts against the authoritative store", async () => {
    const created = await store.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 1000,
    });
    await store.deduct(created.id, "user-1", 40, "inference");

    // The underlying store reflects the real balance regardless of cache.
    const authoritative = await inner.getBucket("user-1");
    expect(authoritative?.usageRemaining).toBe(60);
  });

  it("falls back to the inner store on a malformed cache entry", async () => {
    await inner.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 1000,
    });
    cache.store.set("usage-bucket:user-1", "not json");

    const bucket = await store.getBucket("user-1");
    expect(bucket?.usageRemaining).toBe(100);
  });

  it("works end-to-end through a UsageManager", async () => {
    const manager = new UsageManager("user-1", { store, defaultUsage: 100 });

    const status = await manager.check();
    expect(status.remaining).toBe(100);

    const result = await manager.tryDeduct(25, "inference");
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(75);

    const balance = await manager.getBalance();
    expect(balance.remaining).toBe(75);
  });

  it("supports a custom prefix so multiple stores can share a cache", async () => {
    const shared = createMapCache();
    const s1 = new CachedUsageStore({
      store: new MemoryStore(),
      cache: shared,
      prefix: "app1",
    });
    const s2 = new CachedUsageStore({
      store: new MemoryStore(),
      cache: shared,
      prefix: "app2",
    });

    await s1.createBucket("user-1", {
      usageLimit: 100,
      windowDurationMs: 1000,
    });
    await s2.createBucket("user-1", {
      usageLimit: 500,
      windowDurationMs: 1000,
    });

    expect((await s1.getBucket("user-1"))?.usageLimit).toBe(100);
    expect((await s2.getBucket("user-1"))?.usageLimit).toBe(500);
    expect(shared.store.has("app1:user-1")).toBe(true);
    expect(shared.store.has("app2:user-1")).toBe(true);
  });
});
