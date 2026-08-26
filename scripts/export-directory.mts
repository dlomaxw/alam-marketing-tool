/**
 * Full UMA directory export.
 *
 * Extracts and classifies every entry, then writes three artefacts:
 *   exports/uma-prospects.json     complete records, grouped by tenant category
 *   exports/uma-prospects.csv      flat sheet for spreadsheets and CRM import
 *   exports/uma-agent-context.json compact per-company payload for an agent
 *
 * Read-only over the PDF. Nothing here writes to the database or sends
 * anything; use `npm run import:directory` to load the same data into the app.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { extractPdfText } from "../src/lib/ingestion/pdf";
import { parseDocument, type ParsedRecord } from "../src/lib/ingestion/parse-uma";
import { classifyProspect, scoreProspect, dedupeKey } from "../src/lib/scoring";
import { shortCompanyName, buildSalutation } from "../src/lib/naming";

const PDF = process.argv[2] ?? "source-documents/UMA-Dirrectory-2026.pdf";

/** Commercial priority, not company size — how well the fit is evidenced. */
const TIER_LABELS: Record<string, string> = {
  priority: "Tier 1 — Priority outreach (score 80-100)",
  normal: "Tier 2 — Standard outreach (score 60-79)",
  manual: "Tier 3 — Qualify manually first (score 40-59)",
  excluded: "Tier 4 — Excluded unless a manager overrides (score 0-39)",
};

const CATEGORY_LABELS: Record<string, string> = {
  vehicle_motorcycle: "Vehicle & motorcycle",
  appliances_electronics: "Appliances & electronics",
  supermarket_retail: "Supermarket & large-format retail",
  furniture_interior: "Furniture & interior",
  bank_financial: "Banks & financial services",
  corporate_hq: "Corporate headquarters",
  wellness_leisure: "Wellness, fitness & leisure",
  unclassified: "Unclassified — manual qualification required",
};

interface ExportRow {
  company: string;
  shortName: string;
  category: string;
  categoryLabel: string;
  recommendedFloor: string;
  recommendedPitch: string;
  tier: string;
  tierLabel: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  scoreRationale: string;
  primaryEmail: string | null;
  allEmails: string[];
  contactName: string | null;
  designation: string | null;
  suggestedSalutation: string;
  phones: string[];
  whatsapp: string | null;
  website: string | null;
  address: string | null;
  poBox: string | null;
  sector: string | null;
  productsServices: string | null;
  brandName: string | null;
  sourcePage: number;
  confidence: ParsedRecord["confidence"];
  emailable: boolean;
  warnings: string[];
  dedupeKey: string;
}

console.log("Extracting the directory…");
const bytes = new Uint8Array(await readFile(PDF));
const extracted = await extractPdfText(bytes);
const { records } = parseDocument(extracted.pages);
console.log(`  ${extracted.pageCount} pages, ${records.length} entries parsed\n`);

const seen = new Map<string, number>();
const rows: ExportRow[] = [];

for (const r of records) {
  const key = dedupeKey(r.companyName);
  if (!key) continue;

  const classification = classifyProspect({
    companyName: r.companyName,
    sector: r.brandName,
    productsServices: r.productsServices,
  });

  const score = scoreProspect({
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

  seen.set(key, (seen.get(key) ?? 0) + 1);

  rows.push({
    company: r.companyName,
    shortName: shortCompanyName(r.companyName),
    category: classification.segment,
    categoryLabel: CATEGORY_LABELS[classification.segment],
    recommendedFloor: classification.floor,
    recommendedPitch: classification.pitch,
    tier: score.band,
    tierLabel: TIER_LABELS[score.band],
    score: score.total,
    scoreBreakdown: score.breakdown,
    scoreRationale: score.rationale.join(" "),
    primaryEmail: r.emails[0] ?? null,
    allEmails: r.emails,
    contactName: r.contactName,
    designation: r.designation,
    suggestedSalutation: buildSalutation(r.contactName, r.companyName).salutation,
    phones: r.phones,
    whatsapp: r.whatsapp,
    website: r.website,
    address: r.address,
    poBox: r.poBox,
    sector: r.brandName,
    productsServices: r.productsServices,
    brandName: r.brandName,
    sourcePage: r.sourcePage,
    confidence: r.confidence,
    emailable: r.emails.length > 0,
    warnings: r.warnings,
    dedupeKey: key,
  });
}

// Highest-value first within each category.
rows.sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));

