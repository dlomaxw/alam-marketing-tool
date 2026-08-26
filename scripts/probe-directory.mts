/**
 * Development probe: dumps what the extractor actually gets out of the UMA
 * directory, so the parser is written against real page text rather than an
 * assumption about it. Not part of the application.
 *
 *   npx tsx scripts/probe-directory.ts "source-documents/UMA-Dirrectory-2026.pdf" 40 46
 */
import { readFile } from "node:fs/promises";
import { extractPdfText } from "../src/lib/ingestion/pdf";

const [, , file, fromArg, toArg] = process.argv;
const from = Number(fromArg ?? 1);
const to = Number(toArg ?? from + 3);

const buf = await readFile(file);
const result = await extractPdfText(new Uint8Array(buf));

console.log(`pages: ${result.pageCount}`);
console.log(`likely scanned: ${result.scannedPageNumbers.length} pages`);
if (result.scannedPageNumbers.length) {
  console.log(`  e.g. ${result.scannedPageNumbers.slice(0, 20).join(", ")}`);
}

for (const p of result.pages.filter((p) => p.page >= from && p.page <= to)) {
  console.log(`\n================ PAGE ${p.page} ================`);
  console.log(p.text.slice(0, 2600));
}
