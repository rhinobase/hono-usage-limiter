import { Hono } from "hono";
import { D1Store } from "./d1";
import { UsageManager } from "./manager";
import { MemoryStore } from "./memory";
import { usageManager } from "./middleware";
import type { UsageStore } from "./types";

type Reason = "inference" | "embedding";

type AppEnv = {
  Bindings: {
    DB: {
      readonly name: string;
    };
  };
  Variables: {
    userId: string;
  };
};

if (false) {
  const db = null as unknown as D1Database;
  const d1Store: UsageStore<"inference" | "admin-grant"> = new D1Store({
    db,
  });
  void d1Store;

  const store = new MemoryStore<Reason>();
  const manager = new UsageManager<Reason>("user-1", { store });

  manager.deduct(1, "inference");
  manager.tryDeduct(1, "embedding");
  manager.credit(1, "inference");

  // @ts-expect-error Unknown deduction reasons are rejected.
  manager.deduct(1, "admin-grant");
  // @ts-expect-error Unknown hard-deduction reasons are rejected.
  manager.tryDeduct(1, "admin-grant");
  // @ts-expect-error Unknown credit reasons are rejected.
  manager.credit(1, "admin-grant");

  const app = new Hono<AppEnv>();
  app.use(
    usageManager<AppEnv, Reason>({
      store: (c) => {
        c.env.DB.name;
        return store;
      },
      keyGenerator: (c) => c.get("userId"),
    }),
  );
}
