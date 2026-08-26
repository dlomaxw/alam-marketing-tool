/**
 * Parser for the UMA Business Directory listing format.
 *
 * Every field carries a confidence score and the page it came from. Section
 * 5.1 is explicit that the system must never invent missing details, so this
 * module only ever reports what it found: a field it cannot read stays null
 * and lowers confidence rather than being guessed at.
 */
import { repairLigatures } from "./pdf";

export interface FieldConfidence {
  company: number;
  email: number;
  contact: number;
  overall: number;
}

export interface ParsedRecord {
  companyName: string;
  address: string | null;
  poBox: string | null;
  phones: string[];
  whatsapp: string | null;
  emails: string[];
  website: string | null;
  contactName: string | null;
  designation: string | null;
  productsServices: string | null;
  brandName: string | null;
  sourcePage: number;
  /** Verbatim source text, kept so every claim can be traced back. */
  rawBlock: string;
  confidence: FieldConfidence;
  warnings: string[];
}

export interface ParsePageResult {
  records: ParsedRecord[];
  skippedBlocks: number;
}

/* ------------------------------------------------------------- cleaning */

const RUNNING_HEADER =
  /^(https?:\/\/)?www\.directory\.uma\.or\.ug\s*(Uganda Manufactur\w*\s+Association\s+Business\s+Directory\s+\d{4})?\s*\d*$/i;
const RUNNING_HEADER_ALT =
  /^\d*\s*Uganda Manufactur\w*\s+Association\s+Business\s+Directory\s+\d{4}\s*(https?:\/\/)?(www\.directory\.uma\.or\.ug)?\s*\d*$/i;
const SEPARATOR = /^[_\s]{8,}$/;

/**
 * Rejoins words the layout hyphenated across a line break ("elec -\ntrical")
 * and addresses split mid-token ("...jesaniconstruction.\ncom"). Both are
 * artifacts of the two-column setting, not real content, and leaving them in
 * corrupts email addresses and the products text personalization relies on.
 */
function mendLineBreaks(lines: string[]): string[] {
  const out: string[] = [];

  for (const line of lines) {
    const prev = out[out.length - 1];

    if (prev !== undefined) {
      // "elec -" + "trical" -> "electrical"
      const hyphenated = /(\S)\s*-\s*$/.exec(prev);
      if (hyphenated && /^[a-z]/.test(line)) {
        out[out.length - 1] = prev.replace(/\s*-\s*$/, "") + line;
        continue;
      }
      // "someone@company." + "com" -> "someone@company.com"
      if (/[.@]$/.test(prev) && /^[a-z]{2,6}\b/.test(line) && /@/.test(prev)) {
        out[out.length - 1] = prev + line;
        continue;
      }
    }

    out.push(line);
  }

  return out;
}

function cleanPageText(text: string): string[] {
  return mendLineBreaks(
    text.split("\n")
      .map((l) => repairLigatures(l).replace(/\s+/g, " ").trim())
      .filter((l) => l && !RUNNING_HEADER.test(l) && !RUNNING_HEADER_ALT.test(l)),
  );
}

/* --------------------------------------------------------- field labels */

/**
 * Labels appear both at line start and inline ("Contact Person: X Designation:
 * Y"), so the block is treated as one string and split at every label
 * occurrence rather than parsed line by line.
 */
const LABELS = [
  ["poBox", /P\.?\s?O\.?\s?Box\s*:?/i],
  ["phone", /(?:Tel(?:ephone)?|Mob(?:ile)?|Phone|Cell|Toll[\s-]?free|Landline|Hotline|Fax)\s*\.?\s*:/i],
  ["whatsapp", /Whats\s?App\s*:/i],
  ["email", /E-?\s?mail\s*:/i],
  ["website", /(?:Website|Web\s?site|Web)\s*:/i],
  ["contactName", /Contact\s+Person\s*:/i],
  ["designation", /Designation\s*:/i],
  ["productsServices", /Products?\s*\/\s*Services?\s*:/i],
  ["brandName", /Brands?\s*(?:Name)?\s*:/i],
  ["facebook", /Facebook\s*:/i],
  ["twitter", /Twitter\s*:/i],
  ["linkedin", /Linked\s?In\s*:/i],
  ["instagram", /Instagram\s*:/i],
] as const;

