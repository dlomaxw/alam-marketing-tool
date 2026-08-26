/**
 * End-to-end dry run against the real directory.
 *
 * Imports a slice of the UMA PDF, approves the property facts as the seeded
 * administrator, generates drafts for the section 12 example companies, and
 * writes the rendered HTML out for visual inspection.
 *
 * Nothing here sends anything: the global send switch stays off and no send
 * job is created.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { eq, and, isNull } from "drizzle-orm";
import { db, pool } from "../src/db/index";
import {
  users, propertyFacts, sourceDocuments, sourcePages, prospects, contacts, campaigns,
} from "../src/db/schema";
import { extractPdfText } from "../src/lib/ingestion/pdf";
import { parseDocument } from "../src/lib/ingestion/parse-uma";
import { classifyProspect, scoreProspect, dedupeKey } from "../src/lib/scoring";
import { generateDraft } from "../src/lib/drafts";
import { checksumBuffer } from "../src/lib/content-hash";

const PDF = "source-documents/UMA-Dirrectory-2026.pdf";
/** Pages holding the section 12 examples. */
const PAGES = new Set([44, 182, 210, 211, 220, 240]);
const TARGETS = ["AUTOXPRESS", "FURNITURE CITY", "EZONE", "DFCU", "SPEAR MOTORS"];

const [admin] = await db.select().from(users).limit(1);
if (!admin) throw new Error("No user. Run npm run db:seed first.");
console.log(`acting as ${admin.email}\n`);

/* 1 ─ approve the property facts, as an administrator would in Settings */
const facts = await db.select().from(propertyFacts)
  .where(isNull(propertyFacts.supersededAt));
let approved = 0;
for (const f of facts) {
  if (f.approvedAt) continue;
  await db.update(propertyFacts)
    .set({ approvedBy: admin.id, approvedAt: new Date() })
    .where(eq(propertyFacts.id, f.id));
  approved++;
}
console.log(`property facts approved: ${approved} (total ${facts.length})`);

/* 2 ─ import a slice of the directory */
const bytes = new Uint8Array(await readFile(PDF));
const checksum = checksumBuffer(bytes);

let [doc] = await db.select().from(sourceDocuments)
  .where(eq(sourceDocuments.checksum, checksum)).limit(1);

if (!doc) {
  [doc] = await db.insert(sourceDocuments).values({
    filename: "UMA-Dirrectory-2026.pdf",
    storageKey: `sources/${checksum.slice(0, 16)}/UMA-Dirrectory-2026.pdf`,
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    checksum,
    uploadedBy: admin.id,
    status: "extracted",
    processedAt: new Date(),
  }).returning();
}

const extracted = await extractPdfText(bytes);
const slice = extracted.pages.filter((p) => PAGES.has(p.page));
for (const p of slice) {
  await db.insert(sourcePages)
    .values({ sourceDocumentId: doc.id, page: p.page, text: p.text })
    .onConflictDoUpdate({
      target: [sourcePages.sourceDocumentId, sourcePages.page],
      set: { text: p.text },
    });
}

const { records } = parseDocument(slice);
console.log(`parsed ${records.length} records from ${slice.length} pages`);

let created = 0;
for (const r of records) {
  const key = dedupeKey(r.companyName);
  if (!key) continue;
  const [existing] = await db.select().from(prospects)
    .where(eq(prospects.dedupeKey, key)).limit(1);
  if (existing) continue;

  const classification = classifyProspect({
    companyName: r.companyName, sector: r.brandName, productsServices: r.productsServices,
  });
  const score = scoreProspect({
    classification,
    contact: {
      fullName: r.contactName, designation: r.designation,
      email: r.emails[0] ?? null, phone: r.phones[0] ?? null,
    },
    website: r.website, address: r.address, strategicRelationship: null,
  });

  const [p] = await db.insert(prospects).values({
    companyName: r.companyName,
    sector: r.brandName,
    productsServices: r.productsServices,
    address: [r.address, r.poBox].filter(Boolean).join(", ") || null,
    website: r.website,
    sourceDocumentId: doc.id,
    sourcePage: r.sourcePage,
    segment: classification.segment,
    suggestedFloor: classification.floor,
    score: score.total,
    scoreBreakdown: score.breakdown,
    rationale: score.rationale.join(" "),
    status: r.emails.length ? "imported" : "needs_data_review",
    dedupeKey: key,
    ownerId: admin.id,
    notes: r.warnings.join(" ") || null,
  }).returning();
  created++;

  for (const [i, email] of r.emails.entries()) {
    await db.insert(contacts).values({
      prospectId: p.id,
      fullName: i === 0 ? r.contactName : null,
      designation: i === 0 ? r.designation : null,
      email,
      phone: r.phones[0] ?? null,
      confidence: i === 0 ? r.confidence.email : Math.max(r.confidence.email - 20, 0),
      isPrimary: i === 0,
      sourcePage: r.sourcePage,
    });
  }
}
console.log(`prospects created: ${created}`);

/* 3 ─ generate drafts for the example companies */
const [campaign] = await db.select().from(campaigns).limit(1);
if (!campaign) throw new Error("No campaign. Run npm run db:seed first.");

await mkdir("scripts/.preview", { recursive: true });
const all = await db.select().from(prospects);

for (const target of TARGETS) {
  const p = all.find((x) => x.companyName.toUpperCase().includes(target));
  if (!p) { console.log(`\n✗ ${target}: not in the imported slice`); continue; }

  try {
    const { draft, validation } = await generateDraft({
      campaignId: campaign.id,
      prospectId: p.id,
      actorId: admin.id,
      actorLabel: admin.email,
    });

    const file = `scripts/.preview/${target.toLowerCase().replace(/\s+/g, "-")}.html`;
    await writeFile(file, draft.bodyHtml);

    console.log(`\n✓ ${p.companyName}  [${p.segment} → ${p.suggestedFloor}]`);
    console.log(`   subject:  ${draft.subject}`);
    console.log(`   to:       ${draft.recipientEmail}`);
    console.log(`   greeting: ${draft.salutation}`);
    console.log(`   words:    ${validation.wordCount}`);
    console.log(`   review:   ${draft.needsManualReview ? "REQUIRED" : "not required"}`);
    console.log(`   flags:    ${draft.riskFlags.join(", ") || "none"}`);
    console.log(`   hash:     ${draft.contentHash.slice(0, 16)}…`);
    console.log(`   status:   ${draft.status}  (never auto-queued)`);
    console.log(`   preview:  ${file}`);
  } catch (err) {
    console.log(`\n✗ ${p.companyName}: ${(err as Error).message}`);
  }
}

await pool.end();