const byCategory: Record<string, ExportRow[]> = {};
for (const row of rows) (byCategory[row.category] ??= []).push(row);

await mkdir("exports", { recursive: true });

/* ---------------------------------------------------------------- JSON */

const grouped = Object.entries(byCategory)
  .sort(([, a], [, b]) => b.length - a.length)
  .map(([category, companies]) => ({
    category,
    label: CATEGORY_LABELS[category],
    recommendedFloor: companies[0]?.recommendedFloor ?? "unassigned",
    total: companies.length,
    emailable: companies.filter((c) => c.emailable).length,
    tiers: {
      priority: companies.filter((c) => c.tier === "priority").length,
      normal: companies.filter((c) => c.tier === "normal").length,
      manual: companies.filter((c) => c.tier === "manual").length,
      excluded: companies.filter((c) => c.tier === "excluded").length,
    },
    companies,
  }));

await writeFile("exports/uma-prospects.json", JSON.stringify({
  source: {
    document: PDF,
    pages: extracted.pageCount,
    extractedAt: new Date().toISOString(),
  },
  totals: {
    entries: rows.length,
    emailable: rows.filter((r) => r.emailable).length,
    withContactName: rows.filter((r) => r.contactName).length,
    duplicateKeys: [...seen.values()].filter((n) => n > 1).length,
  },
  categories: grouped,
}, null, 2));

/* ----------------------------------------------------------------- CSV */

const CSV_COLUMNS: (keyof ExportRow)[] = [
  "company", "shortName", "categoryLabel", "recommendedFloor", "tierLabel",
  "score", "primaryEmail", "allEmails", "contactName", "designation",
  "suggestedSalutation", "phones", "whatsapp", "website", "address", "poBox",
  "productsServices", "sourcePage", "emailable", "warnings",
];

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join("; ") : v === null || v === undefined ? "" : String(v);
  // Quote always: directory text is full of commas, quotes and newlines.
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
};

const csv = [
  CSV_COLUMNS.join(","),
  ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(",")),
].join("\r\n");

// BOM so Excel opens the Ugandan characters and € / ² symbols correctly.
await writeFile("exports/uma-prospects.csv", "﻿" + csv, "utf8");

/* ------------------------------------------------------- agent context */

/**
 * Compact form for an agent: only the fields generation is allowed to use,
 * plus the evidence pointer. Deliberately excludes score internals so the
 * model cannot rationalise from them.
 */
const agentContext = rows.filter((r) => r.emailable).map((r) => ({
  company_name: r.company,
  short_name: r.shortName,
  category: r.category,
  recommended_floor: r.recommendedFloor,
  recommended_pitch: r.recommendedPitch,
  products_services: r.productsServices,
  contact_name: r.contactName,
  designation: r.designation,
  suggested_salutation: r.suggestedSalutation,
  email: r.primaryEmail,
  phone: r.phones[0] ?? null,
  website: r.website,
  address: r.address,
  evidence: { source: "UMA Business Directory 2026", page: r.sourcePage },
  outreach_tier: r.tier,
}));

await writeFile("exports/uma-agent-context.json", JSON.stringify(agentContext, null, 2));

/* -------------------------------------------------------------- report */

console.log("BY CATEGORY (recommended floor)\n");
for (const g of grouped) {
  console.log(`${g.label}  →  ${g.recommendedFloor} floor`);
  console.log(`  ${g.total} companies, ${g.emailable} with an email address`);
  console.log(`  tiers: priority ${g.tiers.priority} · standard ${g.tiers.normal} · qualify ${g.tiers.manual} · excluded ${g.tiers.excluded}`);
  const top = g.companies.filter((c) => c.emailable).slice(0, 3);
  for (const c of top) {
    console.log(`    ${String(c.score).padStart(3)}  ${c.company.slice(0, 44).padEnd(44)} ${c.primaryEmail}`);
  }
  console.log();
}

const emailable = rows.filter((r) => r.emailable);
console.log("TOTALS");
console.log(`  entries parsed          ${rows.length}`);
console.log(`  with an email address   ${emailable.length}`);
console.log(`  with a named contact    ${rows.filter((r) => r.contactName).length}`);
console.log(`  possible duplicates     ${[...seen.values()].filter((n) => n > 1).length}`);
console.log(`  ready for outreach      ${emailable.filter((r) => r.tier === "priority" || r.tier === "normal").length}`);
console.log("\nWrote exports/uma-prospects.json, exports/uma-prospects.csv, exports/uma-agent-context.json");
