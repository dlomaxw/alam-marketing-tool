import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { env } from "@/lib/env";

/**
 * One pool per process. Next.js dev reloads modules on every edit, so the pool
 * is stashed on globalThis to avoid exhausting Neon connection slots.
 */
const globalForDb = globalThis as unknown as { __alamPool?: Pool };

const pool =
  globalForDb.__alamPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: true },
  });

if (process.env.NODE_ENV !== "production") globalForDb.__alamPool = pool;

export const db = drizzle(pool, { schema });
export { schema, pool };
export type Db = typeof db;