type LabelKey = (typeof LABELS)[number][0];

const ANY_LABEL = new RegExp(
  LABELS.map(([, re]) => `(?:${re.source})`).join("|"),
  "gi",
);

interface Segment { key: LabelKey; value: string }

function splitByLabels(block: string): { preamble: string; segments: Segment[] } {
  const hits: { index: number; length: number; key: LabelKey }[] = [];

  ANY_LABEL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANY_LABEL.exec(block)) !== null) {
    const matched = m[0];
    const key = LABELS.find(([, re]) => new RegExp(`^(?:${re.source})$`, "i").test(matched))?.[0];
    if (key) hits.push({ index: m.index, length: matched.length, key });
    if (m.index === ANY_LABEL.lastIndex) ANY_LABEL.lastIndex++;
  }

  if (!hits.length) return { preamble: block.trim(), segments: [] };

  const preamble = block.slice(0, hits[0].index).trim();
  const segments: Segment[] = hits.map((hit, i) => ({
    key: hit.key,
    value: block
      .slice(hit.index + hit.length, hits[i + 1]?.index ?? block.length)
      .trim(),
  }));

  return { preamble, segments };
}

/* ------------------------------------------------------------ extractors */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/i;

function extractEmails(s: string): string[] {
  const found = s.match(EMAIL_RE) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/[.,;]+$/, "")))];
}

/**
 * Directory numbers are written many ways: "+256 (70)3 - 056647",
 * "0755788885", "+256414255451/4255824". Matching phone-shaped runs is safer
 * than splitting on separators, which used to carry the following entry's
 * company name along behind the last number.
 */
const PHONE_RE = /\+?\d[\d\s()./-]{6,}\d/g;

function extractPhones(s: string): string[] {
  const found = s.match(PHONE_RE) ?? [];
  return [...new Set(
    found
      .map((p) => p.trim().replace(/[\s.\-/]+$/, ""))
      .filter((p) => {
        const digits = (p.match(/\d/g) ?? []).length;
        // Ugandan numbers are 9-10 digits locally, up to 12 with +256. Longer
        // runs are usually two numbers the layout ran together, which a
        // reviewer should see verbatim rather than have us guess at.
        return digits >= 9 && digits <= 14;
      }),
  )];
}

/**
 * Address lines are frequently set in capitals too, so "capitalised" alone is
 * not enough to tell a name from an address. Without this, entries such as
 * "BLITZ PACKAGING LTD / PLOT 20/22, NALUKOLONGO" produced a company name with
 * the street address glued on, which then appeared in the subject line.
 */
const ADDRESS_LINE =
  /^(plot\b|p\.?\s?o\.?\s?box|po\s?box|opposite\b|near\b|along\b|\d+(st|nd|rd|th)?\s)|(\b(road|street|avenue|lane|close|crescent|drive|highway|zone|division|district|parish|village|industrial area|park|building|house|floor|suite|arcade|mall|complex)\b)/i;

/** A capitalised line carrying a legal marker is definitely a company name. */
const HAS_LEGAL_MARKER =
  /\b(LTD|LIMITED|CO|COMPANY|PLC|INC|ENTERPRISES?|HOLDINGS?|GROUP|INDUSTRIES|INTERNATIONAL|SMC|U\)|\(U\))\b/;

