/**
 * Segmentation and relevance scoring, sections 5.3 and 5.4.
 *
 * Deliberately rule-based rather than model-driven: the reviewer screen has to
 * show *why* a prospect scored what it did, and a rules table can be read,
 * argued with and corrected by a campaign manager. Pure functions, no I/O.
 */

export type TenantSegment =
  | "vehicle_motorcycle" | "appliances_electronics" | "supermarket_retail"
  | "furniture_interior" | "bank_financial" | "corporate_hq"
  | "wellness_leisure" | "unclassified";

export type PropertyFloor = "ground" | "first" | "second" | "unassigned";

interface SegmentRule {
  segment: TenantSegment;
  floor: PropertyFloor;
  label: string;
  pitch: string;
  /** Matched case-insensitively against name + sector + products/services. */
  keywords: string[];
  /** Any hit here disqualifies the rule, to stop obvious false positives. */
  negative?: string[];
}

/** Order matters: the first rule with the highest keyword hit count wins. */
export const SEGMENT_RULES: SegmentRule[] = [
  {
    segment: "vehicle_motorcycle",
    floor: "ground",
    label: "Vehicle or motorcycle company",
    pitch: "Ground-floor visibility, glazed showroom frontage, vehicle access and parking",
    keywords: [
      "motor", "vehicle", "automotive", "car ", "cars", "truck", "tyre", "tyres",
      "tire", "motorcycle", "boda", "bajaj", "nissan", "toyota", "ford", "hyundai",
      "mercedes", "fuso", "jeep", "fiat", "auto", "spare part", "lubricant",
      "battery", "batteries", "garage", "bus ", "trailer",
    ],
    negative: ["motorcycle insurance", "car wash detergent"],
  },
  {
    segment: "appliances_electronics",
    floor: "ground",
    label: "Appliance or electronics brand",
    pitch: "Ground-floor retail showroom, product display, accessibility and brand presence",
    keywords: [
      "appliance", "electronic", "electrical", "refrigerator", "fridge", "freezer",
      "cooker", "television", "tv ", "blender", "microwave", "washing machine",
      "air conditioner", "speaker", "audio", "home entertainment", "fans",
    ],
  },
  {
    segment: "supermarket_retail",
    floor: "ground",
    label: "Supermarket or large-format retailer",
    pitch: "Ground-floor space, customer access, parking and high-visibility frontage",
    keywords: [
      "supermarket", "hypermarket", "retail chain", "grocery", "groceries",
      "department store", "convenience store", "wholesale retail", "shopping",
    ],
  },
  {
    segment: "furniture_interior",
    floor: "first",
    label: "Furniture or interior company",
    pitch: "First-floor destination showroom, large display area, lifts and glazed frontage",
    keywords: [
      "furniture", "interior", "upholstery", "joinery", "cabinet", "sofa",
      "mattress", "bedding", "home decor", "décor", "fittings", "kitchen fittings",
      "curtain", "carpet", "tiles", "sanitary ware",
    ],
  },
  {
    segment: "bank_financial",
    floor: "first",
    label: "Bank or financial institution",
    pitch: "First-floor branch, corporate office or service centre; professional location and access",
    keywords: [
      "bank", "banking", "microfinance", "sacco", "insurance", "assurance",
      "financial services", "forex", "bureau de change", "credit", "capital markets",
      "asset management", "leasing finance",
    ],
  },
  {
    segment: "wellness_leisure",
    floor: "second",
    label: "Gym, spa, wellness or leisure brand",
    pitch: "Second-floor destination space and adaptable large floor plate",
    keywords: [
      "gym", "fitness", "spa", "wellness", "salon", "beauty", "leisure",
      "nightclub", "lounge", "recreation", "hotel", "hospitality", "restaurant",
      "catering", "entertainment",
    ],
  },
  {
    segment: "corporate_hq",
    floor: "first",
    label: "Corporate headquarters",
    pitch: "First-floor office/showroom opportunity, scale, accessibility and image",
    // Deliberately narrow. Generic words like "industries", "manufacturing"
    // or "limited" match nearly every entry in a manufacturers' directory,
    // which produced a first-floor head-office pitch for poultry-feed
    // producers. Only explicit corporate-scale signals qualify; everything
    // else falls through to manual qualification, which is the safe default.
    keywords: [
      "holdings", "group of companies", "corporation", "consultancy",
      "telecommunication", "head office", "headquarters", "corporate office",
      "regional office", "investment company",
    ],
  },
];

export interface ClassificationResult {
  segment: TenantSegment;
  floor: PropertyFloor;
  label: string;
  pitch: string;
  matchedKeywords: string[];
}

const UNCLASSIFIED: ClassificationResult = {
  segment: "unclassified",
  floor: "unassigned",
  label: "Unclear or poor fit",
  // Section 5.3: do not auto-generate; place in Manual Review.
  pitch: "Do not auto-generate. Route to manual qualification.",
  matchedKeywords: [],
};

export function classifyProspect(input: {
  companyName?: string | null;
  sector?: string | null;
  productsServices?: string | null;
}): ClassificationResult {
  const haystack = [input.companyName, input.sector, input.productsServices]
    .filter(Boolean).join(" ").toLowerCase();

  if (!haystack.trim()) return UNCLASSIFIED;

  let best: ClassificationResult | null = null;
  let bestHits = 0;

  for (const rule of SEGMENT_RULES) {
    if (rule.negative?.some((n) => haystack.includes(n))) continue;
    const matched = rule.keywords.filter((k) => haystack.includes(k));
    if (matched.length > bestHits) {
      bestHits = matched.length;
      best = {
        segment: rule.segment,
        floor: rule.floor,
        label: rule.label,
        pitch: rule.pitch,
        matchedKeywords: matched,
      };
    }
  }

  return best ?? UNCLASSIFIED;
}

