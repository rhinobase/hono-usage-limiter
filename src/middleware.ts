import type { Context, MiddlewareHandler } from "hono";
import { CreditManager } from "./manager";
import type { CreditManagerConfig } from "./types";

export type CreditEnv = {
  Variables: {
    credit: CreditManager;
  };
};

/**
 * Hono middleware that injects a CreditManager instance onto the context.
 *
 * Usage:
 * ```ts
 * import { creditManager } from "hono-usage-limiter";
 * import { MemoryStore } from "hono-usage-limiter/memory";
 *
 * const app = new Hono();
 *
 * app.use(creditManager({
 *   store: new MemoryStore(),
 *   keyGenerator: (c) => c.get("userId"),
 * }));
 *
 * app.get("/balance", async (c) => {
 *   const balance = await c.get("credit").getBalance();
 *   return c.json(balance);
 * });
 * ```
 */
export function creditManager(
  config: CreditManagerConfig,
): MiddlewareHandler<CreditEnv> {
  const { keyGenerator, ...managerConfig } = config;

  return async (c, next) => {
    const ownerId = await keyGenerator(c);
    const manager = new CreditManager(ownerId, managerConfig);

    c.set("credit", manager);

    await next();
  };
}