function isUpperLine(l: string): boolean {
  const letters = l.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

/**
 * Company names are set in capitals and may wrap across two lines.
 *
 * `headings` carries section titles detected across the whole document
 * ("HOTELS, HOSPITALITY", "BANKING & FINANCIAL SERVICES"). They sit above the
 * first entry of a section and are otherwise indistinguishable from the first
 * line of a two-line company name, so they are identified by repetition
 * rather than by shape.
 */
function extractCompanyAndAddress(preamble: string, headings?: ReadonlySet<string>): {
  companyName: string | null; address: string | null;
} {
  let lines = preamble.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { companyName: null, address: null };

  // Drop a leading section title such as "BANKING & FINANCIAL SERVICES" or
  // "HOTELS,HOSPITALITY". These sit above the first entry of a section and
  // would otherwise be read as the first line of a two-line company name,
  // putting the category into the subject line. Stripping is deliberately
  // conservative: the line must be built only from category words, carry no
  // legal-entity marker of its own, and be followed by a line that is already
  // a complete company name.
  while (
    lines.length > 1 &&
    isUpperLine(lines[0]) &&
    !HAS_LEGAL_MARKER.test(lines[0]) &&
    isCategoryHeading(normalizeHeading(lines[0])) &&
    isUpperLine(lines[1]) &&
    HAS_LEGAL_MARKER.test(lines[1])
  ) {
    lines = lines.slice(1);
  }

  // Explicitly configured headings, when supplied, are also removed.
  if (headings?.size) {
    while (lines.length > 1 && headings.has(normalizeHeading(lines[0]))) {
      lines = lines.slice(1);
    }
  }

  const isUpper = isUpperLine;

  const nameParts: string[] = [];
  let i = 0;
  while (i < lines.length && isUpper(lines[i]) && nameParts.length < 3) {
    // An address line ends the name, even in capitals — unless it also
    // carries a legal marker, as in "PLOT 5 HOLDINGS LTD".
    if (nameParts.length > 0 && ADDRESS_LINE.test(lines[i]) && !HAS_LEGAL_MARKER.test(lines[i])) {
      break;
    }
    nameParts.push(lines[i]);
    i++;
    // Once the name carries a legal marker it is complete; anything after is
    // address or content.
    if (HAS_LEGAL_MARKER.test(nameParts[nameParts.length - 1])) break;
  }

  if (!nameParts.length) {
    // Fall back to the first line so the record is still reviewable, but the
    // caller will see the lowered confidence and route it to data review.
    return { companyName: lines[0], address: lines.slice(1).join(", ") || null };
  }

  return {
    companyName: nameParts.join(" ").replace(/\s+/g, " ").trim(),
    address: lines.slice(i).join(", ").trim() || null,
  };
}

/* -------------------------------------------------------------- scoring */

function scoreConfidence(r: Omit<ParsedRecord, "confidence" | "warnings">): {
  confidence: FieldConfidence; warnings: string[];
} {
  const warnings: string[] = [];

  let company = 0;
  if (r.companyName) {
    company = 60;
    if (/\b(LTD|LIMITED|CO|COMPANY|PLC|ENTERPRISES|GROUP|INDUSTRIES|U\)|\(U\))\b/i.test(r.companyName)) {
      company += 30;
    }
    if (r.companyName.length >= 6 && r.companyName.length <= 80) company += 10;
    if (r.companyName.length < 4) {
      company = 25;
      warnings.push("Company name is suspiciously short.");
    }
  } else {
    warnings.push("No company name could be read from this entry.");
  }

  let email = 0;
  if (r.emails.length) {
    email = 70;
    const primary = r.emails[0];
    // A generic mailbox is deliverable but not a named recipient.
    if (/^(info|sales|admin|office|enquiries|contact)@/i.test(primary)) email += 10;
    else email += 20;
    // Free mail on a company with its own website suggests a stale listing.
    if (/@(gmail|yahoo|hotmail|outlook)\./i.test(primary) && r.website) {
      email -= 15;
      warnings.push("Contact uses a free mail provider although the company has a website.");
    }
    if (r.emails.length > 2) {
      warnings.push(`${r.emails.length} addresses found; a reviewer must choose the right recipient.`);
    }
  } else {
    warnings.push("No email address found. This entry cannot be emailed until one is supplied.");
  }

  let contact = 0;
  if (r.contactName) {
    contact = 60;
    if (r.designation) contact += 25;
    if (/^(mr|mrs|ms|dr|eng|prof)\.?\s/i.test(r.contactName)) contact += 15;
    if (r.contactName.split(/\s+/).length < 2) {
      contact -= 20;
      warnings.push("Contact name looks incomplete.");
    }
  } else {
    warnings.push("No named contact; the email must address the company team.");
  }

  if (!r.productsServices) {
    warnings.push("No products/services text, so personalization has nothing to ground itself in.");
  }

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const overall = clamp(company * 0.3 + email * 0.45 + contact * 0.25);

  return {
    confidence: {
      company: clamp(company),
      email: clamp(email),
      contact: clamp(contact),
      overall,
    },
    warnings,
  };
}

