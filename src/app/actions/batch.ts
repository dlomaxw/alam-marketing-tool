"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { prospects, contacts, emailDrafts, campaigns } from "@/db/schema";
import { requirePermission, AuthorizationError } from "@/lib/auth/session";
import { generateDraft, DraftError } from "@/lib/drafts";
import { writeAudit } from "@/lib/audit";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

export interface BatchItem {
  prospectId: string;
  company: string;
  ok: boolean;
  draftId?: string;
  message: string;
  needsReview?: boolean;
}

export interface BatchResult {
  ok: boolean;
  message: string;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Candidates left after this run, so the operator knows to run it again. */
  remaining: number;
  items: BatchItem[];
}

/** Hard ceiling regardless of what the caller asks for. */
const MAX_BATCH = 10;

/**
 * Generation is sequential and slow, and the whole call runs inside one
 * request. Stopping cleanly before the platform kills the function is what
 * turns "half the batch vanished" into "3 of 5 done, run it again".
 */
const TIME_BUDGET_MS = 45_000;

/** Gemini free tiers rate limit aggressively; pacing beats retrying. */
const PACE_MS = 1_500;

/**
 * Candidates for drafting: classified, emailable, scoring at or above the
 * configured threshold, not excluded, and without a live draft already.
 */
export async function batchCandidates(segment?: string): Promise<{
  total: number;
  preview: { id: string; company: string; score: number; email: string | null }[];
}> {
  await requirePermission("draft:read");
  const minScore = await getSetting<number>(SETTING_KEYS.minScoreToDraft);

  const drafted = await db
    .selectDistinct({ id: emailDrafts.prospectId })
    .from(emailDrafts)
    .where(isNull(emailDrafts.supersededById));
  const draftedIds = drafted.map((d) => d.id);

  const rows = await db
    .select({
      id: prospects.id,
      company: prospects.companyName,
      score: prospects.score,
      email: sql<string | null>`(
        SELECT c.email FROM ${contacts} c
        WHERE c.prospect_id = ${prospects}.id AND c.is_primary = true
        LIMIT 1
      )`.as("primary_email"),
    })
    .from(prospects)
    .where(and(
      notInArray(prospects.segment, ["unclassified"]),
      notInArray(prospects.status, ["excluded", "needs_data_review"]),
      sql`${prospects.score} >= ${minScore}`,
      segment ? eq(prospects.segment, segment as never) : undefined,
      draftedIds.length ? notInArray(prospects.id, draftedIds) : undefined,
    ))
    .orderBy(desc(prospects.score), prospects.companyName)
    .limit(200);

  const emailable = rows.filter((r) => r.email);
  return { total: emailable.length, preview: emailable.slice(0, MAX_BATCH) };
}

/**
 * Generates drafts for the highest-scoring candidates.
 *
 * Bulk *generation* only. Section 8.1 disables bulk approval, and nothing here
 * approves, queues or sends anything — every draft still has to be opened and
 * decided on individually.
 */
export async function generateBatch(
  count: number,
  segment?: string,
): Promise<BatchResult> {
  const started = Date.now();

  try {
    const user = await requirePermission("draft:write");

    const [campaign] = await db.select().from(campaigns)
      .where(eq(campaigns.status, "active")).limit(1);
    if (!campaign) {
      return empty("No active campaign. Create one before generating drafts.");
    }

    const { total, preview } = await batchCandidates(segment);
    const take = Math.min(Math.max(1, count), MAX_BATCH, preview.length);
    const targets = preview.slice(0, take);

    if (!targets.length) {
      return empty(
        "No prospects are ready for drafting. Candidates need a segment, an email address and a score at or above the drafting threshold.",
      );
    }

    const items: BatchItem[] = [];

    for (const target of targets) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        // Stop starting new work rather than being killed mid-generation.
        break;
      }

      try {
        const { draft, validation } = await generateDraft({
          campaignId: campaign.id,
          prospectId: target.id,
          actorId: user.id,
          actorLabel: user.email,
        });

        const blocking = validation.issues.filter((i) => i.severity === "blocking").length;
        items.push({
          prospectId: target.id,
          company: target.company,
          ok: true,
          draftId: draft.id,
          needsReview: draft.needsManualReview,
          message: blocking > 0
            ? `Created, but ${blocking} safety check(s) failed.`
            : "Created.",
        });
      } catch (err) {
        items.push({
          prospectId: target.id,
          company: target.company,
          ok: false,
          message: err instanceof DraftError || err instanceof Error
            ? err.message
            : "Generation failed.",
        });
      }

      await new Promise((r) => setTimeout(r, PACE_MS));
    }

    const succeeded = items.filter((i) => i.ok).length;
    const failed = items.length - succeeded;

    await writeAudit({
      actorId: user.id,
      actorLabel: user.email,
      action: "draft.batch_generated",
      entity: "campaign",
      entityId: campaign.id,
      metadata: { requested: take, attempted: items.length, succeeded, failed, segment },
    });

    revalidatePath("/review");
    revalidatePath("/prospects");

    const stoppedEarly = items.length < take;
    return {
      ok: succeeded > 0,
      attempted: items.length,
      succeeded,
      failed,
      remaining: Math.max(0, total - succeeded),
      items,
      message: stoppedEarly
        ? `${succeeded} draft(s) created before the time limit. Run it again for the rest.`
        : `${succeeded} draft(s) created${failed ? `, ${failed} failed` : ""}. Each still needs to be reviewed and approved individually.`,
    };
  } catch (err) {
    if (err instanceof AuthorizationError) return empty(err.message);
    console.error("[batch]", err);
    return empty("The batch could not be started.");
  }
}

function empty(message: string): BatchResult {
  return { ok: false, message, attempted: 0, succeeded: 0, failed: 0, remaining: 0, items: [] };
}
