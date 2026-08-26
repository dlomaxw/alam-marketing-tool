/**
 * Post-generation safety checks, section 7.4.
 *
 * The system prompt asks the model to obey these rules; this module verifies
 * that it did. Prompt instructions are a request, not a guarantee, and the one
 * thing this product cannot tolerate is an unsupported claim reaching a
 * reviewer looking already-approved.
 *
 * Nothing here rewrites the copy. Violations become risk flags, and severe
 * ones force needs_manual_review, leaving the decision with a person.
 */
import type { GenerationOutput } from "./schema";

export interface ValidationIssue {
  code: string;
  severity: "blocking" | "warning";
  message: string;
  excerpt?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  riskFlags: string[];
  /** True when a person must look before this can ever be approved. */
  needsManualReview: boolean;
  manualReviewReason: string | null;
  wordCount: number;
}

/** Section 7.4: no unsupported superlatives. */
const SUPERLATIVES = [
  "best", "number one", "no. 1", "#1", "guaranteed return", "guaranteed returns",
  "world class", "world-class", "unbeatable", "unmatched", "premier",
  "the leading", "market leader", "cheapest", "fastest growing",
];

/** Language that would imply a relationship the company has not agreed to. */
const RELATIONSHIP_IMPLICATIONS = [
  "our partner", "in partnership with", "partnered with", "as our tenant",
  "your tenancy", "endorsed by", "endorses", "official supplier",
  "we represent", "on behalf of your company",
];

/** Ownership language, restricted per the leadership statement in section 2. */
const OWNERSHIP_CLAIMS = [
  "owns", "owner of", "owned by", "his property", "his company",
  "proprietor of", "belongs to",
];

