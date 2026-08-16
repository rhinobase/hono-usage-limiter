import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("public documentation", () => {
  it("documents complete usage-store operations in the README", () => {
    const readme = readSource("../README.md");

    for (const api of [
      "tryDeduct",
      "credit",
      "reconcileLimit",
      "CachedUsageStore",
      "resetAll",
      "listBuckets",
    ]) {
      expect(readme).toContain(api);
    }
  });

  it("documents Unstorage's best-effort concurrency boundary", () => {
    expect(readSource("./unstorage.ts")).toContain("best-effort");
  });
});
