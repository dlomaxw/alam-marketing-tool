import { and, eq, gte, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  emailDrafts, approvals, suppressions, sendJobs, users, roles,
} from "@/db/schema";
import { hashesMatch } from "@/lib/content-hash";
import { getSendSwitch, getDailySendLimit, getTestAllowlist } from "@/lib/settings";
import { NON_SENDABLE, type DraftStatus } from "@/lib/draft-state";

/**
 * Authorization for delivery, section 15.1.
 *
 * Every check runs here and nowhere else, and it runs twice: once when a user
 * asks to queue a message, and again inside the worker immediately before the
 * provider call. The second pass is the one that matters — between queueing
 * and sending, an approval can be revoked, a recipient can opt out, or an
 * administrator can hit the kill switch, and none of those should require
 * finding and cancelling an in-flight job to take effect.
 */

export interface GuardFailure {
  code: string;
  message: string;
}

export type GuardResult =
  | { ok: true; draft: typeof emailDrafts.$inferSelect; approvalId: string }
  | { ok: false; failures: GuardFailure[] };

export interface GuardOptions {
  draftId: string;
  /** The user asking to send, or null when the send worker is re-checking. */
  actorId: string | null;
  isTest?: boolean;
}

export async function authorizeSend(opts: GuardOptions): Promise<GuardResult> {
  const failures: GuardFailure[] = [];
  const isTest = opts.isTest === true;

  /* 1. The draft must exist and be the current version. */
  const [draft] = await db.select().from(emailDrafts)
    .where(eq(emailDrafts.id, opts.draftId)).limit(1);

  if (!draft) {
    return { ok: false, failures: [{ code: "draft_missing", message: "Draft not found." }] };
  }

  if (draft.supersededById) {
    failures.push({
      code: "draft_superseded",
      message: "This draft version has been superseded by a newer edit.",
    });
  }

  /* 2. Global kill switch. Checked before anything else that could be slow. */
  const sendSwitch = await getSendSwitch();
  if (!sendSwitch.enabled) {
    failures.push({ code: "send_disabled", message: sendSwitch.reason });
  }

  /* 3. Status must permit delivery. */
  if (NON_SENDABLE.has(draft.status as DraftStatus)) {
    failures.push({
      code: "status_not_sendable",
      message: `A draft with status "${draft.status}" must never be delivered.`,
    });
  }

  /* 4. A live approval must exist for this exact version AND content hash. */
  const [approval] = await db.select().from(approvals)
    .where(and(
      eq(approvals.draftId, draft.id),
      eq(approvals.draftVersion, draft.version),
      eq(approvals.decision, "approved"),
    ))
    .orderBy(sql`${approvals.createdAt} desc`)
    .limit(1);

  if (!approval) {
    failures.push({
      code: "no_approval",
      message: "No approval record exists for this draft version.",
    });
  } else if (!hashesMatch(approval.contentHash, draft.contentHash)) {
    // This is the edit-after-approval case. The content moved; the approval
    // did not follow it.
    failures.push({
      code: "hash_mismatch",
      message: "The draft content has changed since it was approved. The approval no longer applies.",
    });
  } else {
    /* 4b. A later revocation on the same version voids it. */
    const [revocation] = await db.select().from(approvals)
      .where(and(
        eq(approvals.draftId, draft.id),
        eq(approvals.draftVersion, draft.version),
        or(eq(approvals.decision, "revoked"), eq(approvals.decision, "rejected")),
        gte(approvals.createdAt, approval.createdAt),
      ))
      .limit(1);

    if (revocation) {
      failures.push({
        code: "approval_revoked",
        message: "The approval for this version was subsequently revoked or rejected.",
      });
    }

    /* 4c. The approver must still hold the right to approve. */
    const [approver] = await db.select({
      status: users.status,
      permissions: roles.permissions,
    })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, approval.approverId))
      .limit(1);

    if (!approver || approver.status !== "active") {
      failures.push({
        code: "approver_inactive",
        message: "The approving user is no longer active.",
      });
    } else if (!(approver.permissions ?? []).includes("draft:approve")) {
      failures.push({
        code: "approver_unauthorized",
        message: "The approving user no longer holds the approve permission.",
      });
    }
  }

  /* 5. Recipient must be present and not suppressed. */
  const recipient = (draft.recipientEmail ?? "").trim().toLowerCase();
  if (!recipient) {
    failures.push({ code: "no_recipient", message: "The draft has no recipient address." });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) {
    failures.push({ code: "invalid_recipient", message: `"${recipient}" is not a valid address.` });
  } else {
    const domain = recipient.split("@")[1];
    const [suppressed] = await db.select().from(suppressions)
      .where(or(eq(suppressions.email, recipient), eq(suppressions.domain, domain)))
      .limit(1);

    if (suppressed) {
      failures.push({
        code: "suppressed",
        message: `${recipient} is suppressed (${suppressed.source}: ${suppressed.reason}).`,
      });
    }

    /* 5b. A test send may only ever reach an allow-listed internal address. */
    if (isTest) {
      const allow = await getTestAllowlist();
      if (!allow.includes(recipient)) {
        failures.push({
          code: "test_not_allowlisted",
          message: `Test sends may only go to an allow-listed internal address. "${recipient}" is not on the list.`,
        });
      }
    }
  }

  /* 6. Daily volume cap. Test sends do not consume prospect volume. */
  if (!isTest) {
    const limit = await getDailySendLimit();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(sendJobs)
      .where(and(
        eq(sendJobs.status, "sent"),
        eq(sendJobs.isTest, false),
        gte(sendJobs.sentAt, since),
      ));

    if (count >= limit) {
      failures.push({
        code: "daily_limit",
        message: `The 24-hour send limit of ${limit} has been reached (${count} sent).`,
      });
    }
  }

  /* 7. When a person initiated this, they must hold email:send. */
  if (opts.actorId) {
    const [actor] = await db.select({
      status: users.status,
      permissions: roles.permissions,
    })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, opts.actorId))
      .limit(1);

    const needed = isTest ? "email:test_send" : "email:send";
    if (!actor || actor.status !== "active") {
      failures.push({ code: "actor_inactive", message: "The requesting user is not active." });
    } else if (!(actor.permissions ?? []).includes(needed)) {
      failures.push({
        code: "actor_unauthorized",
        message: `The requesting user does not hold "${needed}".`,
      });
    }

    /* 7b. Section 8.1: an approver may not rubber-stamp their own draft. */
    if (approval && approval.approverId === draft.createdBy) {
      failures.push({
        code: "self_approval",
        message: "The draft was approved by the same user who created it. A second person must approve.",
      });
    }
  }

  if (failures.length) return { ok: false, failures };
  return { ok: true, draft, approvalId: approval!.id };
}

/**
 * Stable idempotency key. Derived from the draft and its content hash, so a
 * double-clicked button or a retried worker resolves to the same row and the
 * unique index turns the second attempt into a no-op rather than a second
 * email. A new version produces a new hash and therefore a new key.
 */
export function buildIdempotencyKey(
  draftId: string, contentHash: string, isTest: boolean,
): string {
  return `${isTest ? "test" : "live"}:${draftId}:${contentHash.slice(0, 32)}`;
}

/** Unsent jobs the kill switch should stop. */
export async function pendingJobCount(): Promise<number> {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(sendJobs)
    .where(and(eq(sendJobs.status, "queued"), isNull(sendJobs.sentAt)));
  return count;
}
