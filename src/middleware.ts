import type { Context, MiddlewareHandler } from "hono";
import { UsageManager } from "./manager";
import type { UsageManagerConfig } from "./types";

export type UsageEnv = {
  Variables: {
    usage: UsageManager;
  };
};

/**
 * Hono middleware that injects a UsageManager instance onto the context.
 *
 * Usage:
 * ```ts
 * import { usageManager } from "hono-usage-limiter";
 * import { MemoryStore } from "hono-usage-limiter/memory";
 *
 * const app = new Hono();
 *
 * app.use(usageManager({
 *   store: new MemoryStore(),
 *   keyGenerator: (c) => c.get("userId"),
 * }));
 *
 * app.get("/balance", async (c) => {
 *   const balance = await c.get("usage").getBalance();
 *   return c.json(balance);
 * });
 * ```
 */
export function usageManager(
  config: UsageManagerConfig,
): MiddlewareHandler<UsageEnv> {
  const { keyGenerator, ...managerConfig } = config;

  return async (c, next) => {
    const ownerId = await keyGenerator(c);
    const manager = new UsageManager(ownerId, managerConfig);

    c.set("usage", manager);

    await next();
  };
}
