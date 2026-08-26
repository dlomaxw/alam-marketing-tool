"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emailDrafts, approvals, sendJobs, events } from "@/db/schema";
import { requirePermission, requestIp, AuthorizationError } from "@/lib/auth/session";
import { canTransition, type DraftStatus } from "@/lib/draft-state";
import { authorizeSend, buildIdempotencyKey } from "@/lib/email/send-guard";
import { hashesMatch } from "@/lib/content-hash";
import { writeAudit } from "@/lib/audit";
import { reviseDraft, generateDraft, DraftError, type DraftEdits } from "@/lib/drafts";

export interface ActionResult {
  ok: boolean;
  message: string;
  failures?: { code: string; message: string }[];
}

function fail(err: unknown): ActionResult {
  if (err instanceof AuthorizationError || err instanceof DraftError) {
    return { ok: false, message: err.message };
  }
  console.error("[draft action]", err);
  return { ok: false, message: "Something went wrong. The action was not recorded." };
}

async function loadDraft(draftId: string) {
  const [draft] = await db.select().from(emailDrafts)
    .where(eq(emailDrafts.id, draftId)).limit(1);
  if (!draft) throw new DraftError("Draft not found.");
  return draft;
}

export async function submitForReview(draftId: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("draft:submit");
    const draft = await loadDraft(draftId);

    const t = canTransition(draft.status as DraftStatus, "submit", user);
    if (!t.allowed) return { ok: false, message: t.reason! };

    await db.update(emailDrafts).set({ status: "needs_review" })
      .where(eq(emailDrafts.id, draftId));

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "draft.submitted", entity: "email_draft", entityId: draftId,
      afterHash: draft.contentHash, ip: await requestIp(),
    });

    revalidatePath("/review");
    revalidatePath(`/drafts/${draftId}`);
    return { ok: true, message: "Submitted for review." };
  } catch (err) { return fail(err); }
}

/**
 * Records an approval decision.
 *
 * The submitted hash must match the draft's current hash. The reviewer's
 * browser sends back the hash of what it displayed, so if the draft changed
 * between the page rendering and the click, the approval is refused rather
 * than silently applied to content nobody read.
 */
export async function decideOnDraft(
  draftId: string,
  decision: "approved" | "rejected" | "changes_requested",
  seenContentHash: string,
  reason?: string,
): Promise<ActionResult> {
  try {
    const permission = decision === "approved" ? "draft:approve" : "draft:reject";
    const user = await requirePermission(permission);
    const draft = await loadDraft(draftId);

    if (!hashesMatch(seenContentHash, draft.contentHash)) {
      return {
        ok: false,
        message: "This draft changed while you were reviewing it. Reload and read the current version before deciding.",
      };
    }

    const action = decision === "approved" ? "approve"
      : decision === "rejected" ? "reject" : "request_changes";
    const t = canTransition(draft.status as DraftStatus, action, user);
    if (!t.allowed) return { ok: false, message: t.reason! };

    // Section 8.1: one person must not both write and approve a message.
    if (decision === "approved" && draft.createdBy === user.id) {
      return {
        ok: false,
        message: "You created this draft. A second authorized person must approve it.",
      };
    }

    if (decision !== "approved" && !reason?.trim()) {
      return { ok: false, message: "Give a reason so the author knows what to change." };
    }

    await db.transaction(async (tx) => {
      await tx.insert(approvals).values({
        draftId: draft.id,
        draftVersion: draft.version,
        contentHash: draft.contentHash,
        approverId: user.id,
        decision,
        reason: reason?.trim() || null,
        ip: await requestIp(),
      });

      await tx.update(emailDrafts).set({ status: t.to! })
        .where(eq(emailDrafts.id, draft.id));

      await writeAudit({
        actorId: user.id, actorLabel: user.email,
        action: `draft.${decision}`,
        entity: "email_draft", entityId: draft.id,
        afterHash: draft.contentHash,
        reason: reason?.trim() || null,
        ip: await requestIp(),
        metadata: { version: draft.version },
      }, tx as never);
    });

    revalidatePath("/review");
    revalidatePath(`/drafts/${draftId}`);

    return {
      ok: true,
      message: decision === "approved"
        ? "Approved. This exact version is now the only one that may be sent."
        : "Decision recorded.",
    };
  } catch (err) { return fail(err); }
}

export async function revokeApproval(draftId: string, reason: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("draft:approve");
    const draft = await loadDraft(draftId);
    if (!reason.trim()) return { ok: false, message: "Give a reason for revoking." };

    const t = canTransition(draft.status as DraftStatus, "revoke_approval", user);
    if (!t.allowed) return { ok: false, message: t.reason! };

    await db.insert(approvals).values({
      draftId: draft.id,
      draftVersion: draft.version,
      contentHash: draft.contentHash,
      approverId: user.id,
      decision: "revoked",
      reason: reason.trim(),
      ip: await requestIp(),
    });
    await db.update(emailDrafts).set({ status: "needs_review" })
      .where(eq(emailDrafts.id, draft.id));

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "draft.approval_revoked", entity: "email_draft", entityId: draft.id,
      reason: reason.trim(), ip: await requestIp(),
    });

    revalidatePath(`/drafts/${draftId}`);
    return { ok: true, message: "Approval revoked." };
  } catch (err) { return fail(err); }
}

