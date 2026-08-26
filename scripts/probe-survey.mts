/** Survey: how much text each page yields, so we can find the listing pages. */
import { readFile } from "node:fs/promises";
import { extractPdfText } from "../src/lib/ingestion/pdf";

const file = process.argv[2];
const buf = await readFile(file);
const r = await extractPdfText(new Uint8Array(buf));

const lens = r.pages.map((p) => ({
  page: p.page,
  chars: p.text.replace(/\s/g, "").length,
}));

const sorted = [...lens].sort((a, b) => b.chars - a.chars);
console.log("pages:", r.pageCount);
console.log("total chars:", lens.reduce((s, l) => s + l.chars, 0));
console.log("\nrichest pages:", sorted.slice(0, 15).map((l) => `${l.page}(${l.chars})`).join(" "));
console.log("emptiest pages:", sorted.slice(-15).map((l) => `${l.page}(${l.chars})`).join(" "));

const buckets = { "0-100": 0, "100-500": 0, "500-1500": 0, "1500+": 0 };
for (const l of lens) {
  if (l.chars < 100) buckets["0-100"]++;
  else if (l.chars < 500) buckets["100-500"]++;
  else if (l.chars < 1500) buckets["500-1500"]++;
  else buckets["1500+"]++;
}
console.log("\ndistribution:", buckets);