const HTML_FORBIDDEN = /<\s*(script|iframe|object|embed|link|meta|style|form|input|base)\b/i;
const HTML_EVENT_ATTR = /\son[a-z]+\s*=/i;
const HTML_JS_URL = /(href|src)\s*=\s*["']?\s*javascript:/i;

export function validateGeneration(
  output: GenerationOutput,
  context: {
    contactName: string | null;
    /** Honorific the directory supplied, or null if it gave none. */
    contactHonorific?: string | null;
    wordLimit: number;
    /** Evidence ids that were actually supplied to the model. */
    availableEvidenceIds: string[];
    /** Approved property fact keys that were actually supplied. */
    availableFactKeys: string[];
    prohibitedClaims: { pattern: string; reason: string; isRegex: boolean }[];
  },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const text = `${output.subject}\n${output.preview_text}\n${output.salutation}\n${output.body_text}`;
  const lower = text.toLowerCase();

  /* ---------------------------------------------------- configured claims */

  for (const claim of context.prohibitedClaims) {
    let hit = false;
    let excerpt: string | undefined;
    if (claim.isRegex) {
      try {
        const re = new RegExp(claim.pattern, "i");
        const m = re.exec(text);
        if (m) { hit = true; excerpt = m[0]; }
      } catch {
        // A malformed admin-entered pattern must not silently disable the
        // check; surface it instead.
        issues.push({
          code: "prohibited_pattern_invalid",
          severity: "warning",
          message: `Prohibited-claim pattern "${claim.pattern}" is not a valid regular expression and was not checked.`,
        });
      }
    } else if (lower.includes(claim.pattern.toLowerCase())) {
      hit = true;
      excerpt = claim.pattern;
    }

    if (hit) {
      issues.push({
        code: "prohibited_claim",
        severity: "blocking",
        message: `Contains a prohibited claim: ${claim.reason}`,
        excerpt,
      });
    }
  }

  /* ------------------------------------------------------ tone and honesty */

  for (const term of SUPERLATIVES) {
    if (lower.includes(term)) {
      issues.push({
        code: "unsupported_superlative",
        severity: "blocking",
        message: `Unsupported superlative "${term}". Section 7.4 forbids these.`,
        excerpt: term,
      });
    }
  }

  for (const term of RELATIONSHIP_IMPLICATIONS) {
    if (lower.includes(term)) {
      issues.push({
        code: "implied_relationship",
        severity: "blocking",
        message: `"${term}" implies a partnership, endorsement or tenancy that does not exist.`,
        excerpt: term,
      });
    }
  }

  for (const term of OWNERSHIP_CLAIMS) {
    if (lower.includes(term)) {
      issues.push({
        code: "ownership_language",
        severity: "warning",
        message: `Possible ownership claim ("${term}"). Section 2 requires ownership wording to be separately verified and approved.`,
        excerpt: term,
      });
    }
  }

  /* -------------------------------------------------------- salutation */

  if (/dear sir\s*(\/|or|,)?\s*madam/i.test(output.salutation) ||
      /to whom it may concern/i.test(output.salutation)) {
    issues.push({
      code: "generic_salutation",
      severity: context.contactName ? "blocking" : "warning",
      message: context.contactName
        ? `A verified contact name ("${context.contactName}") exists, so a generic salutation is not permitted.`
        : "Generic salutation used. Prefer addressing the company team by name.",
      excerpt: output.salutation,
    });
  }

  /*
   * An honorific the directory never supplied means the model inferred the
   * recipient's gender from their name. The prompt forbids it; this is what
   * catches it when the model does it anyway, which it did on the first real
   * run against "RAVI SHUKLA".
   */
  if (context.contactName && !context.contactHonorific) {
    const invented = /\b(mr|mrs|ms|miss|sir|madam)\.?\s/i.exec(output.salutation);
    if (invented) {
      issues.push({
        code: "invented_honorific",
        severity: "blocking",
        message: `The greeting uses "${invented[1]}" but the directory supplied no title for ${context.contactName}. Addressing someone by an assumed gender is not acceptable; use the full name instead.`,
        excerpt: output.salutation,
      });
    }
  }

  /*
   * Directory entries are stored shouted. Copying that into a greeting or a
   * subject line makes an otherwise careful message read like a mail merge.
   */
  for (const [field, value] of [["salutation", output.salutation], ["subject", output.subject]] as const) {
    const shouted = /\b[A-Z]{2,}(?:\s+[A-Z]{2,})+\b/.exec(value.replace(/\b(ALAM|USD|DFCU|MTN|KCB|UMA|HMH)\b/g, ""));
    if (shouted) {
      issues.push({
        code: "shouted_name",
        severity: "warning",
        message: `The ${field} contains "${shouted[0].trim()}" in capitals, copied from the directory rather than written as a trading name.`,
        excerpt: value,
      });
    }
  }

  /*
   * The body must actually open with the personalized sentence. Gemini
   * returned it in opening_personalization but started the body at paragraph
   * two, producing a message with no stated reason for making contact — the
   * one thing section 7.4 requires every email to have.
   */
  const normalise = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const opening = normalise(output.opening_personalization);
  if (opening.length >= 20 && !normalise(output.body_text).includes(opening.slice(0, 40))) {
    issues.push({
      code: "missing_opening",
      severity: "blocking",
      message: "The body does not open with the personalized sentence, so the message never says why this company is being contacted.",
      excerpt: output.opening_personalization,
    });
  }

  /* ------------------------------------------------------------- length */

  const wordCount = output.body_text.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > context.wordLimit) {
    issues.push({
      code: "over_length",
      severity: "warning",
      message: `Body is ${wordCount} words; the campaign limit is ${context.wordLimit}.`,
    });
  } else if (wordCount < 80) {
    issues.push({
      code: "under_length",
      severity: "warning",
      message: `Body is only ${wordCount} words; section 7.4 expects roughly 120-180.`,
    });
  }

  /* --------------------------------------------------------------- HTML */

  if (HTML_FORBIDDEN.test(output.body_html)) {
    issues.push({
      code: "unsafe_html",
      severity: "blocking",
      message: "Body HTML contains a tag that is not permitted in an email body.",
    });
  }
  if (HTML_EVENT_ATTR.test(output.body_html) || HTML_JS_URL.test(output.body_html)) {
    issues.push({
      code: "unsafe_html",
      severity: "blocking",
      message: "Body HTML contains a script event handler or javascript: URL.",
    });
  }

  /* ---------------------------------------------------------- grounding */

  const unknownEvidence = output.evidence_ids
    .filter((id) => !context.availableEvidenceIds.includes(id));
  if (unknownEvidence.length) {
    issues.push({
      code: "fabricated_evidence",
      severity: "blocking",
      message: `Cited evidence that was never supplied: ${unknownEvidence.join(", ")}.`,
    });
  }

  const unknownFacts = output.facts_used
    .filter((k) => !context.availableFactKeys.includes(k));
  if (unknownFacts.length) {
    issues.push({
      code: "fabricated_fact",
      severity: "blocking",
      message: `Referenced property facts that are not approved: ${unknownFacts.join(", ")}.`,
    });
  }

  if (output.evidence_ids.length === 0) {
    issues.push({
      code: "no_evidence",
      severity: "blocking",
      message: "The draft cites no evidence, so its personalization cannot be audited.",
    });
  }

  /* ----------------------------------------------------------- plain text */

  if (/<[a-z][\s\S]*>/i.test(output.body_text)) {
    issues.push({
      code: "html_in_plaintext",
      severity: "warning",
      message: "The plain-text alternative contains HTML markup.",
    });
  }
  // No check that body_text carries the CTA URL: the generator is told not to
  // write the call to action, because renderEmailText() appends it to every
  // plain-text message. Flagging its absence here would fire on every
  // correctly-generated draft.

  /* ------------------------------------------------------------ verdict */

  const blocking = issues.filter((i) => i.severity === "blocking");
  const modelAskedForReview = output.needs_manual_review;
  const needsManualReview = modelAskedForReview || blocking.length > 0;

  let manualReviewReason: string | null = null;
  if (blocking.length > 0) {
    manualReviewReason = `Automated safety checks raised ${blocking.length} blocking issue(s): ` +
      blocking.map((i) => i.message).join(" ");
  } else if (modelAskedForReview) {
    manualReviewReason = output.manual_review_reason ??
      "The generator flagged this draft for manual review without giving a reason.";
  }

  return {
    issues,
    riskFlags: [...new Set([...output.risk_flags, ...issues.map((i) => i.code)])],
    needsManualReview,
    manualReviewReason,
    wordCount,
  };
}