export async function editDraft(
  draftId: string,
  changes: DraftEdits,
  reason?: string,
): Promise<ActionResult & { draftId?: string }> {
  try {
    const user = await requirePermission("draft:write");
    const draft = await loadDraft(draftId);

    const t = canTransition(draft.status as DraftStatus, "edit", user);
    if (!t.allowed) return { ok: false, message: t.reason! };

    const result = await reviseDraft({
      draftId,
      changes,
      actorId: user.id,
      actorLabel: user.email,
      reason,
    });

    if (result.unchanged) {
      return { ok: true, message: "Nothing changed, so no new version was created." };
    }

    revalidatePath("/review");
    revalidatePath(`/drafts/${draftId}`);
    revalidatePath(`/drafts/${result.draft.id}`);

    return {
      ok: true,
      // The caller is looking at the superseded version and must be moved to
      // the new one, or the next thing they do acts on stale content.
      draftId: result.draft.id,
      message: result.approvalVoided
        ? `Version ${result.draft.version} created. The previous approval no longer applies and this version needs review again.`
        : `Version ${result.draft.version} created.`,
    };
  } catch (err) { return fail(err); }
}

export async function generateForProspect(
  campaignId: string, prospectId: string, contactId?: string,
): Promise<ActionResult & { draftId?: string }> {
  try {
    const user = await requirePermission("draft:write");
    const { draft, validation } = await generateDraft({
      campaignId, prospectId, contactId,
      actorId: user.id, actorLabel: user.email,
    });

    revalidatePath("/prospects");
    const blocking = validation.issues.filter((i) => i.severity === "blocking").length;

    return {
      ok: true,
      draftId: draft.id,
      message: blocking > 0
        ? `Draft created, but ${blocking} safety check(s) failed. It cannot be approved until they are resolved.`
        : "Draft created and ready for review.",
    };
  } catch (err) { return fail(err); }
}

/**
 * Queues an approved draft. Runs the full send guard first so the user gets a
 * specific reason rather than a job that silently dies in the worker.
 */
export async function queueSend(
  draftId: string, isTest = false,
): Promise<ActionResult> {
  try {
    const user = await requirePermission(isTest ? "email:test_send" : "email:send");

    const auth = await authorizeSend({ draftId, actorId: user.id, isTest });
    if (!auth.ok) {
      await writeAudit({
        actorId: user.id, actorLabel: user.email,
        action: "send.blocked", entity: "email_draft", entityId: draftId,
        ip: await requestIp(),
        metadata: { failures: auth.failures, isTest },
      });
      return {
        ok: false,
        message: "This message was not queued.",
        failures: auth.failures,
      };
    }

    const key = buildIdempotencyKey(draftId, auth.draft.contentHash, isTest);

    const [job] = await db.insert(sendJobs).values({
      draftId,
      approvalId: auth.approvalId,
      contentHash: auth.draft.contentHash,
      recipientEmail: auth.draft.recipientEmail!,
      isTest,
      idempotencyKey: key,
      createdBy: user.id,
    })
      // The unique index on the key turns a double click into a no-op rather
      // than a second email.
      .onConflictDoNothing({ target: sendJobs.idempotencyKey })
      .returning({ id: sendJobs.id });

    if (!job) {
      return { ok: true, message: "This message is already queued. No second copy was created." };
    }

    if (!isTest) {
      await db.update(emailDrafts).set({ status: "queued" })
        .where(eq(emailDrafts.id, draftId));
    }

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: isTest ? "send.test_queued" : "send.queued",
      entity: "send_job", entityId: job.id,
      afterHash: auth.draft.contentHash,
      ip: await requestIp(),
      metadata: { draftId, recipient: auth.draft.recipientEmail, idempotencyKey: key },
    });

    revalidatePath("/send-queue");
    revalidatePath(`/drafts/${draftId}`);

    return {
      ok: true,
      message: isTest
        ? "Test message queued to the internal allow-listed address."
        : "Queued. The worker re-checks every authorization rule before it sends.",
    };
  } catch (err) { return fail(err); }
}

export async function cancelJob(jobId: string, reason: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("email:cancel");
    const [job] = await db.select().from(sendJobs).where(eq(sendJobs.id, jobId)).limit(1);
    if (!job) return { ok: false, message: "Job not found." };
    if (job.status !== "queued") {
      return { ok: false, message: `This job is "${job.status}" and can no longer be cancelled.` };
    }

    await db.update(sendJobs)
      .set({ status: "cancelled", error: `Cancelled by ${user.email}: ${reason}` })
      .where(eq(sendJobs.id, jobId));

    if (!job.isTest) {
      await db.update(emailDrafts).set({ status: "approved" })
        .where(eq(emailDrafts.id, job.draftId));
    }

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "send.cancelled", entity: "send_job", entityId: jobId,
      reason, ip: await requestIp(),
    });

    revalidatePath("/send-queue");
    return { ok: true, message: "Cancelled before delivery." };
  } catch (err) { return fail(err); }
}

/** Records an inbound reply and pauses automation for that prospect. */
export async function recordReply(draftId: string, note: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("prospect:write");
    const draft = await loadDraft(draftId);

    await db.update(emailDrafts).set({ status: "replied" })
      .where(eq(emailDrafts.id, draftId));
    await db.insert(events).values({
      prospectId: draft.prospectId,
      draftId,
      type: "replied",
      metadata: { note, recordedBy: user.email },
    });

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "prospect.replied", entity: "email_draft", entityId: draftId,
      reason: note,
    });

    revalidatePath("/activity");
    return { ok: true, message: "Reply recorded. Follow-ups for this prospect are paused." };
  } catch (err) { return fail(err); }
}
