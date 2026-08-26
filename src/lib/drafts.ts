import { eq, and, isNull, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import {
  emailDrafts, draftEvidence, prospects, contacts, campaigns,
  propertyFacts, prohibitedClaims, approvals, brandAssets,
} from "@/db/schema";
import { generateEmail, GenerationError } from "@/lib/ai/client";
import { PROMPT_VERSION, type GenerationInput } from "@/lib/ai/prompt";
import { validateGeneration } from "@/lib/ai/validate";
import { renderEmailHtml, renderEmailText, sanitizeBodyHtml } from "@/lib/email/template";
import { computeContentHash, type HashableDraft } from "@/lib/content-hash";
import { evidenceForProspect } from "@/lib/ingestion/import";
import { classifyProspect } from "@/lib/scoring";
import { writeAudit } from "@/lib/audit";
import { appBaseUrl, assertUsableForEmail } from "@/lib/app-url";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/**
 * The approved ALAM mark, served from the application's own asset path.
 * Section 6 forbids hot-linking, so this is always an absolute URL on our
 * domain pointing at a file we control.
 */
const ALAM_LOGO_URL = () => `${appBaseUrl()}/alam-logo.png`;

/** The managing agent's mark, credited in the footer. */
const AGENT_LOGO_URL = () => `${appBaseUrl()}/bright-logo.png`;
const AGENT_NAME = "Bright Properties";

/** Approved building render used as the email hero (section 6.1). */
const HERO_IMAGE_URL = () => `${appBaseUrl()}/building-street.jpg`;
const HERO_ALT =
  "Architectural render of ALAM Business Center, Fifth Street, Industrial Area, Kampala";

export class DraftError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "DraftError";
  }
}

/** Approved, current property facts. Generation may read nothing else. */
export async function loadApprovedFacts() {
  const rows = await db.select().from(propertyFacts)
    .where(isNull(propertyFacts.supersededAt));
  // Section 2: only management-approved facts may reach a prompt.
  return rows.filter((r) => r.approvedAt !== null);
}

export interface GenerateOptions {
  campaignId: string;
  prospectId: string;
  contactId?: string | null;
  actorId: string;
  actorLabel: string;
}

/**
 * Generates one draft, version 1 of a new thread.
 *
 * Section 4 is explicit that drafting must never schedule a send. Nothing here
 * touches send_jobs; the draft lands in `draft` status and a person has to
 * move it forward.
 */
