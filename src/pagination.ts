export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export function normalizePageLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isFinite(limit)) throw new Error("Page limit must be finite");
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}