/* ----------------------------------------------------------------- main */

function first(segments: Segment[], key: LabelKey): string | null {
  const s = segments.find((x) => x.key === key);
  return s?.value.trim() || null;
}

function allOf(segments: Segment[], key: LabelKey): string {
  return segments.filter((x) => x.key === key).map((x) => x.value).join(" ");
}

const TRAILING_CAPS_BLOCK = /\n([A-Z][A-Z0-9 .,&()'-]{8,})$/;

/** Words that mark a capitalised line as a company heading, not content. */
const COMPANY_MARKER =
  /\b(LTD|LIMITED|CO|COMPANY|PLC|INC|ENTERPRISES?|HOLDINGS?|GROUP|INDUSTRIES|INTERNATIONAL|SERVICES|TRADING)\b/;

/**
 * Trailing text belonging to the *next* entry sometimes lands in a segment
 * when the layout wrapped oddly. Cutting on "capitalised trailing line" alone
 * is too eager: many directory entries write their own products in capitals,
 * and "SUPPLY OF AUTOMOTIVE PRODUCTS (TYRE, / OIL & BATTERY)" lost half its
 * content that way. A line is only treated as the next company's heading when
 * it carries a legal-entity marker and does not close a bracket the value
 * itself opened.
 */
function trimRunOn(value: string): string {
  const m = TRAILING_CAPS_BLOCK.exec(value);

  if (m) {
    const head = value.slice(0, m.index);
    const opens = (head.match(/\(/g) ?? []).length;
    const closes = (head.match(/\)/g) ?? []).length;
    const bracketOpen = opens > closes;

    if (COMPANY_MARKER.test(m[1]) && !bracketOpen) {
      return head.replace(/\s+/g, " ").trim();
    }
  }

  return value.replace(/\s+/g, " ").trim();
}

export function parsePage(
  pageText: string,
  pageNumber: number,
  headings?: ReadonlySet<string>,
): ParsePageResult {
  const lines = cleanPageText(pageText);

  // Entries are divided by rules of underscores.
  const blocks: string[][] = [[]];
  for (const line of lines) {
    if (SEPARATOR.test(line)) blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }

  const records: ParsedRecord[] = [];
  let skipped = 0;

  for (const blockLines of blocks) {
    const raw = blockLines.join("\n").trim();
    // Too short to be an entry: a stray caption, page furniture or an advert.
    if (raw.length < 40) { if (raw) skipped++; continue; }

    const { preamble, segments } = splitByLabels(raw);
    const { companyName, address } = extractCompanyAndAddress(preamble, headings);

    // An entry with no labelled fields at all is almost certainly an advert.
    if (!companyName || segments.length === 0) { skipped++; continue; }

    const emailText = allOf(segments, "email");
    // Only the labelled phone segments. Scanning the preamble too used to drag
    // the following entry's company name and address in behind the number.
    const phoneText = trimRunOn(allOf(segments, "phone"));

    const base = {
      companyName,
      address,
      poBox: first(segments, "poBox"),
      phones: extractPhones(phoneText),
      whatsapp: first(segments, "whatsapp"),
      emails: extractEmails(`${emailText} ${raw}`),
      website: (() => {
        const w = first(segments, "website");
        if (!w) return null;
        const m = URL_RE.exec(w);
        return m ? m[0].replace(/[.,;]+$/, "") : null;
      })(),
      contactName: (() => {
        const c = first(segments, "contactName");
        return c ? trimRunOn(c).replace(/\s{2,}.*$/, "") || null : null;
      })(),
      designation: (() => {
        const d = first(segments, "designation");
        return d ? trimRunOn(d) || null : null;
      })(),
      productsServices: (() => {
        const p = first(segments, "productsServices");
        return p ? trimRunOn(p) || null : null;
      })(),
      brandName: (() => {
        const b = first(segments, "brandName");
        return b ? trimRunOn(b) || null : null;
      })(),
      sourcePage: pageNumber,
      rawBlock: raw,
    };

    const { confidence, warnings } = scoreConfidence(base);
    records.push({ ...base, confidence, warnings });
  }

  return { records, skippedBlocks: skipped };
}

export function normalizeHeading(line: string): string {
  return line.toUpperCase().replace(/[^A-Z& ]/g, " ").replace(/\s+/g, " ").trim();
}

/** A section heading has to repeat; a specific company name generally does not. */
const HEADING_MIN_OCCURRENCES = 2;

/**
 * Words the directory builds its section titles from. A repeated line counts
 * as a heading only when *every* word in it comes from this set, which is what
 * separates "BANKING & FINANCIAL SERVICES" from "KATUMBA FURNITURE" — the
 * latter carries a word that is not a category, so it is a company.
 */
const CATEGORY_WORDS = new Set([
  "AND", "OF", "THE", "ETC",
  "BANKING", "FINANCIAL", "FINANCE", "INSURANCE", "ASSURANCE", "CAPITAL",
  "HOTELS", "HOSPITALITY", "TOURISM", "LEISURE", "RESTAURANTS", "CATERING",
  "FURNITURE", "INTERIOR", "INTERIORS", "WOOD", "TIMBER",
  "AUTOMOTIVE", "MOTOR", "MOTORS", "VEHICLES", "TRANSPORT", "LOGISTICS",
  "CONSTRUCTION", "BUILDING", "ENGINEERING", "STEEL", "METAL", "CEMENT",
  "MANUFACTURING", "MANUFACTURERS", "INDUSTRY", "INDUSTRIAL",
  "AGRO", "AGRICULTURE", "AGRICULTURAL", "FOOD", "FOODS", "BEVERAGES",
  "PACKAGING", "PRINTING", "PAPER", "PLASTICS", "PLASTIC", "RUBBER",
  "TEXTILE", "TEXTILES", "GARMENTS", "LEATHER",
  "PHARMACEUTICAL", "PHARMACEUTICALS", "HEALTH", "HEALTHCARE", "MEDICAL",
  "CHEMICALS", "CHEMICAL", "ENERGY", "POWER", "OIL", "GAS", "MINING",
  "EDUCATION", "TRAINING", "MEDIA", "ICT", "IT", "TELECOM",
  "SERVICES", "SERVICE", "PRODUCTS", "TRADE", "TRADING", "RETAIL",
  "WHOLESALE", "SUPERMARKETS", "ELECTRONICS", "ELECTRICAL", "APPLIANCES",
  "SECURITY", "CONSULTANCY", "CONSULTING", "PROFESSIONAL", "GENERAL",
  "WATER", "SANITATION", "ENVIRONMENT", "WASTE", "RECYCLING",
]);

function isCategoryHeading(normalized: string): boolean {
  const words = normalized.split(" ").filter((w) => w && w !== "&");
  if (words.length === 0 || words.length > 6) return false;
  return words.every((w) => CATEGORY_WORDS.has(w));
}

/**
 * Finds the section titles the directory prints above the first entry of each
 * category. They are capitalised lines with no legal-entity marker that recur
 * across the document, which is what separates "BANKING & FINANCIAL SERVICES"
 * from "BIYINZIKA POULTRY" — the latter appears once.
 */
function detectSectionHeadings(pages: { page: number; text: string }[]): Set<string> {
  const counts = new Map<string, number>();

  for (const p of pages) {
    for (const raw of p.text.split("\n")) {
      const line = raw.trim();
      if (!line || line.length < 4 || line.length > 60) continue;
      if (!isUpperLine(line) || HAS_LEGAL_MARKER.test(line)) continue;
      const key = normalizeHeading(line);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const headings = new Set<string>();
  for (const [key, n] of counts) {
    if (n >= HEADING_MIN_OCCURRENCES && isCategoryHeading(key)) headings.add(key);
  }
  return headings;
}

export function parseDocument(
  pages: { page: number; text: string }[],
): { records: ParsedRecord[]; skippedBlocks: number } {
  const headings = detectSectionHeadings(pages);
  const records: ParsedRecord[] = [];
  let skippedBlocks = 0;

  for (const p of pages) {
    const result = parsePage(p.text, p.page, headings);
    records.push(...result.records);
    skippedBlocks += result.skippedBlocks;
  }

  return { records, skippedBlocks };
}
