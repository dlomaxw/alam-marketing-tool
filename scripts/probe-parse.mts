/** Runs the full extract + parse pipeline over the real directory. */
import { readFile, writeFile } from "node:fs/promises";
import { extractPdfText } from "../src/lib/ingestion/pdf";
import { parseDocument } from "../src/lib/ingestion/parse-uma";
import { classifyProspect, scoreProspect, dedupeKey } from "../src/lib/scoring";

const file = process.argv[2];
const buf = await readFile(file);
const extracted = await extractPdfText(new Uint8Array(buf));
const { records, skippedBlocks } = parseDocument(extracted.pages);

console.log(`pages:            ${extracted.pageCount}`);
console.log(`records parsed:   ${records.length}`);
console.log(`blocks skipped:   ${skippedBlocks}`);
console.log(`with email:       ${records.filter((r) => r.emails.length).length}`);
console.log(`with contact:     ${records.filter((r) => r.contactName).length}`);
console.log(`with products:    ${records.filter((r) => r.productsServices).length}`);
console.log(`with website:     ${records.filter((r) => r.website).length}`);

const dupes = new Map<string, number>();
for (const r of records) {
  const k = dedupeKey(r.companyName);
  dupes.set(k, (dupes.get(k) ?? 0) + 1);
}
console.log(`duplicate keys:   ${[...dupes.values()].filter((n) => n > 1).length}`);

const conf = records.map((r) => r.confidence.overall).sort((a, b) => a - b);
const pct = (p: number) => conf[Math.floor(conf.length * p)] ?? 0;
console.log(`confidence p10/p50/p90: ${pct(0.1)} / ${pct(0.5)} / ${pct(0.9)}`);

// Segment distribution
const segs = new Map<string, number>();
for (const r of records) {
  const c = classifyProspect({
    companyName: r.companyName,
    sector: r.brandName,
    productsServices: r.productsServices,
  });
  segs.set(c.segment, (segs.get(c.segment) ?? 0) + 1);
}
console.log("\nsegments:");
for (const [s, n] of [...segs.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(24)} ${n}`);
}

// Score bands for classified prospects
const bands = new Map<string, number>();
for (const r of records) {
  const classification = classifyProspect({
    companyName: r.companyName,
    sector: r.brandName,
    productsServices: r.productsServices,
  });
  const s = scoreProspect({
    classification,
    contact: {
      fullName: r.contactName,
      designation: r.designation,
      email: r.emails[0] ?? null,
      phone: r.phones[0] ?? null,
    },
    website: r.website,
    address: r.address,
    strategicRelationship: null,
  });
  bands.set(s.band, (bands.get(s.band) ?? 0) + 1);
}
console.log("\nscore bands:");
for (const [b, n] of [...bands.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${b.padEnd(12)} ${n}`);
}

console.log("\n──── sample records ────");
for (const r of records.filter((x) => x.emails.length && x.productsServices).slice(0, 6)) {
  console.log(`\n[p${r.sourcePage}] ${r.companyName}   (confidence ${r.confidence.overall})`);
  console.log(`  address:  ${r.address ?? "-"}`);
  console.log(`  email:    ${r.emails.join(", ")}`);
  console.log(`  phone:    ${r.phones.join(", ") || "-"}`);
  console.log(`  contact:  ${r.contactName ?? "-"} / ${r.designation ?? "-"}`);
  console.log(`  website:  ${r.website ?? "-"}`);
  console.log(`  products: ${(r.productsServices ?? "-").slice(0, 130)}`);
  if (r.warnings.length) console.log(`  warnings: ${r.warnings.join(" | ")}`);
}

await writeFile(
  "scripts/.parsed-sample.json",
  JSON.stringify(records.slice(0, 60), null, 2),
);
console.log("\nwrote scripts/.parsed-sample.json");
