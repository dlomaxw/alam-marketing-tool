import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import {
  prospects, contacts, sourceDocuments, sourcePages,
} from "@/db/schema";
import { classifyProspect, scoreProspect, dedupeKey } from "@/lib/scoring";
import { writeAudit } from "@/lib/audit";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { extractPdfText } from "./pdf";
import { parseDocument, type ParsedRecord } from "./parse-uma";

export interface ImportSummary {
  pagesProcessed: number;
  recordsFound: number;
  prospectsCreated: number;
  duplicatesFlagged: number;
  needsDataReview: number;
  scannedPages: number[];
}

/**
 * Extracts a source document, parses it, and stores the result.
 *
 * Nothing is invented: a field the parser could not read is stored as null and
 * the prospect is routed to Needs Data Review. Page text is retained so every
 * personalized claim can be opened against its source snippet later.
 */
export async function importSourceDocument(opts: {
  sourceDocumentId: string;
  fileBytes: Uint8Array;
  actorId: string;
  actorLabel: string;
}): Promise<ImportSummary> {
  const { sourceDocumentId, fileBytes, actorId, actorLabel } = opts;

  await db.update(sourceDocuments)
    .set({ status: "extracting", error: null })
    .where(eq(sourceDocuments.id, sourceDocumentId));

  try {
    const extracted = await extractPdfText(fileBytes);

    // Persist page text first: if parsing later proves wrong, the evidence is
    // still there to re-parse against without re-reading the PDF.
    for (const page of extracted.pages) {
      await db.insert(sourcePages)
        .values({ sourceDocumentId, page: page.page, text: page.text })
        .onConflictDoUpdate({
          target: [sourcePages.sourceDocumentId, sourcePages.page],
          set: { text: page.text },
        });
    }

    const { records } = parseDocument(extracted.pages);
    const summary = await persistRecords(records, sourceDocumentId, actorId);

    await db.update(sourceDocuments).set({
      status: "extracted",
      pageCount: extracted.pageCount,
      processedAt: new Date(),
    }).where(eq(sourceDocuments.id, sourceDocumentId));

    await writeAudit({
      actorId, actorLabel,
      action: "source.extracted",
      entity: "source_document",
      entityId: sourceDocumentId,
      metadata: { ...summary },
    });

    return { ...summary, pagesProcessed: extracted.pageCount, scannedPages: extracted.scannedPageNumbers };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(sourceDocuments)
      .set({ status: "failed", error: message })
      .where(eq(sourceDocuments.id, sourceDocumentId));

    await writeAudit({
      actorId, actorLabel,
      action: "source.extract_failed",
      entity: "source_document",
      entityId: sourceDocumentId,
      metadata: { error: message },
    });
    throw err;
  }
}

