/**
 * Integration tests for the send guard, run against a real database.
 *
 * The unit tests prove the rules in isolation; these prove the rules actually
 * hold when the data is in Postgres and the worker is the thing asking. That
 * distinction matters here, because every safety property of this product is a
 * claim about what happens at the moment of delivery.
 *
 * Opt-in: these create and delete rows, so they only run with ALLOW_DB_TESTS=1
 * and never by accident against a production database.
 *
 *   ALLOW_DB_TESTS=1 AI_PROVIDER=stub npm run test:db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, and } from "drizzle-orm";
import { db, pool } from "@/db";
import {
  users, roles, campaigns, prospects, contacts, emailDrafts, approvals,
  sendJobs, suppressions, settings, events, draftEvidence, auditLog,
} from "@/db/schema";
import { authorizeSend, buildIdempotencyKey } from "@/lib/email/send-guard";
import { generateDraft, reviseDraft } from "@/lib/drafts";
import { runSendWorker } from "@/worker/send-worker";
import { computeContentHash } from "@/lib/content-hash";
import { SETTING_KEYS } from "@/lib/settings";
import { ROLE_PERMISSIONS } from "@/lib/auth/rbac";
import { hashPassword } from "@/lib/auth/password";
import { checkLoginRateLimit } from "@/lib/auth/rate-limit";

const ENABLED = process.env.ALLOW_DB_TESTS === "1";
const suite = ENABLED ? describe : describe.skip;

/** Everything this suite creates is tagged so cleanup can be exact. */
const TAG = `itest-${randomUUID().slice(0, 8)}`;

let authorId = "";
let approverId = "";
let senderId = "";
let campaignId = "";
let prospectId = "";
let contactId = "";
let draftId = "";

/** Restored in afterAll so a crashed run cannot leave sending enabled. */
let originalSendSetting: unknown = undefined;

async function makeUser(name: string, permissions: string[]): Promise<string> {
  const [role] = await db.insert(roles).values({
    name: `${TAG}-${name}`,
    description: "integration test role",
    permissions,
  }).returning({ id: roles.id });

  const [user] = await db.insert(users).values({
    name: `${TAG} ${name}`,
    email: `${TAG}.${name}@integration.invalid`,
    passwordHash: await hashPassword("not-used-for-these-tests-0000"),
    roleId: role.id,
    status: "active",
  }).returning({ id: users.id });

  return user.id;
}

async function setSendSwitch(on: boolean) {
  await db.insert(settings)
    .values({ key: SETTING_KEYS.globalSendEnabled, value: on as never })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: on as never, updatedAt: new Date() },
    });
}

async function currentDraft(id: string) {
  const [row] = await db.select().from(emailDrafts).where(eq(emailDrafts.id, id)).limit(1);
  return row;
}

async function approveAs(userId: string, id: string) {
  const draft = await currentDraft(id);
  await db.insert(approvals).values({
    draftId: draft.id,
    draftVersion: draft.version,
    contentHash: draft.contentHash,
    approverId: userId,
    decision: "approved",
  });
  await db.update(emailDrafts).set({ status: "approved" }).where(eq(emailDrafts.id, id));
}

function codes(result: Awaited<ReturnType<typeof authorizeSend>>): string[] {
  return result.ok ? [] : result.failures.map((f) => f.code);
}

