/**
 * Loads the whole UMA directory into the application database.
 *
 * Batched, because 1,700+ single-row round trips to a hosted Postgres is slow
 * enough to look like a hang. Idempotent: re-running skips companies already
 * present by dedupe key rather than creating a second copy.
 *
 * Import only. No draft is generated and nothing is queued or sent.
 */
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/index";
import {
  users, sourceDocuments, sourcePages, prospects, contacts,
} from "../src/db/schema";
import { extractPdfText } from "../src/lib/ingestion/pdf";
import { parseDocument } from "../src/lib/ingestion/parse-uma";
import { classifyProspect, scoreProspect, dedupeKey } from "../src/lib/scoring";
import { checksumBuffer } from "../src/lib/content-hash";
import { writeAudit } from "../src/lib/audit";

const PDF = process.argv[2] ?? "source-documents/UMA-Dirrectory-2026.pdf";
const CHUNK = 200;
/** Below this, an extracted address must be confirmed before it is used. */
const CONFIDENCE_THRESHOLD = 70;

const [admin] = await db.select().from(users).limit(1);
if (!admin) throw new Error("No user found. Run npm run db:seed first.");

console.log(`Importing ${PDF} as ${admin.email}\n`);

const bytes = new Uint8Array(await readFile(PDF));
const checksum = checksumBuffer(bytes);

let [doc] = await db.select().from(sourceDocuments)
  .where(eq(sourceDocuments.checksum, checksum)).limit(1);

const extracted = await extractPdfText(bytes);
console.log(`extracted ${extracted.pageCount} pages`);

if (!doc) {
  [doc] = await db.insert(sourceDocuments).values({
    filename: PDF.split(/[\\/]/).pop()!,
    storageKey: `sources/${checksum.slice(0, 16)}/${PDF.split(/[\\/]/).pop()}`,
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    checksum,
    uploadedBy: admin.id,
    status: "extracting",
  }).returning();
}

// Page text underpins every evidence link, so it is stored before parsing.
for (let i = 0; i < extracted.pages.length; i += CHUNK) {
  const slice = extracted.pages.slice(i, i + CHUNK);
  await db.insert(sourcePages)
    .values(slice.map((p) => ({
      sourceDocumentId: doc.id, page: p.page, text: p.text,
    })))
    .onConflictDoUpdate({
      target: [sourcePages.sourceDocumentId, sourcePages.page],
      set: { text: sql`excluded.text` },
    });
}
console.log(`stored page text for ${extracted.pages.length} pages`);

const { records } = parseDocument(extracted.pages);
console.log(`parsed ${records.length} entries\n`);

const existing = new Set(
  (await db.select({ k: prospects.dedupeKey }).from(prospects)).map((r) => r.k),
);

type ProspectInsert = typeof prospects.$inferInsert;
const pending: { row: ProspectInsert; record: (typeof records)[number] }[] = [];
let skippedExisting = 0;
let needsReview = 0;

for (const r of records) {
  const key = dedupeKey(r.companyName);
  if (!key) continue;
  if (existing.has(key)) { skippedExisting++; continue; }
  existing.add(key);

  const classification = classifyProspect({
    companyName: r.companyName,
    sector: r.brandName,
    productsServices: r.productsServices,
  });
  const score = scoreProspect({
    classification,
    contact: {
      fullName: r.contactName, designation: r.designation,
      email: r.emails[0] ?? null, phone: r.phones[0] ?? null,
    },
    website: r.website, address: r.address, strategicRelationship: null,
  });

  const lowConfidence = !r.emails.length || r.confidence.email < CONFIDENCE_THRESHOLD;
  const status = lowConfidence || classification.segment === "unclassified"
    ? "needs_data_review" as const
    : "imported" as const;
  if (status === "needs_data_review") needsReview++;

  pending.push({
    record: r,
    row: {
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
      status,
      dedupeKey: key,
      ownerId: admin.id,
      notes: r.warnings.join(" ") || null,
    },
  });
}

let created = 0;
for (let i = 0; i < pending.length; i += CHUNK) {
  const slice = pending.slice(i, i + CHUNK);
  const inserted = await db.insert(prospects)
    .values(slice.map((s) => s.row))
    .returning({ id: prospects.id, key: prospects.dedupeKey });

  const byKey = new Map(inserted.map((p) => [p.key, p.id]));
  type ContactInsert = typeof contacts.$inferInsert;
  const contactRows: ContactInsert[] = [];

  for (const { row, record } of slice) {
    const prospectId = byKey.get(row.dedupeKey);
    if (!prospectId) continue;

    // Every address found becomes a row so a reviewer picks the recipient
    // rather than the system guessing which one is right.
    record.emails.forEach((email, n) => {
      contactRows.push({
        prospectId,
        fullName: n === 0 ? record.contactName : null,
        designation: n === 0 ? record.designation : null,
        email,
        phone: record.phones[0] ?? null,
        confidence: n === 0
          ? record.confidence.email
          : Math.max(record.confidence.email - 20, 0),
        isPrimary: n === 0,
        sourcePage: record.sourcePage,
      });
    });

    if (!record.emails.length && record.contactName) {
      contactRows.push({
        prospectId,
        fullName: record.contactName,
        designation: record.designation,
        phone: record.phones[0] ?? null,
        confidence: 0,
        isPrimary: true,
        sourcePage: record.sourcePage,
      });
    }
  }

  if (contactRows.length) {
    for (let c = 0; c < contactRows.length; c += CHUNK) {
      await db.insert(contacts).values(contactRows.slice(c, c + CHUNK));
    }
  }

  created += inserted.length;
  process.stdout.write(`\r  inserted ${created}/${pending.length}`);
}
process.stdout.write("\n");

await db.update(sourceDocuments).set({
  status: "extracted",
  pageCount: extracted.pageCount,
  processedAt: new Date(),
}).where(eq(sourceDocuments.id, doc.id));

await writeAudit({
  actorId: admin.id,
  actorLabel: admin.email,
  action: "source.extracted",
  entity: "source_document",
  entityId: doc.id,
  metadata: {
    pages: extracted.pageCount,
    recordsFound: records.length,
    prospectsCreated: created,
    alreadyPresent: skippedExisting,
    needsDataReview: needsReview,
  },
});

const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(prospects);
const [{ totalContacts }] = await db
  .select({ totalContacts: sql<number>`count(*)::int` }).from(contacts);

console.log(`\ncreated              ${created}`);
console.log(`already present      ${skippedExisting}`);
console.log(`needs data review    ${needsReview}`);
console.log(`prospects in database ${total}`);
console.log(`contacts in database  ${totalContacts}`);
console.log("\nNothing was generated, queued or sent.");

await pool.end();
