/**
 * Checks the ten example prospects named in section 12 of the specification
 * against what the pipeline actually extracts, and reports the segment and
 * floor each one would be pitched. Section 12 says these are starting points
 * to be verified, not authorization to contact — this is that verification.
 */
import { readFile } from "node:fs/promises";
import { extractPdfText } from "../src/lib/ingestion/pdf";
import { parseDocument } from "../src/lib/ingestion/parse-uma";
import { classifyProspect, scoreProspect } from "../src/lib/scoring";

const TARGETS = [
  "AutoXpress", "Double Q", "Motorcare", "Spear Motors", "Nish Auto",
  "Furniture City", "Elshrif", "Ezone", "Diamond Trust", "DFCU",
];

const buf = await readFile(process.argv[2]);
const extracted = await extractPdfText(new Uint8Array(buf));
const { records } = parseDocument(extracted.pages);

for (const target of TARGETS) {
  const hit = records.find((r) =>
    r.companyName.toLowerCase().includes(target.toLowerCase()));

  if (!hit) {
    console.log(`\n✗ ${target}: NOT FOUND in the extracted directory`);
    continue;
  }

  const classification = classifyProspect({
    companyName: hit.companyName,
    sector: hit.brandName,
    productsServices: hit.productsServices,
  });
  const score = scoreProspect({
    classification,
    contact: {
      fullName: hit.contactName,
      designation: hit.designation,
      email: hit.emails[0] ?? null,
      phone: hit.phones[0] ?? null,
    },
    website: hit.website,
    address: hit.address,
    strategicRelationship: null,
  });

  console.log(`\n✓ ${hit.companyName}  [page ${hit.sourcePage}]`);
  console.log(`   segment:  ${classification.segment} -> ${classification.floor} floor`);
  console.log(`   score:    ${score.total} (${score.band}) — ${score.action}`);
  console.log(`   email:    ${hit.emails[0] ?? "NONE"}`);
  console.log(`   contact:  ${hit.contactName ?? "-"} / ${hit.designation ?? "-"}`);
  console.log(`   products: ${(hit.productsServices ?? "-").slice(0, 100)}`);
}
