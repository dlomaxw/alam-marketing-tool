/**
 * Removes drafts whose baked-in asset URLs point at localhost.
 *
 * Draft content is immutable by design, so a wrong absolute URL cannot be
 * patched in place -- the hash is what an approval binds to. These were
 * generated during local development and can only be replaced by regenerating.
 * Nothing approved or sent is touched.
 */
import { sql, inArray, eq } from "drizzle-orm";
import { db, pool } from "../src/db/index";
import { emailDrafts, draftEvidence, approvals, sendJobs, events, auditLog } from "../src/db/schema";

const stale = await db.execute<{ id: string; status: string; subject: string }>(sql`
  SELECT id, status, subject FROM email_drafts
  WHERE body_html LIKE '%localhost:3000%' OR body_text LIKE '%localhost:3000%'
`);

console.log(`drafts with a localhost URL: ${stale.rowCount}`);
for (const r of stale.rows) console.log(`  [${r.status}] ${String(r.subject).slice(0, 70)}`);

const protectedStatuses = new Set(["sent", "queued", "approved"]);
const removable = stale.rows.filter((r) => !protectedStatuses.has(r.status));
const kept = stale.rows.filter((r) => protectedStatuses.has(r.status));

if (kept.length) {
  console.log(`\nkeeping ${kept.length} that are approved/queued/sent — those need a human decision.`);
}

if (removable.length) {
  const ids = removable.map((r) => r.id);
  await db.delete(auditLog).where(inArray(auditLog.entityId, ids));
  await db.delete(events).where(inArray(events.draftId, ids));
  await db.delete(sendJobs).where(inArray(sendJobs.draftId, ids));
  await db.delete(approvals).where(inArray(approvals.draftId, ids));
  await db.delete(draftEvidence).where(inArray(draftEvidence.draftId, ids));
  await db.update(emailDrafts).set({ supersededById: null }).where(inArray(emailDrafts.id, ids));
  await db.delete(emailDrafts).where(inArray(emailDrafts.id, ids));
  console.log(`\ndeleted ${ids.length} unapproved draft(s)`);
}

const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM email_drafts`)).rows;
console.log(`drafts remaining: ${n}`);
await pool.end();
