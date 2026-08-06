import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
  clampLedgerLimit,
} from "./pagination";

describe("clampLedgerLimit", () => {
  it("returns the default when no limit is given", () => {
    expect(clampLedgerLimit()).toBe(DEFAULT_LEDGER_LIMIT);
    expect(clampLedgerLimit(undefined)).toBe(DEFAULT_LEDGER_LIMIT);
  });

  it("returns the default for non-finite values", () => {
    expect(clampLedgerLimit(Number.NaN)).toBe(DEFAULT_LEDGER_LIMIT);
    expect(clampLedgerLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LEDGER_LIMIT);
  });

  it("clamps values above the max", () => {
    expect(clampLedgerLimit(MAX_LEDGER_LIMIT + 1)).toBe(MAX_LEDGER_LIMIT);
    expect(clampLedgerLimit(100000)).toBe(MAX_LEDGER_LIMIT);
  });

  it("clamps values below 1 up to 1", () => {
    expect(clampLedgerLimit(0)).toBe(1);
    expect(clampLedgerLimit(-5)).toBe(1);
  });

  it("floors fractional values", () => {
    expect(clampLedgerLimit(10.9)).toBe(10);
  });

  it("passes through valid in-range values", () => {
    expect(clampLedgerLimit(25)).toBe(25);
    expect(clampLedgerLimit(MAX_LEDGER_LIMIT)).toBe(MAX_LEDGER_LIMIT);
    expect(clampLedgerLimit(1)).toBe(1);
  });
});