export async function generateDraft(opts: GenerateOptions) {
  const [campaign] = await db.select().from(campaigns)
    .where(eq(campaigns.id, opts.campaignId)).limit(1);
  if (!campaign) throw new DraftError("Campaign not found.");

  const [prospect] = await db.select().from(prospects)
    .where(eq(prospects.id, opts.prospectId)).limit(1);
  if (!prospect) throw new DraftError("Prospect not found.");

  if (prospect.status === "excluded") {
    throw new DraftError("This prospect is excluded and must not be contacted.");
  }

  const contact = opts.contactId
    ? (await db.select().from(contacts).where(eq(contacts.id, opts.contactId)).limit(1))[0]
    : (await db.select().from(contacts)
        .where(and(eq(contacts.prospectId, prospect.id), eq(contacts.isPrimary, true)))
        .limit(1))[0];

  // A draft is immutable once written, so an unusable base URL has to be
  // caught before generation, not discovered in an approved email.
  assertUsableForEmail();

  const facts = await loadApprovedFacts();
  if (!facts.length) {
    throw new DraftError(
      "No approved property facts exist. An administrator must verify and approve the property record before any email can be generated.",
    );
  }

  const claims = await db.select().from(prohibitedClaims);
  const evidence = await evidenceForProspect(prospect.id);

  // Section 5.3: an unclear or poor fit is never auto-generated.
  const classification = classifyProspect({
    companyName: prospect.companyName,
    sector: prospect.sector,
    productsServices: prospect.productsServices,
  });
  if (classification.segment === "unclassified") {
    throw new DraftError(
      "This prospect has no clear tenant segment. Section 5.3 requires manual qualification before a draft is generated.",
    );
  }

  const minScore = await getSetting<number>(SETTING_KEYS.minScoreToDraft);
  const belowScore = prospect.score < minScore;

  const input: GenerationInput = {
    prospect: {
      company_name: prospect.companyName,
      sector: prospect.sector,
      products_services: prospect.productsServices,
      contact_name: contact?.fullName ?? null,
      designation: contact?.designation ?? null,
      email: contact?.email ?? null,
      website: prospect.website,
      source_page: prospect.sourcePage,
    },
    property: {
      approved_facts: facts.map((f) => ({ key: f.key, label: f.label, value: f.value })),
      prohibited_claims: claims.map((c) => c.reason),
    },
    campaign: {
      objective: campaign.objective,
      target_floor: classification.floor,
      segment: classification.segment,
      recommended_pitch: classification.pitch,
      cta_label: campaign.ctaLabel,
      cta_url: campaign.ctaUrl,
      sender_name: campaign.senderName,
      sender_email: campaign.senderEmail,
      sender_phone: campaign.senderPhone,
      tone: campaign.tone,
      word_limit: campaign.wordLimit,
    },
    brand: {
      alam_logo_url: ALAM_LOGO_URL(),
      approved_colors: { red: "#C8102E", black: "#1A1A1A" },
      recipient_logo_status: "unavailable",
    },
    evidence,
    policy: {
      send_disabled: true,
      prohibited_language: claims.map((c) => c.pattern),
      required_footer: "Sender identity, phone, website, physical address and opt-out link.",
    },
  };

  let completion;
  try {
    completion = await generateEmail(input);
  } catch (err) {
    if (err instanceof GenerationError) {
      throw new DraftError(err.message, err.detail);
    }
    throw err;
  }

  const validation = validateGeneration(completion.output, {
    contactName: contact?.fullName ?? null,
    wordLimit: campaign.wordLimit,
    availableEvidenceIds: evidence.map((e) => e.id),
    availableFactKeys: facts.map((f) => f.key),
    prohibitedClaims: claims.map((c) => ({
      pattern: c.pattern, reason: c.reason, isRegex: c.isRegex,
    })),
  });

  const riskFlags = [...validation.riskFlags];
  let needsReview = validation.needsManualReview;
  let reviewReason = validation.manualReviewReason;

  if (belowScore) {
    riskFlags.push("below_score_threshold");
    needsReview = true;
    reviewReason = [reviewReason, `Relevance score ${prospect.score} is below the configured drafting threshold of ${minScore}.`]
      .filter(Boolean).join(" ");
  }

  const recipientLogo = await approvedRecipientLogo(prospect.id);

  const render = {
    subject: completion.output.subject,
    previewText: completion.output.preview_text,
    salutation: completion.output.salutation,
    bodyHtml: sanitizeBodyHtml(completion.output.body_html),
    bodyText: completion.output.body_text,
    ctaLabel: completion.output.primary_cta_label,
    ctaUrl: completion.output.primary_cta_url,
    companyName: prospect.companyName,
    sender: {
      name: campaign.senderName,
      email: campaign.senderEmail,
      phone: campaign.senderPhone,
      website: null,
    },
    alamLogoUrl: ALAM_LOGO_URL(),
    agentLogoUrl: AGENT_LOGO_URL(),
    agentName: AGENT_NAME,
    heroImageUrl: HERO_IMAGE_URL(),
    heroAlt: HERO_ALT,
    recipientLogoUrl: recipientLogo?.url ?? null,
    propertyAddress: facts.find((f) => f.key === "location")?.value ?? "Fifth Street, Industrial Area, Kampala",
    unsubscribeUrl: `${appBaseUrl()}/opt-out`,
  };

  const bodyHtml = renderEmailHtml(render);
  const bodyText = renderEmailText(render);

  const hashable: HashableDraft = {
    subject: render.subject,
    previewText: render.previewText,
    salutation: render.salutation,
    bodyHtml,
    bodyText,
    ctaLabel: render.ctaLabel,
    ctaUrl: render.ctaUrl,
    recipientEmail: contact?.email ?? null,
    recipientLogoAssetId: recipientLogo?.id ?? null,
  };

  const threadId = randomUUID();
  const [draft] = await db.insert(emailDrafts).values({
    campaignId: campaign.id,
    prospectId: prospect.id,
    contactId: contact?.id ?? null,
    version: 1,
    threadId,
    subject: hashable.subject,
    previewText: hashable.previewText,
    salutation: hashable.salutation,
    bodyInnerHtml: render.bodyHtml,
    bodyHtml,
    bodyText,
    ctaLabel: hashable.ctaLabel,
    ctaUrl: hashable.ctaUrl,
    recipientEmail: hashable.recipientEmail,
    recipientLogoAssetId: hashable.recipientLogoAssetId,
    contentHash: computeContentHash(hashable),
    status: "draft",
    needsManualReview: needsReview,
    manualReviewReason: reviewReason,
    riskFlags,
    factsUsed: completion.output.facts_used,
    model: completion.model,
    promptVersion: PROMPT_VERSION,
    generationMeta: {
      usage: completion.usage,
      wordCount: validation.wordCount,
      issues: validation.issues,
      segment: classification.segment,
      floor: classification.floor,
    },
    createdBy: opts.actorId,
  }).returning();

  // Evidence rows make every personalized claim openable in the reviewer UI.
  for (const id of completion.output.evidence_ids) {
    const e = evidence.find((x) => x.id === id);
    if (!e) continue;
    await db.insert(draftEvidence).values({
      draftId: draft.id,
      claim: `${e.field}: used in personalization`,
      sourceDocumentId: prospect.sourceDocumentId,
      page: e.page,
      snippet: e.snippet,
      confidence: e.confidence,
    });
  }
  for (const key of completion.output.facts_used) {
    const fact = facts.find((f) => f.key === key);
    if (!fact) continue;
    await db.insert(draftEvidence).values({
      draftId: draft.id,
      claim: `Property fact: ${fact.label}`,
      propertyFactId: fact.id,
      snippet: fact.value,
      confidence: 100,
    });
  }

  await writeAudit({
    actorId: opts.actorId,
    actorLabel: opts.actorLabel,
    action: "draft.generated",
    entity: "email_draft",
    entityId: draft.id,
    afterHash: draft.contentHash,
    metadata: {
      model: completion.model,
      promptVersion: PROMPT_VERSION,
      needsManualReview: needsReview,
      riskFlags,
    },
  });

  return { draft, validation };
}

