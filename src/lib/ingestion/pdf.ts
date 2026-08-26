/**
 * PDF text extraction.
 *
 * pdfjs-dist rather than a convenience wrapper: the UMA directory is a
 * two-column layout, and only the per-item coordinates make it possible to
 * separate the columns. Naive extraction interleaves them, which splices one
 * company's contact details into another company's description — exactly the
 * kind of silent corruption that would put an unverifiable claim in front of a
 * reviewer looking correct.
 */

export interface ExtractedPage {
  page: number;
  text: string;
  /** True when the page yielded almost no text, i.e. it is likely a scan. */
  likelyScanned: boolean;
  columnCount: number;
}

export interface ExtractResult {
  pageCount: number;
  pages: ExtractedPage[];
  scannedPageNumbers: number[];
}

interface TextItemLike {
  str: string;
  transform: number[];
  width?: number;
}

interface Positioned { x: number; y: number; w: number; str: string }

/** Y positions within this many units are treated as the same visual line. */
const LINE_TOLERANCE = 3;
const SCANNED_TEXT_THRESHOLD = 40;
/** Left edges within this distance belong to the same column. */
const LEFT_EDGE_TOLERANCE = 12;
/** A column must hold at least this share of the page's text items. */
const MIN_COLUMN_SHARE = 0.12;
/** Columns closer together than this share of page width are not columns. */
const MIN_COLUMN_SEPARATION = 0.18;

/**
 * The directory's embedded subset fonts map some ligatures to codepoints in
 * the Latin Extended-B range, so extraction yields "automaƟon" for
 * "automation". Left unrepaired these corrupt company names, email addresses
 * and the products/services text the personalization is grounded in.
 */
const LIGATURES: [RegExp, string][] = [
  [/Ŧ|ŧ|ǀ|Ɵ/g, "ti"],
  [/Į/g, "fi"],
  [/Ʃ/g, "tt"],
  [/ƞ/g, "tf"],   // "plaƞorm" -> "platform"
  [/Ț/g, "ffi"],  // "eȚciency" -> "efficiency"
  [/ī|Ī/g, "ff"], // "Cliī" -> "Cliff"
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/ﬅ|ﬆ/g, "st"],
  [/’/g, "'"],
  [/‘/g, "'"],
  [/“|”/g, '"'],
  [/–|—/g, "-"],
  [/ /g, " "],
];

export function repairLigatures(s: string): string {
  let out = s;
  for (const [re, rep] of LIGATURES) out = out.replace(re, rep);
  return out;
}

/**
 * Finds column start positions by clustering item left edges.
 *
 * Looking for an empty vertical gutter does not work on this document: the
 * horizontal rules that separate entries span the full page width, so there is
 * no band the text never crosses. The left edges, though, cluster hard — a
 * two-column listing page puts roughly half its items at each column's margin.
 * Returns ascending x positions, or an empty array for a single-column page.
 */
function detectColumnStarts(items: Positioned[], pageWidth: number): number[] {
  if (items.length < 20) return [];

  const hist = new Map<number, number>();
  for (const it of items) {
    const key = Math.round(it.x / LEFT_EDGE_TOLERANCE) * LEFT_EDGE_TOLERANCE;
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }

  const minCount = items.length * MIN_COLUMN_SHARE;
  const candidates = [...hist.entries()]
    .filter(([, n]) => n >= minCount)
    .map(([x]) => x)
    .sort((a, b) => a - b);

  // Keep only candidates far enough apart to be genuine columns rather than
  // an indented run inside one column.
  const minGap = pageWidth * MIN_COLUMN_SEPARATION;
  const starts: number[] = [];
  for (const x of candidates) {
    if (!starts.length || x - starts[starts.length - 1] >= minGap) starts.push(x);
  }

  return starts.length >= 2 ? starts : [];
}

/** Groups items on one baseline into a line, left to right. */
function linesFrom(items: Positioned[]): string[] {
  const lines = new Map<number, Positioned[]>();
  for (const it of items) {
    const key = Math.round(it.y / LINE_TOLERANCE) * LINE_TOLERANCE;
    const bucket = lines.get(key) ?? [];
    bucket.push(it);
    lines.set(key, bucket);
  }

  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF y grows upward; top of page first
    .map(([, bucket]) =>
      bucket.sort((a, b) => a.x - b.x)
        .map((i) => i.str).join(" ")
        .replace(/\s+/g, " ").trim(),
    )
    .filter(Boolean);
}

function itemsToText(rawItems: TextItemLike[], pageWidth: number): {
  text: string; columnCount: number;
} {
  const items: Positioned[] = rawItems
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({
      x: i.transform[4],
      y: i.transform[5],
      w: i.width ?? i.str.length * 4,
      str: repairLigatures(i.str),
    }));

  if (!items.length) return { text: "", columnCount: 0 };

  const starts = detectColumnStarts(items, pageWidth);
  if (!starts.length) {
    return { text: linesFrom(items).join("\n"), columnCount: 1 };
  }

  // Assign by left edge, not centre: a full-width separator rule starts in the
  // first column and belongs there, whereas its centre would place it in the
  // second and break that column's entry boundaries.
  const columns: Positioned[][] = starts.map(() => []);
  for (const it of items) {
    let idx = 0;
    for (let c = 0; c < starts.length; c++) {
      if (it.x + LEFT_EDGE_TOLERANCE >= starts[c]) idx = c;
    }
    columns[idx].push(it);
  }

  const text = columns
    .filter((c) => c.length)
    .map((c) => linesFrom(c).join("\n"))
    .join("\n");

  return { text, columnCount: columns.filter((c) => c.length).length };
}

export async function extractPdfText(data: Uint8Array): Promise<ExtractResult> {
  // Legacy build: the modern build assumes browser globals that do not exist
  // in the Node server runtime.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;

  const pages: ExtractedPage[] = [];
  const scanned: number[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const { text, columnCount } = itemsToText(
          content.items as unknown as TextItemLike[],
          viewport.width,
        );
        const likelyScanned = text.replace(/\s/g, "").length < SCANNED_TEXT_THRESHOLD;
        if (likelyScanned) scanned.push(n);
        pages.push({ page: n, text, likelyScanned, columnCount });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    // Destroying the loading task releases the worker; the document object
    // itself has no destroy() in this build.
    await loadingTask.destroy();
  }

  return { pageCount: doc.numPages, pages, scannedPageNumbers: scanned };
}