/* ------------------------------------------------------------- scoring */

export interface ScoreInput {
  classification: ClassificationResult;
  contact: {
    fullName?: string | null;
    designation?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  website?: string | null;
  address?: string | null;
  /**
   * Set only by a manager, in the UI, with a stated reason. Section 5.4:
   * a relationship score must never be inferred from surnames or directory
   * proximity, so nothing in this file derives it.
   */
  strategicRelationship?: { points: number; reason: string } | null;
}

export interface ScoreResult {
  total: number;
  breakdown: Record<string, number>;
  rationale: string[];
  band: "priority" | "normal" | "manual" | "excluded";
  action: string;
}

export const SCORE_WEIGHTS = {
  sectorFit: 35,
  spaceUseFit: 25,
  kampalaRelevance: 15,
  contactCompleteness: 10,
  brandWebsiteQuality: 5,
  strategicRelationship: 10,
} as const;

export function scoreProspect(input: ScoreInput): ScoreResult {
  const b: Record<string, number> = {};
  const why: string[] = [];
  const { classification: c, contact } = input;

  // Sector fit: proportional to how strongly the rule matched, capped.
  if (c.segment === "unclassified") {
    b.sectorFit = 0;
    why.push("No segment rule matched the directory description.");
  } else {
    const hits = Math.min(c.matchedKeywords.length, 4);
    b.sectorFit = Math.round((hits / 4) * SCORE_WEIGHTS.sectorFit);
    why.push(`Segment "${c.label}" matched on ${c.matchedKeywords.slice(0, 4).join(", ")}.`);
  }

  // Space/use fit: a rule that resolves to a concrete floor is a real match.
  b.spaceUseFit = c.floor === "unassigned" ? 0 : SCORE_WEIGHTS.spaceUseFit;
  if (c.floor !== "unassigned") {
    why.push(`Recommended floor: ${c.floor}. ${c.pitch}.`);
  }

  // Kampala relevance: a Kampala or Industrial Area address is direct evidence.
  const addr = (input.address ?? "").toLowerCase();
  if (/kampala|industrial area|nakawa|ntinda|lugogo/.test(addr)) {
    b.kampalaRelevance = SCORE_WEIGHTS.kampalaRelevance;
    why.push("Address indicates a Kampala presence.");
  } else if (addr.trim()) {
    b.kampalaRelevance = Math.round(SCORE_WEIGHTS.kampalaRelevance * 0.4);
    why.push("Ugandan address on record but not identified as Kampala.");
  } else {
    b.kampalaRelevance = 0;
    why.push("No address on record.");
  }

  // Contact completeness: a named, titled, emailable person.
  let contactPts = 0;
  if (contact?.email) contactPts += 5;
  if (contact?.fullName) contactPts += 3;
  if (contact?.designation) contactPts += 1;
  if (contact?.phone) contactPts += 1;
  b.contactCompleteness = Math.min(contactPts, SCORE_WEIGHTS.contactCompleteness);
  if (!contact?.email) why.push("No contact email; the draft cannot be sent as-is.");

  // Brand/website quality.
  const site = (input.website ?? "").trim();
  b.brandWebsiteQuality = site
    ? (/^https?:\/\//i.test(site) || site.includes(".")
      ? SCORE_WEIGHTS.brandWebsiteQuality
      : 2)
    : 0;

  // Strategic relationship: only ever an explicit, reasoned manager input.
  b.strategicRelationship = Math.min(
    Math.max(input.strategicRelationship?.points ?? 0, 0),
    SCORE_WEIGHTS.strategicRelationship,
  );
  if (input.strategicRelationship?.reason) {
    why.push(`Strategic relationship: ${input.strategicRelationship.reason}.`);
  }

  let total = Math.min(Object.values(b).reduce((s, n) => s + n, 0), 100);

  // A prospect with no email address cannot be emailed, so it must never land
  // in a band that says "generate a draft". Capping into the manual band sends
  // it to a person to find an address instead of into the drafting queue.
  if (!contact?.email) total = Math.min(total, 45);

  const { band, action } = bandFor(total);
  return { total, breakdown: b, rationale: why, band, action };
}

export function bandFor(total: number): { band: ScoreResult["band"]; action: string } {
  if (total >= 80) return { band: "priority", action: "Priority personalized outreach" };
  if (total >= 60) return { band: "normal", action: "Generate draft for normal review" };
  if (total >= 40) return { band: "manual", action: "Manual qualification before drafting" };
  return { band: "excluded", action: "Exclude unless a manager overrides" };
}

/** Normalized key for duplicate detection across imports. */
export function dedupeKey(companyName: string): string {
  return companyName
    .toLowerCase()
    // Parenthesised qualifiers first: "(u)" and "(uganda)" carry no word
    // boundary before the bracket, so the suffix pass below cannot see them
    // and "Motorcare (U) Ltd" would otherwise not match "Motorcare Uganda Ltd".
    .replace(/\((u|ug|uganda|ea|k)\)/g, " ")
    .replace(/\b(ltd|limited|co|company|uganda|plc|inc|group|enterprises|holdings)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}
