import type { Context, Env, MiddlewareHandler } from "hono";
import { UsageManager } from "./manager";
import type { UsageManagerConfig, UsageStore } from "./types";

export type UsageEnv<Reason extends string = string> = {
  Variables: {
    usage: UsageManager<Reason>;
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
export function usageManager<E extends Env, Reason extends string = string>(
  config: UsageManagerConfig<E, Reason>,
): MiddlewareHandler<E & UsageEnv<Reason>> {
  const { keyGenerator, store: storeOrFactory, ...managerConfig } = config;

  return async (c, next) => {
    const requestContext = c as unknown as Context<E>;
    const store: UsageStore<Reason> =
      typeof storeOrFactory === "function"
        ? storeOrFactory(requestContext)
        : storeOrFactory;

    const ownerId = await keyGenerator(requestContext);
    const manager = new UsageManager(ownerId, { ...managerConfig, store });

    c.set("usage", manager);

    await next();
  };
}