async function approvedRecipientLogo(prospectId: string) {
  const [asset] = await db.select().from(brandAssets)
    .where(and(
      eq(brandAssets.ownerType, "prospect"),
      eq(brandAssets.ownerId, prospectId),
      eq(brandAssets.approvalStatus, "approved"),
    )).limit(1);
  if (!asset) return null;
  // Served from the application's own controlled asset route, never hot-linked.
  return { id: asset.id, url: `${appBaseUrl()}/api/assets/${asset.id}` };
}

/**
 * Creates the next version of a draft from edited fields.
 *
 * The existing row is never mutated. That is what makes an approval safe to
 * trust: an approval points at a version and a hash, and both are immutable,
 * so an edit cannot retroactively change what somebody approved.
 */
export interface DraftEdits {
  subject?: string;
  previewText?: string | null;
  salutation?: string | null;
  /** The message body only. The branded layout is re-applied, not edited. */
  bodyInnerHtml?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  recipientEmail?: string | null;
}

export async function reviseDraft(opts: {
  draftId: string;
  changes: DraftEdits;
  actorId: string;
  actorLabel: string;
  reason?: string;
}) {
  const [current] = await db.select().from(emailDrafts)
    .where(eq(emailDrafts.id, opts.draftId)).limit(1);
  if (!current) throw new DraftError("Draft not found.");
  if (current.supersededById) {
    throw new DraftError("This version has already been superseded. Edit the latest version instead.");
  }

  assertUsableForEmail();

  const [campaign] = await db.select().from(campaigns)
    .where(eq(campaigns.id, current.campaignId)).limit(1);
  const [prospect] = await db.select().from(prospects)
    .where(eq(prospects.id, current.prospectId)).limit(1);
  const facts = await loadApprovedFacts();

  /*
   * An edit changes the words, never the layout. The stored body_html is the
   * complete rendered email, so editing it directly would let a reviewer
   * delete the header, the unsubscribe link or the sender block. Only the
   * inner body is editable; everything around it is re-applied here.
   */
  const innerHtml = sanitizeBodyHtml(
    opts.changes.bodyInnerHtml ?? current.bodyInnerHtml ?? current.bodyHtml,
  );

  const recipientEmail = opts.changes.recipientEmail ?? current.recipientEmail;
  const salutation = opts.changes.salutation ?? current.salutation;

  const render = {
    subject: opts.changes.subject ?? current.subject,
    previewText: opts.changes.previewText ?? current.previewText,
    salutation: salutation ?? "",
    bodyHtml: innerHtml,
    bodyText: htmlToPlainText(innerHtml),
    ctaLabel: opts.changes.ctaLabel ?? current.ctaLabel,
    ctaUrl: opts.changes.ctaUrl ?? current.ctaUrl,
    companyName: prospect?.companyName ?? "",
    sender: {
      name: campaign?.senderName ?? "",
      email: campaign?.senderEmail ?? "",
      phone: campaign?.senderPhone ?? null,
      website: null,
    },
    alamLogoUrl: ALAM_LOGO_URL(),
    agentLogoUrl: AGENT_LOGO_URL(),
    agentName: AGENT_NAME,
    heroImageUrl: HERO_IMAGE_URL(),
    heroAlt: HERO_ALT,
    recipientLogoUrl: current.recipientLogoAssetId
      ? `${appBaseUrl()}/api/assets/${current.recipientLogoAssetId}`
      : null,
    propertyAddress: facts.find((f) => f.key === "location")?.value
      ?? "Fifth Street, Industrial Area, Kampala",
    unsubscribeUrl: `${appBaseUrl()}/opt-out`,
  };

  const next: HashableDraft = {
    subject: render.subject,
    previewText: render.previewText,
    salutation,
    bodyHtml: renderEmailHtml(render),
    bodyText: renderEmailText(render),
    ctaLabel: render.ctaLabel,
    ctaUrl: render.ctaUrl,
    recipientEmail,
    recipientLogoAssetId: current.recipientLogoAssetId,
  };

  const contentHash = computeContentHash(next);
  if (contentHash === current.contentHash) {
    return { draft: current, unchanged: true as const };
  }

  const wasApproved = current.status === "approved";

  const [created] = await db.insert(emailDrafts).values({
    campaignId: current.campaignId,
    prospectId: current.prospectId,
    contactId: current.contactId,
    version: current.version + 1,
    threadId: current.threadId,
    subject: next.subject,
    previewText: next.previewText,
    salutation: next.salutation,
    bodyInnerHtml: innerHtml,
    bodyHtml: next.bodyHtml,
    bodyText: next.bodyText,
    ctaLabel: next.ctaLabel,
    ctaUrl: next.ctaUrl,
    recipientEmail: next.recipientEmail,
    recipientLogoAssetId: next.recipientLogoAssetId,
    contentHash,
    // Section 8: an edit always returns the message to an unapproved state.
    status: "draft",
    needsManualReview: current.needsManualReview,
    manualReviewReason: current.manualReviewReason,
    riskFlags: [...current.riskFlags, ...(wasApproved ? ["edited_after_approval"] : [])],
    factsUsed: current.factsUsed,
    model: current.model,
    promptVersion: current.promptVersion,
    generationMeta: { ...current.generationMeta, editedFrom: current.id },
    createdBy: opts.actorId,
  }).returning();

  await db.update(emailDrafts)
    .set({ supersededById: created.id })
    .where(eq(emailDrafts.id, current.id));

  await writeAudit({
    actorId: opts.actorId,
    actorLabel: opts.actorLabel,
    action: wasApproved ? "draft.edited_voiding_approval" : "draft.edited",
    entity: "email_draft",
    entityId: created.id,
    beforeHash: current.contentHash,
    afterHash: contentHash,
    reason: opts.reason ?? null,
    metadata: {
      previousVersion: current.version,
      newVersion: created.version,
      approvalVoided: wasApproved,
    },
  });

  return { draft: created, unchanged: false as const, approvalVoided: wasApproved };
}