suite("send guard against a real database", () => {
  beforeAll(async () => {
    if (process.env.AI_PROVIDER !== "stub") {
      throw new Error("Run these with AI_PROVIDER=stub so no tokens are spent.");
    }

    const [existing] = await db.select().from(settings)
      .where(eq(settings.key, SETTING_KEYS.globalSendEnabled)).limit(1);
    originalSendSetting = existing?.value;

    authorId = await makeUser("author", [...ROLE_PERMISSIONS["Campaign Manager"]]);
    approverId = await makeUser("approver", [...ROLE_PERMISSIONS.Reviewer]);
    senderId = await makeUser("sender", [
      ...ROLE_PERMISSIONS.Reviewer, "email:send", "email:test_send", "email:cancel",
    ]);

    [{ id: campaignId }] = await db.insert(campaigns).values({
      name: `${TAG} campaign`,
      objective: "Integration test campaign.",
      segment: "vehicle_motorcycle",
      targetFloor: "ground",
      ctaLabel: "Schedule a Private Site Visit",
      ctaUrl: "https://example.com/visit",
      senderName: "Integration Tester",
      senderEmail: "leasing@integration.invalid",
      ownerId: authorId,
    }).returning({ id: campaigns.id });

    [{ id: prospectId }] = await db.insert(prospects).values({
      companyName: `${TAG} MOTORS LIMITED`,
      sector: "Automotive",
      productsServices: "tyres, oil and batteries, automotive products",
      address: "Plot 1, Industrial Area, Kampala",
      website: "https://example.com",
      segment: "vehicle_motorcycle",
      suggestedFloor: "ground",
      score: 85,
      status: "imported",
      dedupeKey: `${TAG}motors`,
      ownerId: authorId,
    }).returning({ id: prospects.id });

    [{ id: contactId }] = await db.insert(contacts).values({
      prospectId,
      fullName: "Mr. Test Recipient",
      designation: "Managing Director",
      email: `${TAG}@integration.invalid`,
      confidence: 95,
      isPrimary: true,
    }).returning({ id: contacts.id });

    await setSendSwitch(false);
  }, 120_000);

  afterAll(async () => {
    // Order matters: children before parents, and the send switch is restored
    // first so a failure part-way through still leaves delivery off.
    try {
      await setSendSwitch(originalSendSetting === true);

      const drafts = await db.select({ id: emailDrafts.id })
        .from(emailDrafts).where(eq(emailDrafts.campaignId, campaignId));
      const draftIds = drafts.map((d) => d.id);

      if (draftIds.length) {
        // The worker writes audit rows with actorId = null, so deleting by
        // actor (below) misses them. Left behind, they are false
        // "send.delivered" records in a compliance log, for jobs that no
        // longer exist. Collect the job ids before the jobs are deleted.
        const jobIds = (await db.select({ id: sendJobs.id })
          .from(sendJobs).where(inArray(sendJobs.draftId, draftIds)))
          .map((j) => j.id);

        if (jobIds.length) {
          await db.delete(auditLog).where(inArray(auditLog.entityId, jobIds));
        }
        await db.delete(auditLog).where(inArray(auditLog.entityId, draftIds));

        await db.delete(events).where(inArray(events.draftId, draftIds));
        await db.delete(sendJobs).where(inArray(sendJobs.draftId, draftIds));
        await db.delete(approvals).where(inArray(approvals.draftId, draftIds));
        await db.delete(draftEvidence).where(inArray(draftEvidence.draftId, draftIds));
        // Clear the self-reference before deleting, or the FK blocks it.
        await db.update(emailDrafts).set({ supersededById: null })
          .where(inArray(emailDrafts.id, draftIds));
        await db.delete(emailDrafts).where(inArray(emailDrafts.id, draftIds));
      }

      await db.delete(events).where(eq(events.prospectId, prospectId));
      await db.delete(contacts).where(eq(contacts.prospectId, prospectId));
      await db.delete(prospects).where(eq(prospects.id, prospectId));
      await db.delete(campaigns).where(eq(campaigns.id, campaignId));
      await db.delete(suppressions).where(eq(suppressions.reason, `${TAG} suppression`));

      const ids = [authorId, approverId, senderId].filter(Boolean);
      await db.delete(auditLog).where(inArray(auditLog.actorId, ids));
      await db.delete(users).where(inArray(users.id, ids));
      await db.delete(roles).where(inArray(roles.name, [
        `${TAG}-author`, `${TAG}-approver`, `${TAG}-sender`,
      ]));
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("generates a draft without creating any send job", async () => {
    const { draft } = await generateDraft({
      campaignId, prospectId, contactId,
      actorId: authorId, actorLabel: "author",
    });
    draftId = draft.id;

    expect(draft.status).toBe("draft");
    expect(draft.version).toBe(1);
    expect(draft.contentHash).toHaveLength(64);

    // Section 4: drafting must never schedule a send.
    const jobs = await db.select().from(sendJobs).where(eq(sendJobs.draftId, draft.id));
    expect(jobs).toHaveLength(0);
  }, 120_000);

  it("refuses to send a draft that has never been approved", async () => {
    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("no_approval");
    expect(codes(result)).toContain("status_not_sendable");
  });

  it("still refuses once approved, because the global switch is off", async () => {
    await approveAs(approverId, draftId);
    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("send_disabled");
    // The approval itself is now valid; only the switch stands in the way.
    expect(codes(result)).not.toContain("no_approval");
    expect(codes(result)).not.toContain("hash_mismatch");
  });

  it("passes every check except the switch once approved", async () => {
    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(codes(result)).toEqual(["send_disabled"]);
  });

  it("voids the approval when the approved draft is edited", async () => {
    const before = await currentDraft(draftId);

    const { draft: revised } = await reviseDraft({
      draftId,
      changes: { subject: "An edited subject that nobody approved" },
      actorId: authorId,
      actorLabel: "author",
    });

    expect(revised.version).toBe(before.version + 1);
    expect(revised.status).toBe("draft");
    expect(revised.contentHash).not.toBe(before.contentHash);
    expect(revised.riskFlags).toContain("edited_after_approval");

    // The old version is superseded, and the new one carries no approval.
    const old = await currentDraft(draftId);
    expect(old.supersededById).toBe(revised.id);

    const oldResult = await authorizeSend({ draftId: old.id, actorId: senderId });
    expect(codes(oldResult)).toContain("draft_superseded");

    const newResult = await authorizeSend({ draftId: revised.id, actorId: senderId });
    expect(codes(newResult)).toContain("no_approval");

    draftId = revised.id;
  }, 60_000);

  it("refuses when the stored hash no longer matches the content", async () => {
    await approveAs(approverId, draftId);

    // Simulate content drifting away from what was approved. The approval row
    // is untouched; only the draft moves.
    const draft = await currentDraft(draftId);
    const tampered = { ...draft, subject: "Tampered after approval" };
    await db.update(emailDrafts).set({
      subject: tampered.subject,
      contentHash: computeContentHash({
        subject: tampered.subject,
        previewText: draft.previewText,
        salutation: draft.salutation,
        bodyHtml: draft.bodyHtml,
        bodyText: draft.bodyText,
        ctaLabel: draft.ctaLabel,
        ctaUrl: draft.ctaUrl,
        recipientEmail: draft.recipientEmail,
        recipientLogoAssetId: draft.recipientLogoAssetId,
      }),
    }).where(eq(emailDrafts.id, draftId));

    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(codes(result)).toContain("hash_mismatch");

    // Put it back so later tests start from a consistent approval.
    await db.update(emailDrafts).set({
      subject: draft.subject,
      contentHash: draft.contentHash,
    }).where(eq(emailDrafts.id, draftId));
  });

  it("refuses a sender who lacks email:send", async () => {
    const result = await authorizeSend({ draftId, actorId: approverId });
    expect(codes(result)).toContain("actor_unauthorized");
  });

  it("refuses when the approver is also the author", async () => {
    const draft = await currentDraft(draftId);
    await db.insert(approvals).values({
      draftId: draft.id,
      draftVersion: draft.version,
      contentHash: draft.contentHash,
      approverId: authorId, // the author approving their own draft
      decision: "approved",
    });

    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(codes(result)).toContain("self_approval");

    // Remove it so the legitimate approval is latest again.
    await db.delete(approvals).where(and(
      eq(approvals.draftId, draft.id),
      eq(approvals.approverId, authorId),
    ));
  });

  it("refuses a suppressed recipient", async () => {
    const draft = await currentDraft(draftId);
    await db.insert(suppressions).values({
      email: draft.recipientEmail!.toLowerCase(),
      reason: `${TAG} suppression`,
      source: "opt_out",
    });

    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(codes(result)).toContain("suppressed");

    await db.delete(suppressions)
      .where(eq(suppressions.email, draft.recipientEmail!.toLowerCase()));
  });

  it("refuses a revoked approval", async () => {
    const draft = await currentDraft(draftId);
    await db.insert(approvals).values({
      draftId: draft.id,
      draftVersion: draft.version,
      contentHash: draft.contentHash,
      approverId: approverId,
      decision: "revoked",
      reason: "changed our mind",
    });

    const result = await authorizeSend({ draftId, actorId: senderId });
    expect(codes(result)).toContain("approval_revoked");

    await db.delete(approvals).where(and(
      eq(approvals.draftId, draft.id),
      eq(approvals.decision, "revoked"),
    ));
  });

  it("blocks a test send to an address that is not allow-listed", async () => {
    const result = await authorizeSend({ draftId, actorId: senderId, isTest: true });
    expect(codes(result)).toContain("test_not_allowlisted");
  });

  it("creates exactly one job for a duplicated queue request", async () => {
    const draft = await currentDraft(draftId);
    const key = buildIdempotencyKey(draft.id, draft.contentHash, false);

    const values = {
      draftId: draft.id,
      contentHash: draft.contentHash,
      recipientEmail: draft.recipientEmail!,
      isTest: false,
      idempotencyKey: key,
      createdBy: senderId,
    };

    const first = await db.insert(sendJobs).values(values)
      .onConflictDoNothing({ target: sendJobs.idempotencyKey })
      .returning({ id: sendJobs.id });
    const second = await db.insert(sendJobs).values(values)
      .onConflictDoNothing({ target: sendJobs.idempotencyKey })
      .returning({ id: sendJobs.id });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // the duplicate is a no-op, not a second email

    const jobs = await db.select().from(sendJobs).where(eq(sendJobs.draftId, draft.id));
    expect(jobs).toHaveLength(1);
  });

  it("refuses the queued job at send time while the switch is off", async () => {
    await db.update(emailDrafts).set({ status: "queued" })
      .where(eq(emailDrafts.id, draftId));

    const result = await runSendWorker(5);
    expect(result.refused).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBe(0);

    const [job] = await db.select().from(sendJobs).where(eq(sendJobs.draftId, draftId));
    expect(job.status).toBe("cancelled");
    expect(job.error).toMatch(/send_disabled/);
  }, 60_000);

  it("delivers only when both halves of the kill switch are on", async () => {
    // Both are required. The environment half is set for this process only and
    // the provider is the console adapter, so nothing reaches an inbox.
    process.env.GLOBAL_SEND_ENABLED = "true";
    process.env.EMAIL_PROVIDER = "console";
    await setSendSwitch(true);

    const draft = await currentDraft(draftId);
    await db.insert(sendJobs).values({
      draftId: draft.id,
      contentHash: draft.contentHash,
      recipientEmail: draft.recipientEmail!,
      isTest: false,
      idempotencyKey: `${TAG}-live-${randomUUID()}`,
      createdBy: senderId,
    });
    await db.update(emailDrafts).set({ status: "queued" })
      .where(eq(emailDrafts.id, draftId));

    const result = await runSendWorker(5);
    expect(result.sent).toBe(1);

    const after = await currentDraft(draftId);
    expect(after.status).toBe("sent");

    const [sentJob] = await db.select().from(sendJobs)
      .where(and(eq(sendJobs.draftId, draftId), eq(sendJobs.status, "sent")));
    expect(sentJob.providerMessageId).toBeTruthy();
    expect(sentJob.sentAt).toBeTruthy();

    // A delivery event is recorded against the prospect for the audit trail.
    const evts = await db.select().from(events).where(eq(events.draftId, draftId));
    expect(evts.some((e) => e.type === "sent")).toBe(true);

    process.env.GLOBAL_SEND_ENABLED = "false";
    await setSendSwitch(false);
  }, 60_000);

  it("rate-limits repeated failed sign-ins", async () => {
    const email = `${TAG}.bruteforce@integration.invalid`;
    const ip = "203.0.113.42";

    const before = await checkLoginRateLimit(email, ip);
    expect(before.blocked).toBe(false);

    // Eight failures is the per-account threshold.
    await db.insert(auditLog).values(
      Array.from({ length: 8 }, () => ({
        actorLabel: email,
        action: "auth.sign_in_failed",
        entity: "user",
        ip,
        reason: "bad password",
      })),
    );

    const after = await checkLoginRateLimit(email, ip);
    expect(after.blocked).toBe(true);
    expect(after.retryAfterMinutes).toBeGreaterThan(0);

    // A different account from the same address is still under its own limit.
    const other = await checkLoginRateLimit(`${TAG}.someone-else@integration.invalid`, null);
    expect(other.blocked).toBe(false);

    await db.delete(auditLog).where(eq(auditLog.actorLabel, email));
  });

  it("records the whole life of the message in the audit log", async () => {
    // Entries are keyed per draft *version*, so the trail has to be read
    // across the thread: generation belongs to v1, the edit to v2.
    const versions = await db.select({ id: emailDrafts.id })
      .from(emailDrafts).where(eq(emailDrafts.campaignId, campaignId));
    const ids = versions.map((v) => v.id);

    const draftEntries = await db.select().from(auditLog)
      .where(inArray(auditLog.entityId, ids));
    const draftActions = draftEntries.map((e) => e.action);

    expect(draftActions).toContain("draft.generated");
    expect(draftActions).toContain("draft.edited_voiding_approval");

    // The worker's own entries are keyed to the send job, and are attributed
    // to the system rather than to a person.
    const jobs = await db.select({ id: sendJobs.id })
      .from(sendJobs).where(inArray(sendJobs.draftId, ids));
    const jobEntries = await db.select().from(auditLog)
      .where(inArray(auditLog.entityId, jobs.map((j) => j.id)));
    const jobActions = jobEntries.map((e) => e.action);

    expect(jobActions).toContain("send.refused");
    expect(jobActions).toContain("send.delivered");
    expect(jobEntries.every((e) => e.actorLabel === "system:send-worker")).toBe(true);
  });
});
