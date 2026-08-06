/**
 * Default number of ledger entries returned by `getLedger` when no `limit` is
 * given.
 */
export const DEFAULT_LEDGER_LIMIT = 20;

/**
 * Hard upper bound on how many ledger entries a single `getLedger` call may
 * return. Prevents a caller from requesting an unbounded page (which, on a
 * remote store, would translate into an unbounded query).
 */
export const MAX_LEDGER_LIMIT = 100;

/**
 * Normalize a caller-supplied `getLedger` limit to a safe, bounded integer.
 *
 * - `undefined` / non-finite → {@link DEFAULT_LEDGER_LIMIT}
 * - values below 1 → clamped to 1
 * - values above {@link MAX_LEDGER_LIMIT} → clamped to the max
 * - fractional values → floored
 */
export function clampLedgerLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LEDGER_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_LEDGER_LIMIT) return MAX_LEDGER_LIMIT;
  return floored;
}