/**
 * Turns edited body HTML into the plain-text alternative.
 *
 * Section 6.1 requires a complete plain-text version carrying the same facts,
 * so it is derived from the body on every edit rather than left to drift out
 * of step with the HTML a reviewer actually changed.
 */
export function htmlToPlainText(html: string): string {
  const NL = String.fromCharCode(10);
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, NL)
    .replace(/<\s*\/\s*(p|div|h[1-6]|li)\s*>/gi, NL + NL)
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    // Entities are decoded after tags are stripped: decoding first would turn
    // an encoded "&lt;p&gt;" into a tag the stripper has already run past.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, String.fromCharCode(34))
    .replace(/&#39;/gi, String.fromCharCode(39))
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, NL + NL)
    .trim();
}

/** Full version history for a draft thread, newest first. */
export async function draftHistory(threadId: string) {
  return db.select().from(emailDrafts)
    .where(eq(emailDrafts.threadId, threadId))
    .orderBy(desc(emailDrafts.version));
}

/** Approval and rejection records for a thread. */
export async function approvalHistory(threadId: string) {
  const versions = await db.select({ id: emailDrafts.id })
    .from(emailDrafts).where(eq(emailDrafts.threadId, threadId));
  if (!versions.length) return [];
  const ids = versions.map((v) => v.id);
  const rows = await db.select().from(approvals).orderBy(desc(approvals.createdAt));
  return rows.filter((r) => ids.includes(r.draftId));
}

