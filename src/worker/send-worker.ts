import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { sendJobs, emailDrafts, events } from "@/db/schema";
import { authorizeSend } from "@/lib/email/send-guard";
import { getEmailProvider } from "@/lib/email/provider";
import { hashesMatch } from "@/lib/content-hash";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";

const WORKER_LABEL = "system:send-worker";

export interface WorkerRunResult {
  claimed: number;
  sent: number;
  refused: number;
  failed: number;
}

/**
 * Processes approved send jobs.
 *
 * Re-runs the full authorization check immediately before the provider call.
 * The checks already ran when the job was queued, but the queue is not
 * instantaneous: an approval can be revoked, a recipient can opt out, or an
 * administrator can hit the kill switch in between. Re-checking here means
 * those actions take effect without anyone having to chase down in-flight
 * jobs.
 *
 * A job that fails authorization is *refused*, not retried: the condition that
 * blocked it is a decision, not a transient error.
 */
export async function runSendWorker(limit = 10): Promise<WorkerRunResult> {
  const result: WorkerRunResult = { claimed: 0, sent: 0, refused: 0, failed: 0 };

  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob();
    if (!job) break;
    result.claimed++;

    const outcome = await processJob(job.id);
    if (outcome === "sent") result.sent++;
    else if (outcome === "refused") result.refused++;
    else result.failed++;
  }

  return result;
}

/**
 * Claims one job atomically. `FOR UPDATE SKIP LOCKED` lets several workers run
 * concurrently without two of them picking up the same job, which is the other
 * half of never sending an email twice.
 */
async function claimNextJob(): Promise<{ id: string } | null> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE ${sendJobs}
    SET status = 'processing', attempts = ${sendJobs.attempts} + 1
    WHERE id = (
      SELECT id FROM ${sendJobs}
      WHERE status = 'queued' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `);
  return rows.rows[0] ?? null;
}

type Outcome = "sent" | "refused" | "failed";

async function processJob(jobId: string): Promise<Outcome> {
  const [job] = await db.select().from(sendJobs).where(eq(sendJobs.id, jobId)).limit(1);
  if (!job) return "failed";

  // Full re-authorization. This is the check that actually protects delivery.
  const auth = await authorizeSend({
    draftId: job.draftId,
    actorId: null,
    isTest: job.isTest,
  });

  if (!auth.ok) {
    const reason = auth.failures.map((f) => `${f.code}: ${f.message}`).join("; ");
    await db.update(sendJobs).set({
      status: "cancelled",
      error: `Refused at send time — ${reason}`,
    }).where(eq(sendJobs.id, job.id));

    await writeAudit({
      actorLabel: WORKER_LABEL,
      action: "send.refused",
      entity: "send_job",
      entityId: job.id,
      reason,
      metadata: { draftId: job.draftId, failures: auth.failures },
    });
    return "refused";
  }

  // The hash on the job must still match the draft. A mismatch means the
  // content moved after the job was created.
  if (!hashesMatch(job.contentHash, auth.draft.contentHash)) {
    await db.update(sendJobs).set({
      status: "cancelled",
      error: "Refused at send time — the draft content hash changed after this job was queued.",
    }).where(eq(sendJobs.id, job.id));

    await writeAudit({
      actorLabel: WORKER_LABEL,
      action: "send.refused",
      entity: "send_job",
      entityId: job.id,
      beforeHash: job.contentHash,
      afterHash: auth.draft.contentHash,
      reason: "content_hash_changed",
    });
    return "refused";
  }

  const provider = getEmailProvider();

  try {
    const delivery = await provider.send({
      to: job.recipientEmail,
      subject: auth.draft.subject,
      html: auth.draft.bodyHtml,
      text: auth.draft.bodyText,
      headers: {
        // Section 13: an easy opt-out method, honoured by the mail client.
        "List-Unsubscribe": `<${env.NEXT_PUBLIC_APP_URL}/opt-out?d=${auth.draft.id}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-ALAM-Draft-Version": String(auth.draft.version),
        ...(job.isTest ? { "X-ALAM-Test": "true" } : {}),
      },
    });

    await db.update(sendJobs).set({
      status: "sent",
      providerMessageId: delivery.providerMessageId,
      sentAt: new Date(),
      error: null,
    }).where(eq(sendJobs.id, job.id));

    // A test send must not move the prospect's draft into "sent".
    if (!job.isTest) {
      await db.update(emailDrafts)
        .set({ status: "sent" })
        .where(eq(emailDrafts.id, job.draftId));

      await db.insert(events).values({
        prospectId: auth.draft.prospectId,
        draftId: auth.draft.id,
        sendJobId: job.id,
        type: "sent",
        metadata: { providerMessageId: delivery.providerMessageId, provider: provider.name },
      });
    }

    await writeAudit({
      actorLabel: WORKER_LABEL,
      action: job.isTest ? "send.test_delivered" : "send.delivered",
      entity: "send_job",
      entityId: job.id,
      afterHash: job.contentHash,
      metadata: {
        draftId: job.draftId,
        provider: provider.name,
        providerMessageId: delivery.providerMessageId,
      },
    });

    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Section 13: never auto-resend. The job is marked failed and stops; a
    // person has to look at it and start a new version if appropriate.
    await db.update(sendJobs).set({
      status: "failed",
      error: message,
    }).where(eq(sendJobs.id, job.id));

    if (!job.isTest) {
      await db.update(emailDrafts)
        .set({ status: "failed" })
        .where(eq(emailDrafts.id, job.draftId));
    }

    await writeAudit({
      actorLabel: WORKER_LABEL,
      action: "send.failed",
      entity: "send_job",
      entityId: job.id,
      reason: message,
      metadata: { draftId: job.draftId, willRetry: false },
    });

    return "failed";
  }
}

/** Cancels every unsent job, for the section 14 emergency control. */
export async function cancelAllQueued(actorId: string, actorLabel: string, reason: string) {
  const cancelled = await db.update(sendJobs)
    .set({ status: "cancelled", error: `Cancelled by kill switch: ${reason}` })
    .where(and(eq(sendJobs.status, "queued"), lte(sendJobs.scheduledAt, new Date(8.64e15))))
    .returning({ id: sendJobs.id });

  await writeAudit({
    actorId, actorLabel,
    action: "send.kill_switch_cancel_all",
    entity: "send_job",
    reason,
    metadata: { cancelledCount: cancelled.length },
  });

  return cancelled.length;
}