async function persistRecords(
  records: ParsedRecord[],
  sourceDocumentId: string,
  actorId: string,
): Promise<Omit<ImportSummary, "pagesProcessed" | "scannedPages">> {
  const threshold = await getSetting<number>(SETTING_KEYS.contactConfidenceThreshold);

  let created = 0;
  let duplicates = 0;
  let needsReview = 0;

  for (const record of records) {
    const key = dedupeKey(record.companyName);
    if (!key) continue;

    const classification = classifyProspect({
      companyName: record.companyName,
      sector: record.brandName,
      productsServices: record.productsServices,
    });

    const primaryEmail = record.emails[0] ?? null;
    const score = scoreProspect({
      classification,
      contact: {
        fullName: record.contactName,
        designation: record.designation,
        email: primaryEmail,
        phone: record.phones[0] ?? null,
      },
      website: record.website,
      address: record.address,
      strategicRelationship: null,
    });

    // Section 5.1: a low-confidence email must be confirmed by a person
    // before anything is generated for it.
    const emailBelowThreshold =
      record.confidence.email < threshold || !primaryEmail;
    const status = emailBelowThreshold || classification.segment === "unclassified"
      ? "needs_data_review" as const
      : "imported" as const;
    if (status === "needs_data_review") needsReview++;

    const [existing] = await db.select({ id: prospects.id })
      .from(prospects).where(eq(prospects.dedupeKey, key)).limit(1);

    if (existing) {
      duplicates++;
      // Record the duplicate rather than merging: an automatic merge could
      // silently pick the wrong address or contact for an outbound email.
      await db.insert(prospects).values({
        companyName: record.companyName,
        sector: record.brandName,
        productsServices: record.productsServices,
        address: [record.address, record.poBox].filter(Boolean).join(", ") || null,
        website: record.website,
        sourceDocumentId,
        sourcePage: record.sourcePage,
        segment: classification.segment,
        suggestedFloor: classification.floor,
        score: score.total,
        scoreBreakdown: score.breakdown,
        rationale: score.rationale.join(" "),
        status: "needs_data_review",
        dedupeKey: key,
        duplicateOfId: existing.id,
        notes: `Possible duplicate of an existing prospect. ${record.warnings.join(" ")}`.trim(),
      });
      continue;
    }

    const [prospect] = await db.insert(prospects).values({
      companyName: record.companyName,
      sector: record.brandName,
      productsServices: record.productsServices,
      address: [record.address, record.poBox].filter(Boolean).join(", ") || null,
      website: record.website,
      sourceDocumentId,
      sourcePage: record.sourcePage,
      segment: classification.segment,
      suggestedFloor: classification.floor,
      score: score.total,
      scoreBreakdown: score.breakdown,
      rationale: score.rationale.join(" "),
      status,
      dedupeKey: key,
      notes: record.warnings.join(" ") || null,
      ownerId: actorId,
    }).returning({ id: prospects.id });

    created++;

    // Every address found becomes a contact row so a reviewer can pick the
    // right recipient rather than the system guessing.
    for (const [i, email] of record.emails.entries()) {
      await db.insert(contacts).values({
        prospectId: prospect.id,
        fullName: i === 0 ? record.contactName : null,
        designation: i === 0 ? record.designation : null,
        email,
        phone: record.phones[0] ?? null,
        confidence: i === 0 ? record.confidence.email : Math.max(record.confidence.email - 20, 0),
        isPrimary: i === 0,
        sourcePage: record.sourcePage,
      });
    }

    if (!record.emails.length && record.contactName) {
      await db.insert(contacts).values({
        prospectId: prospect.id,
        fullName: record.contactName,
        designation: record.designation,
        phone: record.phones[0] ?? null,
        confidence: 0,
        isPrimary: true,
        sourcePage: record.sourcePage,
      });
    }
  }

  return {
    recordsFound: records.length,
    prospectsCreated: created,
    duplicatesFlagged: duplicates,
    needsDataReview: needsReview,
  };
}

/** Evidence snippets for a prospect, used to ground and audit generation. */
export async function evidenceForProspect(prospectId: string): Promise<{
  id: string; field: string; snippet: string; page: number | null; confidence: number;
}[]> {
  const [prospect] = await db.select().from(prospects)
    .where(eq(prospects.id, prospectId)).limit(1);
  if (!prospect) return [];

  const [contact] = await db.select().from(contacts)
    .where(and(eq(contacts.prospectId, prospectId), eq(contacts.isPrimary, true)))
    .limit(1);

  const out: { id: string; field: string; snippet: string; page: number | null; confidence: number }[] = [];

  if (prospect.productsServices) {
    out.push({
      id: "ev_products",
      field: "products_services",
      snippet: prospect.productsServices,
      page: prospect.sourcePage,
      confidence: 90,
    });
  }
  if (prospect.sector) {
    out.push({
      id: "ev_sector",
      field: "sector",
      snippet: prospect.sector,
      page: prospect.sourcePage,
      confidence: 80,
    });
  }
  if (prospect.address) {
    out.push({
      id: "ev_address",
      field: "address",
      snippet: prospect.address,
      page: prospect.sourcePage,
      confidence: 85,
    });
  }
  if (contact?.fullName) {
    out.push({
      id: "ev_contact",
      field: "contact",
      snippet: [contact.fullName, contact.designation].filter(Boolean).join(", "),
      page: contact.sourcePage,
      confidence: contact.confidence,
    });
  }

  return out;
}
