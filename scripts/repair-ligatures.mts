/**
 * Repairs ligature corruption in already-imported records.
 *
 * The extractor's ligature map was incomplete on the first import, so text
 * reached the database with glyphs standing in for real letters -- "FiŌh
 * Street", "oĸce", "Ňoor". Re-importing the whole directory would fix it, but
 * that would also discard the review decisions people have made against these
 * rows, so the repair is applied in place to the affected columns only.
 *
 * Read-modify-write per row, reporting what changed. Draft content is not
 * touched: it is immutable and hashed, so a corrupted draft has to be
 * regenerated rather than patched.
 */
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db/index";
import { prospects, contacts, sourcePages } from "../src/db/schema";
import { repairLigatures } from "../src/lib/ingestion/pdf";

const apply = process.argv.includes("--apply");
if (!apply) {
  console.log("DRY RUN — pass --apply to write changes.\n");
}

let prospectsChanged = 0;
let contactsChanged = 0;
let pagesChanged = 0;
const examples: string[] = [];

/* ---------------------------------------------------------- prospects */

const allProspects = await db.select().from(prospects);
for (const p of allProspects) {
  const next = {
    companyName: repairLigatures(p.companyName),
    sector: p.sector ? repairLigatures(p.sector) : p.sector,
    productsServices: p.productsServices ? repairLigatures(p.productsServices) : p.productsServices,
    address: p.address ? repairLigatures(p.address) : p.address,
    rationale: p.rationale ? repairLigatures(p.rationale) : p.rationale,
    notes: p.notes ? repairLigatures(p.notes) : p.notes,
  };

  const changed =
    next.companyName !== p.companyName ||
    next.sector !== p.sector ||
    next.productsServices !== p.productsServices ||
    next.address !== p.address ||
    next.rationale !== p.rationale ||
    next.notes !== p.notes;

  if (!changed) continue;
  prospectsChanged++;

  if (examples.length < 8) {
    const before = p.companyName !== next.companyName ? p.companyName
      : (p.address !== next.address ? p.address : p.productsServices) ?? "";
    const after = p.companyName !== next.companyName ? next.companyName
      : (p.address !== next.address ? next.address : next.productsServices) ?? "";
    examples.push(`  ${String(before).slice(0, 60)}\n    -> ${String(after).slice(0, 60)}`);
  }

  if (apply) await db.update(prospects).set(next).where(eq(prospects.id, p.id));
}

/* ----------------------------------------------------------- contacts */

const allContacts = await db.select().from(contacts);
for (const c of allContacts) {
  const next = {
    fullName: c.fullName ? repairLigatures(c.fullName) : c.fullName,
    designation: c.designation ? repairLigatures(c.designation) : c.designation,
    // Email is repaired too: a ligature in an address is a hard bounce.
    email: c.email ? repairLigatures(c.email) : c.email,
  };
  const changed =
    next.fullName !== c.fullName ||
    next.designation !== c.designation ||
    next.email !== c.email;

  if (!changed) continue;
  contactsChanged++;
  if (next.email !== c.email) {
    console.log(`  email: ${c.email} -> ${next.email}`);
  }
  if (apply) await db.update(contacts).set(next).where(eq(contacts.id, c.id));
}

/* -------------------------------------------------------- source text */

const pages = await db.select().from(sourcePages);
for (const page of pages) {
  const repaired = repairLigatures(page.text);
  if (repaired === page.text) continue;
  pagesChanged++;
  if (apply) {
    await db.update(sourcePages).set({ text: repaired }).where(sql`
      ${sourcePages.sourceDocumentId} = ${page.sourceDocumentId}
      AND ${sourcePages.page} = ${page.page}`);
  }
}

console.log("\nexamples:");
console.log(examples.join("\n"));
console.log(`\nprospects affected : ${prospectsChanged} of ${allProspects.length}`);
console.log(`contacts affected  : ${contactsChanged} of ${allContacts.length}`);
console.log(`source pages       : ${pagesChanged} of ${pages.length}`);
console.log(apply ? "\nWritten." : "\nDry run only. Re-run with --apply.");

await pool.end();
