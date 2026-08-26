/** Diagnostic: horizontal coverage profile for one page. */
import { readFile } from "node:fs/promises";

const [, , file, pageArg] = process.argv;
const pageNo = Number(pageArg ?? 199);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const buf = await readFile(file);
const task = pdfjs.getDocument({
  data: new Uint8Array(buf),
  useSystemFonts: false,
  disableFontFace: true,
});
const doc = await task.promise;
const page = await doc.getPage(pageNo);
const viewport = page.getViewport({ scale: 1 });
const content = await page.getTextContent();

const items = (content.items as { str: string; transform: number[]; width?: number }[])
  .filter((i) => i.str && i.str.trim());

console.log("page width:", viewport.width, "height:", viewport.height);
console.log("items:", items.length);

const BUCKET = 4;
const buckets = Math.ceil(viewport.width / BUCKET);
const covered = new Uint32Array(buckets);
for (const it of items) {
  const w = it.width ?? it.str.length * 4;
  const from = Math.max(0, Math.floor(it.transform[4] / BUCKET));
  const to = Math.min(buckets - 1, Math.floor((it.transform[4] + w) / BUCKET));
  for (let b = from; b <= to; b++) covered[b]++;
}

let profile = "";
for (let b = 0; b < buckets; b++) {
  profile += covered[b] === 0 ? "." : covered[b] < 5 ? "-" : covered[b] < 20 ? "+" : "#";
}
console.log("\ncoverage (each char = 4pt):");
console.log(profile);

// Widest interior zero-run
let best = { start: -1, len: 0 };
let run = -1;
for (let b = 0; b < buckets; b++) {
  if (covered[b] === 0) { if (run === -1) run = b; }
  else if (run !== -1) {
    if (b - run > best.len) best = { start: run, len: b - run };
    run = -1;
  }
}
console.log(`widest interior gap: ${best.len * BUCKET}pt at x=${best.start * BUCKET}`);

// Left-edge clustering
const lefts = items.map((i) => Math.round(i.transform[4]));
const hist = new Map<number, number>();
for (const l of lefts) {
  const k = Math.round(l / 10) * 10;
  hist.set(k, (hist.get(k) ?? 0) + 1);
}
console.log("\ntop left-edge clusters:",
  [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([x, n]) => `x=${x}(${n})`).join(" "));

await task.destroy();
