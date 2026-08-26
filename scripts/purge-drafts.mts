/** Clears unapproved drafts so a regeneration starts clean. */
import { sql, inArray } from "drizzle-orm";
import { db, pool } from "../src/db/index";
import { emailDrafts, draftEvidence, approvals, sendJobs, events, auditLog } from "../src/db/schema";
const rows = await db.execute<{ id: string }>(sql`
  SELECT id FROM email_drafts WHERE status NOT IN ('sent','queued','approved')`);
const ids = rows.rows.map((r) => r.id);
if (ids.length) {
  await db.delete(auditLog).where(inArray(auditLog.entityId, ids));
  await db.delete(events).where(inArray(events.draftId, ids));
  await db.delete(sendJobs).where(inArray(sendJobs.draftId, ids));
  await db.delete(approvals).where(inArray(approvals.draftId, ids));
  await db.delete(draftEvidence).where(inArray(draftEvidence.draftId, ids));
  await db.update(emailDrafts).set({ supersededById: null }).where(inArray(emailDrafts.id, ids));
  await db.delete(emailDrafts).where(inArray(emailDrafts.id, ids));
}
console.log(`removed ${ids.length} unapproved draft(s)`);
await pool.end();
