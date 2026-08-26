/**
 * Name handling for the subject line and salutation.
 *
 * The approved reference email addresses "Mr. Shukla" and says "AutoXpress",
 * not "Mr. Ravi Shukla" and "AUTOXPRESS UGANDA LIMITED". Getting either wrong
 * makes an otherwise careful message read like a mail merge.
 */

/**
 * Parenthesised country qualifiers have no word boundary before the bracket,
 * so they must be removed before the suffix pass can see them. Without this,
 * "Motorcare (U) Ltd" shortens to "Motorcare (U)".
 */
const PAREN_QUALIFIERS = /\((u|ug|uganda|ea|e\.a\.|k|t)\)/gi;

const LEGAL_SUFFIXES =
  /\b(limited|ltd|co\.?|company|plc|inc\.?|incorporated|enterprises?|holdings?|group|industries|international|uganda)\b\.?/gi;

/**
 * Short words that genuinely appear in trading names. Anything else that is
 * short and fully capitalised in the source is treated as an acronym and left
 * uppercase, which keeps DFCU, MTN, KCB and HMH intact while still casing
 * "FURNITURE CITY" properly. A reviewer can always correct the subject line;
 * this only has to be right often enough not to be irritating.
 */
const COMMON_SHORT_WORDS = new Set([
  "city", "auto", "bags", "east", "west", "north", "south", "home", "food",
  "foods", "oil", "oils", "gas", "star", "stars", "sun", "king", "gold",
  "blue", "red", "new", "one", "pure", "tech", "mega", "plus", "care",
  "life", "unity", "pearl", "nile", "lake", "hill", "rock", "sand", "wood",
  "steel", "farm", "agro", "seed", "seeds", "milk", "bank", "and", "the",
  "for", "of", "in", "at", "sons", "bros", "sales", "world", "point",
]);

const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "eng", "engr", "hon", "rev", "sir",
  "madam", "capt", "col", "h.e", "he",
]);

/**
 * Trading name for the subject line: "AUTOXPRESS UGANDA LIMITED" → "AutoXpress".
 * Returns the original when stripping would leave too little to identify the
 * company — a wrong short name is worse than a long correct one.
 */
export function shortCompanyName(full: string): string {
  const stripped = full
    .replace(PAREN_QUALIFIERS, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length < 3) return titleCaseCompany(full);
  return titleCaseCompany(stripped);
}

/**
 * ALL-CAPS directory entries need casing, but names that already carry
 * deliberate capitalization ("DFCU", "HMH Rainbow") must not be flattened.
 */
function titleCaseCompany(name: string): string {
  if (name !== name.toUpperCase()) return name.trim();

  return name
    .split(/\s+/)
    .map((word) => {
      const letters = word.replace(/[^A-Za-z]/g, "");
      // Four letters or fewer, and not a word we recognise: treat as an
      // acronym. Five-letter tokens are almost always real words in these
      // listings ("SPEAR", "EZONE", "PEARL"), so they get title case.
      if (letters.length > 0 && letters.length <= 4 &&
          !COMMON_SHORT_WORDS.has(letters.toLowerCase())) {
        return word.toUpperCase();
      }
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ")
    .trim();
}

/**
 * The honorific the directory actually supplied, or null. Used to tell the
 * generator when it may write "Mr." and when doing so would mean inferring
 * gender from a name.
 */
export function honorificOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const key = first.replace(/\./g, "").toLowerCase();
  if (!key || !HONORIFICS.has(key)) return null;
  return first.replace(/\.?$/, ".").replace(/^\w/, (c) => c.toUpperCase());
}

export interface SalutationParts {
  /** e.g. "Dear Mr. Shukla" or "Dear AutoXpress Team". */
  salutation: string;
  /** True when the greeting names a person rather than the company. */
  personal: boolean;
}

/**
 * Builds the greeting. Prefers honorific + surname; falls back through plain
 * surname, full name, and finally the company team. Never invents an
 * honorific, and never guesses a surname from a single-token name.
 */
export function buildSalutation(
  fullName: string | null | undefined,
  companyName: string,
): SalutationParts {
  const raw = (fullName ?? "").replace(/\s+/g, " ").trim();

  if (raw) {
    const tokens = raw.split(" ").filter(Boolean);
    const first = tokens[0].replace(/\./g, "").toLowerCase();
    const hasHonorific = HONORIFICS.has(first);
    const honorific = hasHonorific
      ? tokens[0].replace(/\.?$/, ".").replace(/^\w/, (c) => c.toUpperCase())
      : null;

    const nameTokens = hasHonorific ? tokens.slice(1) : tokens;

    if (nameTokens.length >= 2) {
      // With a title, surname alone is correct and is what the approved
      // reference email uses: "Dear Mr. Shukla".
      if (honorific) {
        const surname = properCase(nameTokens[nameTokens.length - 1]);
        return { salutation: `Dear ${honorific} ${surname}`, personal: true };
      }

      // Without one, use the full name. Deriving "Dear Shukla" reads abruptly
      // in Ugandan business correspondence, and supplying "Mr." ourselves
      // would mean guessing the recipient's gender from their name.
      const full = nameTokens.map(properCase).join(" ");
      return { salutation: `Dear ${full}`, personal: true };
    }

    if (nameTokens.length === 1) {
      const only = properCase(nameTokens[0]);
      // One token with an honorific is already a usable surname.
      if (honorific) return { salutation: `Dear ${honorific} ${only}`, personal: true };
      // Without one, we cannot tell a first name from a surname, and
      // "Dear Zhang" may be either. Address the company instead.
      return { salutation: `Dear ${shortCompanyName(companyName)} Team`, personal: false };
    }
  }

  return { salutation: `Dear ${shortCompanyName(companyName)} Team`, personal: false };
}

function properCase(word: string): string {
  if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const FLOOR_WORDS: Record<string, string> = {
  ground: "ground-floor",
  first: "first-floor",
  second: "second-floor",
  unassigned: "commercial",
};

const SPACE_WORDS: Record<string, string> = {
  vehicle_motorcycle: "showroom",
  appliances_electronics: "showroom",
  supermarket_retail: "retail space",
  furniture_interior: "showroom",
  bank_financial: "branch and office space",
  corporate_hq: "office space",
  wellness_leisure: "destination space",
  unclassified: "commercial space",
};

/** Subject formula from the approved reference email. */
export function buildSubject(
  companyName: string, floor: string, segment: string,
): string {
  const floorWord = FLOOR_WORDS[floor] ?? "commercial";
  const spaceWord = SPACE_WORDS[segment] ?? "commercial space";
  return `A ${floorWord} ${spaceWord} opportunity for ${shortCompanyName(companyName)} on Fifth Street`;
}
