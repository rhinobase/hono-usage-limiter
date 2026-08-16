import { describe, expect, it } from "vitest";
import { normalizePageLimit } from "./pagination";

describe("normalizePageLimit", () => {
  it.each([
    [undefined, 20],
    [0, 1],
    [-10, 1],
    [1.9, 1],
    [101, 100],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePageLimit(input)).toBe(expected);
  });

  it("rejects non-finite limits", () => {
    expect(() => normalizePageLimit(Number.NaN)).toThrow(
      "Page limit must be finite",
    );
    expect(() => normalizePageLimit(Infinity)).toThrow(
      "Page limit must be finite",
    );
  });
});
