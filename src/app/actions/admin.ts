"use server";

import { revalidatePath } from "next/cache";
import { eq, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import {
  propertyFacts, suppressions, prospects, contacts, sourceDocuments,
} from "@/db/schema";
import { requirePermission, requestIp, AuthorizationError } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { SETTING_KEYS, setSetting, getSendSwitch } from "@/lib/settings";
import { cancelAllQueued } from "@/worker/send-worker";
import { importSourceDocument } from "@/lib/ingestion/import";
import { putObject, storageKeyFor } from "@/lib/storage";
import { checksumBuffer } from "@/lib/content-hash";
import { classifyProspect, scoreProspect } from "@/lib/scoring";

export interface ActionResult { ok: boolean; message: string }

function fail(err: unknown): ActionResult {
  if (err instanceof AuthorizationError) return { ok: false, message: err.message };
  console.error("[admin action]", err);
  return { ok: false, message: err instanceof Error ? err.message : "Something went wrong." };
}

/* --------------------------------------------------------- property facts */

export async function approvePropertyFact(factId: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("property_facts:manage");
    const [fact] = await db.select().from(propertyFacts)
      .where(eq(propertyFacts.id, factId)).limit(1);
    if (!fact) return { ok: false, message: "Fact not found." };

    await db.update(propertyFacts)
      .set({ approvedBy: user.id, approvedAt: new Date() })
      .where(eq(propertyFacts.id, factId));

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "property_fact.approved", entity: "property_fact", entityId: factId,
      ip: await requestIp(),
      metadata: { key: fact.key, value: fact.value },
    });

    revalidatePath("/settings");
    return { ok: true, message: `"${fact.label}" approved for use in generation.` };
  } catch (err) { return fail(err); }
}

/**
 * Editing a fact supersedes the old row rather than overwriting it, and the
 * new row starts unapproved. Drafts already generated remain traceable to the
 * exact wording that was approved when they were written.
 */
export async function updatePropertyFact(
  factId: string, value: string, notes?: string,
): Promise<ActionResult> {
  try {
    const user = await requirePermission("property_facts:manage");
    const [fact] = await db.select().from(propertyFacts)
      .where(eq(propertyFacts.id, factId)).limit(1);
    if (!fact) return { ok: false, message: "Fact not found." };
    if (value.trim() === fact.value) return { ok: true, message: "No change." };

    await db.transaction(async (tx) => {
      await tx.update(propertyFacts)
        .set({ supersededAt: new Date() })
        .where(eq(propertyFacts.id, factId));

      await tx.insert(propertyFacts).values({
        key: fact.key,
        label: fact.label,
        value: value.trim(),
        version: fact.version + 1,
        notes: notes ?? null,
      });
    });

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "property_fact.updated", entity: "property_fact", entityId: factId,
      ip: await requestIp(),
      metadata: { key: fact.key, from: fact.value, to: value.trim() },
    });

    revalidatePath("/settings");
    return {
      ok: true,
      message: `Version ${fact.version + 1} created. It must be approved again before generation can use it.`,
    };
  } catch (err) { return fail(err); }
}

/* ------------------------------------------------------------ kill switch */

export async function setGlobalSend(enabled: boolean, reason: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings:manage");
    if (!reason.trim()) return { ok: false, message: "State a reason for the change." };

    await setSetting(SETTING_KEYS.globalSendEnabled, enabled, user.id);

    // Turning the switch off also stops work already in the queue; leaving
    // queued jobs to fire after an emergency stop would defeat the control.
    let cancelled = 0;
    if (!enabled) {
      cancelled = await cancelAllQueued(user.id, user.email, reason.trim());
    }

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: enabled ? "settings.send_enabled" : "settings.send_disabled",
      entity: "settings", entityId: SETTING_KEYS.globalSendEnabled,
      reason: reason.trim(), ip: await requestIp(),
      metadata: { cancelledJobs: cancelled },
    });

    const state = await getSendSwitch();
    revalidatePath("/settings");
    revalidatePath("/dashboard");

    return {
      ok: true,
      message: enabled
        ? state.enabled
          ? "Sending is now enabled."
          : `Admin switch is on, but delivery is still blocked: ${state.reason}`
        : `Sending disabled. ${cancelled} queued job(s) were cancelled.`,
    };
  } catch (err) { return fail(err); }
}

export async function updateNumericSetting(key: string, value: number): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings:manage");
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, message: "Enter a non-negative number." };
    }
    await setSetting(key, Math.round(value), user.id);
    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "settings.updated", entity: "settings", entityId: key,
      ip: await requestIp(), metadata: { value },
    });
    revalidatePath("/settings");
    return { ok: true, message: "Saved." };
  } catch (err) { return fail(err); }
}

export async function updateTestAllowlist(raw: string): Promise<ActionResult> {
  try {
    const user = await requirePermission("settings:manage");
    const list = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const invalid = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e));
    if (invalid.length) {
      return { ok: false, message: `Not valid addresses: ${invalid.join(", ")}` };
    }
    await setSetting(SETTING_KEYS.testSendAllowlist, list, user.id);
    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "settings.test_allowlist_updated", entity: "settings",
      entityId: SETTING_KEYS.testSendAllowlist,
      ip: await requestIp(), metadata: { count: list.length },
    });
    revalidatePath("/settings");
    return { ok: true, message: `${list.length} internal test address(es) allow-listed.` };
  } catch (err) { return fail(err); }
}

/* ----------------------------------------------------------- suppressions */

