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

/** Company names are set in capitals and may wrap across two lines. */
function extractCompanyAndAddress(preamble: string): {
  companyName: string | null; address: string | null;
} {
  const lines = preamble.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { companyName: null, address: null };

  const isUpper = (l: string) => {
    const letters = l.replace(/[^A-Za-z]/g, "");
    if (letters.length < 2) return false;
    return letters === letters.toUpperCase();
  };

  const nameParts: string[] = [];
  let i = 0;
  while (i < lines.length && isUpper(lines[i]) && nameParts.length < 3) {
    nameParts.push(lines[i]);
    i++;
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

export function parsePage(pageText: string, pageNumber: number): ParsePageResult {
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
    const { companyName, address } = extractCompanyAndAddress(preamble);

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

export function parseDocument(
  pages: { page: number; text: string }[],
): { records: ParsedRecord[]; skippedBlocks: number } {
  const records: ParsedRecord[] = [];
  let skippedBlocks = 0;

  for (const p of pages) {
    const result = parsePage(p.text, p.page);
    records.push(...result.records);
    skippedBlocks += result.skippedBlocks;
  }

  return { records, skippedBlocks };
}
