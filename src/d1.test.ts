import { describe, expect, it } from "vitest";
import { D1Store } from "./d1";

type RecordedResult = {
  results: Record<string, unknown>[];
  meta: { changes: number };
};

class RecordedStatement {
  bindings: unknown[] = [];

  constructor(
    private readonly recorder: D1Recorder,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.bindings = values;
    return this;
  }

  async first(): Promise<Record<string, unknown> | null> {
    return this.recorder.firstResponses.shift() ?? null;
  }

  async run(): Promise<RecordedResult> {
    return this.recorder.runResponses.shift() ?? result();
  }

  async all(): Promise<RecordedResult> {
    return this.recorder.allResponses.shift() ?? result();
  }
}

class D1Recorder {
  readonly statements: RecordedStatement[] = [];
  readonly batches: RecordedStatement[][] = [];
  readonly batchResponses: RecordedResult[][] = [];
  readonly firstResponses: (Record<string, unknown> | null)[] = [];
  readonly runResponses: RecordedResult[] = [];
  readonly allResponses: RecordedResult[] = [];

  prepare(sql: string): D1PreparedStatement {
    const statement = new RecordedStatement(this, sql);
    this.statements.push(statement);
    return statement as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<RecordedResult[]> {
    this.batches.push(statements as unknown as RecordedStatement[]);
    return this.batchResponses.shift() ?? [];
  }

  asDatabase(): D1Database {
    return this as unknown as D1Database;
  }
}

function result(
  results: Record<string, unknown>[] = [],
  changes = 0,
): RecordedResult {
  return { results, meta: { changes } };
}

function squash(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const winningBucketRow = {
  id: "bucket-1",
  owner_id: "owner-1",
  usage_remaining: 20,
  usage_limit: 20,
  window_start: 2_000,
  window_duration_ms: 5_000,
  total_consumed: 0,
  last_consumed_at: 900,
  created_at: 100,
  updated_at: 1_000,
};

describe("D1Store", () => {
  it("submits a guarded ledger insert, matching update, and final balance read in one hard-deduction batch", async () => {
    const recorder = new D1Recorder();
    recorder.batchResponses.push([
      result([], 1),
      result([], 1),
      result([{ usage_remaining: 7 }]),
    ]);
    const store = new D1Store<"inference">({ db: recorder.asDatabase() });

    const deduction = await store.tryDeduct(
      "bucket-1",
      "owner-1",
      3,
      "inference",
      { model: "small" },
    );

    expect(deduction).toMatchObject({
      success: true,
      remaining: 7,
      entry: {
        bucketId: "bucket-1",
        ownerId: "owner-1",
        amount: 3,
        reason: "inference",
        metadata: { model: "small" },
      },
    });
    expect(recorder.batches).toHaveLength(1);
    expect(recorder.batches[0]).toHaveLength(3);

    const [insert, update, select] = recorder.batches[0];
    expect(squash(insert.sql)).toMatch(
      /^INSERT INTO usage_ledger .* SELECT .* FROM usage_buckets WHERE id = \? AND owner_id = \? AND usage_remaining >= \?$/,
    );
    expect(squash(update.sql)).toMatch(
      /^UPDATE usage_buckets SET .* WHERE id = \? AND owner_id = \? AND usage_remaining >= \?$/,
    );
    expect(squash(select.sql)).toBe(
      "SELECT usage_remaining FROM usage_buckets WHERE id = ? AND owner_id = ? LIMIT 1",
    );
    expect(insert.bindings.slice(-3)).toEqual(["bucket-1", "owner-1", 3]);
    expect(update.bindings.slice(-3)).toEqual(["bucket-1", "owner-1", 3]);
    expect(select.bindings).toEqual(["bucket-1", "owner-1"]);
    expect(insert.bindings).toContain("inference");
    expect(insert.bindings).toContain('{"model":"small"}');
    expect(insert.sql).not.toContain("inference");
    expect(insert.sql).not.toContain("small");
  });

  it("returns refusal from the conditional mutation count without creating an entry", async () => {
    const recorder = new D1Recorder();
    recorder.batchResponses.push([
      result([], 0),
      result([], 0),
      result([{ usage_remaining: 2 }]),
    ]);
    const store = new D1Store({ db: recorder.asDatabase() });

    await expect(
      store.tryDeduct("bucket-1", "owner-1", 3, "inference"),
    ).resolves.toEqual({ success: false, remaining: 2, entry: null });
    expect(recorder.batches).toHaveLength(1);
  });

  it("rejects an accounting operation when the bucket belongs to another owner", async () => {
    const recorder = new D1Recorder();
    recorder.batchResponses.push([result([], 0), result([], 0), result([])]);
    const store = new D1Store({ db: recorder.asDatabase() });

    await expect(
      store.tryDeduct("bucket-1", "owner-2", 3, "inference"),
    ).rejects.toThrow('Usage bucket "bucket-1" not found for owner "owner-2"');

    const [insert, update, select] = recorder.batches[0];
    expect(squash(insert.sql)).toContain("id = ? AND owner_id = ?");
    expect(squash(update.sql)).toContain("id = ? AND owner_id = ?");
    expect(squash(select.sql)).toContain("id = ? AND owner_id = ?");
  });

  it("rejects invalid hard deductions before preparing database work", async () => {
    const recorder = new D1Recorder();
    const store = new D1Store({ db: recorder.asDatabase() });

    await expect(
      store.tryDeduct("bucket-1", "owner-1", 0, "inference"),
    ).rejects.toThrow("Deduction amount must be a positive finite number");
    expect(recorder.statements).toHaveLength(0);
  });

  it("credits uncapped usage with a negative ledger amount in one batch", async () => {
    const recorder = new D1Recorder();
    recorder.batchResponses.push([
      result([], 1),
      result([], 1),
      result([{ usage_remaining: 26 }]),
    ]);
    const store = new D1Store<"admin-grant">({
      db: recorder.asDatabase(),
    });

    const credit = await store.credit("bucket-1", "owner-1", 20, "admin-grant");

    expect(credit).toMatchObject({
      remaining: 26,
      entry: { amount: -20, reason: "admin-grant" },
    });
    expect(recorder.batches).toHaveLength(1);
    const [update, insert, select] = recorder.batches[0];
    expect(squash(update.sql)).toMatch(
      /^UPDATE usage_buckets SET usage_remaining = usage_remaining \+ \?, updated_at = \? WHERE id = \? AND owner_id = \?$/,
    );
    expect(update.sql).not.toContain("usage_limit");
    expect(update.sql).not.toContain("total_consumed");
    expect(insert.bindings).toContain(-20);
    expect(squash(select.sql)).toBe(
      "SELECT usage_remaining FROM usage_buckets WHERE id = ? AND owner_id = ? LIMIT 1",
    );
    expect(update.bindings.slice(-2)).toEqual(["bucket-1", "owner-1"]);
    expect(select.bindings).toEqual(["bucket-1", "owner-1"]);
  });

  it("uses compare-and-set rollover and returns the current winning bucket", async () => {
    const recorder = new D1Recorder();
    recorder.batchResponses.push([result([], 0), result([winningBucketRow])]);
    const store = new D1Store({ db: recorder.asDatabase() });

    const bucket = await store.rolloverWindow("bucket-1", 1_000, {
      windowStart: 3_000,
      usageLimit: 30,
      windowDurationMs: 6_000,
    });

    expect(bucket).toMatchObject({
      id: "bucket-1",
      usageRemaining: 20,
      usageLimit: 20,
      windowStart: 2_000,
      windowDurationMs: 5_000,
    });
    expect(recorder.batches).toHaveLength(1);
    const [update, select] = recorder.batches[0];
    expect(squash(update.sql)).toMatch(
      /^UPDATE usage_buckets SET window_start = \?, usage_limit = \?, window_duration_ms = \?, usage_remaining = \?, total_consumed = 0, updated_at = \? WHERE id = \? AND window_start = \?$/,
    );
    expect(update.bindings).toEqual([
      3_000,
      30,
      6_000,
      30,
      expect.any(Number),
      "bucket-1",
      1_000,
    ]);
    expect(squash(select.sql)).toBe(
      "SELECT * FROM usage_buckets WHERE id = ? LIMIT 1",
    );
  });

  it("uses one parameter-only statement shape for every bucket update", async () => {
    const recorder = new D1Recorder();
    recorder.runResponses.push(result([], 1), result([], 1));
    recorder.firstResponses.push(
      { ...winningBucketRow, window_duration_ms: 9_000 },
      { ...winningBucketRow, usage_remaining: 0, last_consumed_at: null },
    );
    const store = new D1Store({ db: recorder.asDatabase() });

    const bucket = await store.updateBucket("bucket-1", {
      windowDurationMs: 9_000,
    });
    const suspiciousBucketId = 'bucket-2" OR 1 = 1 --';
    await store.updateBucket(suspiciousBucketId, {
      usageRemaining: 0,
      lastConsumedAt: null,
      updatedAt: 1_234,
    });

    expect(bucket.windowDurationMs).toBe(9_000);
    const expectedSql =
      "UPDATE usage_buckets SET usage_remaining = CASE WHEN ? = 1 THEN ? ELSE usage_remaining END, usage_limit = CASE WHEN ? = 1 THEN ? ELSE usage_limit END, window_start = CASE WHEN ? = 1 THEN ? ELSE window_start END, window_duration_ms = CASE WHEN ? = 1 THEN ? ELSE window_duration_ms END, total_consumed = CASE WHEN ? = 1 THEN ? ELSE total_consumed END, last_consumed_at = CASE WHEN ? = 1 THEN ? ELSE last_consumed_at END, updated_at = ? WHERE id = ?";
    expect(squash(recorder.statements[0].sql)).toBe(expectedSql);
    expect(squash(recorder.statements[2].sql)).toBe(expectedSql);
    expect(recorder.statements[0].bindings).toEqual([
      0,
      null,
      0,
      null,
      0,
      null,
      1,
      9_000,
      0,
      null,
      0,
      null,
      expect.any(Number),
      "bucket-1",
    ]);
    expect(recorder.statements[2].bindings).toEqual([
      1,
      0,
      0,
      null,
      0,
      null,
      0,
      null,
      0,
      null,
      1,
      null,
      1_234,
      suspiciousBucketId,
    ]);
    expect(recorder.statements[2].sql).not.toContain(suspiciousBucketId);
  });

  it("uses set-based reset and normalized keyset bucket pagination", async () => {
    const recorder = new D1Recorder();
    recorder.runResponses.push(result([], 4));
    recorder.allResponses.push(
      result([winningBucketRow, { ...winningBucketRow, id: "bucket-2" }]),
    );
    const store = new D1Store({ db: recorder.asDatabase() });

    await expect(store.resetAll()).resolves.toBe(4);
    const page = await store.listBuckets("bucket-0", 0);

    expect(squash(recorder.statements[0].sql)).toMatch(
      /^UPDATE usage_buckets SET usage_remaining = usage_limit, total_consumed = 0, updated_at = \?$/,
    );
    expect(squash(recorder.statements[1].sql)).toBe(
      "SELECT * FROM usage_buckets WHERE id > ? ORDER BY id LIMIT ?",
    );
    expect(recorder.statements[1].bindings).toEqual(["bucket-0", 2]);
    expect(page.buckets.map((bucket) => bucket.id)).toEqual(["bucket-1"]);
    expect(page.nextCursor).toBe("bucket-1");
  });

  it("normalizes ledger page limits before binding SQL values", async () => {
    const recorder = new D1Recorder();
    recorder.firstResponses.push({ id: "bucket-1" });
    recorder.allResponses.push(
      result([
        {
          id: "entry-2",
          bucket_id: "bucket-1",
          owner_id: "owner-1",
          amount: 2,
          reason: "inference",
          metadata: null,
          created_at: 200,
        },
        {
          id: "entry-1",
          bucket_id: "bucket-1",
          owner_id: "owner-1",
          amount: 1,
          reason: "inference",
          metadata: null,
          created_at: 100,
        },
      ]),
    );
    const store = new D1Store({ db: recorder.asDatabase() });

    const page = await store.getLedger("bucket-1", undefined, -5);

    expect(recorder.statements[1].bindings).toEqual(["bucket-1", 2]);
    expect(page.entries.map((entry) => entry.id)).toEqual(["entry-2"]);
    expect(page.nextCursor).toBe("entry-2");
  });

  it("throws the documented not-found error before querying a missing bucket ledger", async () => {
    const recorder = new D1Recorder();
    recorder.firstResponses.push(null);
    const store = new D1Store({ db: recorder.asDatabase() });

    await expect(store.getLedger("missing-bucket")).rejects.toThrow(
      'Usage bucket "missing-bucket" not found',
    );
    expect(squash(recorder.statements[0].sql)).toBe(
      "SELECT id FROM usage_buckets WHERE id = ? LIMIT 1",
    );
    expect(recorder.statements[0].bindings).toEqual(["missing-bucket"]);
    expect(recorder.statements).toHaveLength(1);
  });
});
