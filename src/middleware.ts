import type { Context, Env, MiddlewareHandler } from "hono";
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
 * Pass your app's `Env` as the type argument to get a fully typed context in
 * both `store` (factory form) and `keyGenerator` — no casts required:
 *
 * ```ts
 * type AppEnv = { Bindings: { DB: D1Database }; Variables: { userId: string } };
 * app.use(usageManager<AppEnv>({
 *   store: (c) => new D1Store({ db: c.env.DB }),
 *   keyGenerator: (c) => c.get("userId"),
 * }));
 * ```
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
 * app.use(usageManager<{ Bindings: { DB: D1Database } }>({
 *   store: (c) => new D1Store({ db: c.env.DB }),
 *   keyGenerator: (c) => c.get("userId"),
 * }));
 * ```
 */
export function usageManager<E extends Env = Env>(
  config: UsageManagerConfig<E>,
): MiddlewareHandler<E & UsageEnv> {
  const { keyGenerator, store: storeOrFactory, ...managerConfig } = config;

  return async (c, next) => {
    // `c` is Context<E & UsageEnv>; the factory/keyGenerator are declared over
    // Context<E>. The extra Variables (`usage`) only widen what's available, so
    // the narrowing cast is safe.
    const ctx = c as unknown as Context<E>;
    const store: UsageStore =
      typeof storeOrFactory === "function"
        ? storeOrFactory(ctx)
        : storeOrFactory;

    const ownerId = await keyGenerator(ctx);
    const manager = new UsageManager(ownerId, { ...managerConfig, store });

    c.set("usage", manager);

    await next();
  };
}
