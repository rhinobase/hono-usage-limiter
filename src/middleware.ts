import type { MiddlewareHandler } from "hono";
import { UsageManager } from "./manager";
import type { UsageManagerConfig, UsageStore } from "./types";

export type UsageEnv = {
  Variables: {
    usage: UsageManager;
  };
};

/**
 * Hono middleware that injects a UsageManager instance onto the context.
 *
 * The `store` option accepts either a pre-constructed `UsageStore` instance
 * or a factory function `(c) => UsageStore` for request-scoped stores.
 *
 * @example Pre-constructed store (MemoryStore, etc.)
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
 * ```
 *
 * @example Factory function (Cloudflare D1, etc.)
 * ```ts
 * import { usageManager } from "hono-usage-limiter";
 * import { D1Store } from "hono-usage-limiter/d1";
 *
 * const app = new Hono<{ Bindings: { DB: D1Database } }>();
 *
 * app.use(usageManager({
 *   store: (c) => new D1Store({ db: c.env.DB }),
 *   keyGenerator: (c) => c.get("userId"),
 * }));
 * ```
 */
export function usageManager(
  config: UsageManagerConfig,
): MiddlewareHandler<UsageEnv> {
  const { keyGenerator, store: storeOrFactory, ...managerConfig } = config;

  return async (c, next) => {
    const store: UsageStore =
      typeof storeOrFactory === "function"
        ? storeOrFactory(c)
        : storeOrFactory;

    const ownerId = await keyGenerator(c);
    const manager = new UsageManager(ownerId, { ...managerConfig, store });

    c.set("usage", manager);

    await next();
  };
}
