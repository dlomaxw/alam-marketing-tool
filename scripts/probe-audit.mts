import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/index";
const r = await db.execute(sql`
  SELECT action, actor_label, entity, entity_id, created_at
  FROM audit_log WHERE actor_label = 'system:send-worker' ORDER BY created_at`);
console.log("worker audit rows:", r.rowCount);
for (const row of r.rows) console.log(" ", row.action, row.entity_id, row.created_at);
const j = await db.execute(sql`SELECT count(*)::int AS n FROM send_jobs`);
console.log("send_jobs still present:", j.rows[0]);
await pool.end();
