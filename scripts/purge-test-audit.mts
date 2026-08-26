/**
 * One-off: removes worker audit entries left by the integration suite.
 *
 * The audit log is append-only in normal operation. These rows are the
 * exception: they record deliveries that never happened, for send jobs that no
 * longer exist, and were written by tests. Leaving false send.delivered
 * records in a compliance log is worse than deleting them.
 *
 * Only rows whose entity_id no longer matches any send job are touched.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db/index";

const orphans = await db.execute(sql`
  SELECT id, action, entity_id, created_at
  FROM audit_log
  WHERE actor_label = 'system:send-worker'
    AND entity = 'send_job'
    AND NOT EXISTS (
      SELECT 1 FROM send_jobs j WHERE j.id::text = audit_log.entity_id
    )
  ORDER BY created_at
`);

console.log(`orphaned worker audit rows: ${orphans.rowCount}`);
for (const r of orphans.rows) console.log("  ", r.action, r.entity_id, r.created_at);

if (orphans.rowCount) {
  const ids = orphans.rows.map((r) => r.id as string);
  await db.execute(sql`DELETE FROM audit_log WHERE id = ANY(${sql.raw(`ARRAY['${ids.join("','")}']::uuid[]`)})`);
  console.log(`deleted ${ids.length}`);
}

const left = await db.execute(sql`
  SELECT count(*)::int AS n FROM audit_log WHERE actor_label = 'system:send-worker'`);
console.log("worker rows remaining:", left.rows[0]);
await pool.end();