export async function addSuppression(
  value: string, reason: string,
): Promise<ActionResult> {
  try {
    const user = await requirePermission("suppression:manage");
    const v = value.trim().toLowerCase();
    if (!v) return { ok: false, message: "Enter an address or domain." };
    if (!reason.trim()) return { ok: false, message: "State a reason." };

    const isEmail = v.includes("@");
    await db.insert(suppressions).values({
      email: isEmail ? v : null,
      domain: isEmail ? null : v,
      reason: reason.trim(),
      source: "manual",
      createdBy: user.id,
    }).onConflictDoNothing();

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "suppression.added", entity: "suppression", entityId: v,
      reason: reason.trim(), ip: await requestIp(),
    });

    revalidatePath("/settings");
    return { ok: true, message: `${v} will never be contacted again.` };
  } catch (err) { return fail(err); }
}

/* --------------------------------------------------------------- sources */

export async function uploadAndExtract(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requirePermission("source:upload");
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: "Choose a file to upload." };
    }
    if (file.type !== "application/pdf") {
      return { ok: false, message: "Only PDF sources are supported in this version." };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = checksumBuffer(bytes);
    const key = storageKeyFor("sources", file.name, checksum);

    await putObject(key, bytes, file.type);

    const [doc] = await db.insert(sourceDocuments).values({
      filename: file.name,
      storageKey: key,
      mimeType: file.type,
      sizeBytes: file.size,
      checksum,
      uploadedBy: user.id,
    }).returning({ id: sourceDocuments.id });

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "source.uploaded", entity: "source_document", entityId: doc.id,
      ip: await requestIp(),
      metadata: { filename: file.name, sizeBytes: file.size, checksum },
    });

    const summary = await importSourceDocument({
      sourceDocumentId: doc.id,
      fileBytes: bytes,
      actorId: user.id,
      actorLabel: user.email,
    });

    revalidatePath("/sources");
    revalidatePath("/prospects");

    return {
      ok: true,
      message: `Extracted ${summary.pagesProcessed} pages. ${summary.prospectsCreated} prospects created, ${summary.duplicatesFlagged} possible duplicates flagged, ${summary.needsDataReview} routed to data review.`,
    };
  } catch (err) { return fail(err); }
}

/* ------------------------------------------------------------- prospects */

export async function confirmContact(
  contactId: string, email: string,
): Promise<ActionResult> {
  try {
    const user = await requirePermission("prospect:write");
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
      return { ok: false, message: "That is not a valid email address." };
    }

    const [contact] = await db.select().from(contacts)
      .where(eq(contacts.id, contactId)).limit(1);
    if (!contact) return { ok: false, message: "Contact not found." };

    await db.update(contacts).set({
      email: clean,
      // A person has now looked at this address and vouched for it.
      confidence: 100,
      verifiedAt: new Date(),
      verifiedBy: user.id,
    }).where(eq(contacts.id, contactId));

    // Re-score, because contact completeness feeds the relevance score.
    await rescoreProspect(contact.prospectId);

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "contact.verified", entity: "contact", entityId: contactId,
      ip: await requestIp(),
      metadata: { email: clean, previous: contact.email },
    });

    revalidatePath(`/prospects/${contact.prospectId}`);
    return { ok: true, message: "Contact confirmed." };
  } catch (err) { return fail(err); }
}

export async function setProspectStatus(
  prospectId: string,
  status: "imported" | "qualified" | "excluded" | "needs_data_review",
  reason?: string,
): Promise<ActionResult> {
  try {
    const user = await requirePermission("prospect:write");
    if (status === "excluded" && !reason?.trim()) {
      return { ok: false, message: "State why this prospect is excluded." };
    }

    await db.update(prospects).set({
      status,
      exclusionReason: status === "excluded" ? reason!.trim() : null,
    }).where(eq(prospects.id, prospectId));

    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: `prospect.${status}`, entity: "prospect", entityId: prospectId,
      reason: reason?.trim() ?? null, ip: await requestIp(),
    });

    revalidatePath("/prospects");
    revalidatePath(`/prospects/${prospectId}`);
    return { ok: true, message: `Prospect marked ${status.replace(/_/g, " ")}.` };
  } catch (err) { return fail(err); }
}

async function rescoreProspect(prospectId: string) {
  const [p] = await db.select().from(prospects).where(eq(prospects.id, prospectId)).limit(1);
  if (!p) return;
  const [contact] = await db.select().from(contacts)
    .where(and(eq(contacts.prospectId, prospectId), eq(contacts.isPrimary, true))).limit(1);

  const classification = classifyProspect({
    companyName: p.companyName, sector: p.sector, productsServices: p.productsServices,
  });
  const score = scoreProspect({
    classification,
    contact: contact
      ? { fullName: contact.fullName, designation: contact.designation, email: contact.email, phone: contact.phone }
      : null,
    website: p.website,
    address: p.address,
    strategicRelationship: null,
  });

  await db.update(prospects).set({
    score: score.total,
    scoreBreakdown: score.breakdown,
    rationale: score.rationale.join(" "),
    segment: classification.segment,
    suggestedFloor: classification.floor,
  }).where(eq(prospects.id, prospectId));
}

/** Facts still awaiting management sign-off. */
export async function unapprovedFactCount(): Promise<number> {
  const rows = await db.select().from(propertyFacts)
    .where(isNull(propertyFacts.supersededAt));
  return rows.filter((r) => r.approvedAt === null).length;
}
