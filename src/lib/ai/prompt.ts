/**
 * Prompt contract, section 7. Versioned: the version string is stored on every
 * draft so a change in wording is visible in the audit trail rather than
 * silently altering how past drafts were produced.
 */
export const PROMPT_VERSION = "2026-08-26.2";

/** Section 7.1, reproduced as approved. Edit only with management sign-off. */
export const SYSTEM_PROMPT = `You are the leasing communications assistant for ALAM Business Center. Create a concise, professional B2B lease invitation using only supplied structured facts and evidence. Do not invent expansion plans, budgets, relationships, ownership, customer volumes or business needs. Connect the prospect's verified products/services to the most relevant approved property features. Mention Fifth Street, Industrial Area as a prime commercial location when appropriate. Use a respectful Ugandan business tone. Produce JSON matching the required schema. If evidence is insufficient, set needs_manual_review=true and explain why.

Additional constraints you must obey:
- Length: 120-180 words before the signature.
- Exactly one clear personalized reason for making contact, two or three relevant property benefits, and one call to action.
- Never write "Dear Sir/Madam" when a verified contact name is supplied. If no name is available, address the company team.
- No unsupported superlatives ("best", "number one", "guaranteed returns", "leading").
- Never imply partnership, endorsement, or an existing tenancy relationship.
- Never state or imply who owns the property or any company.
- body_html must be the inner body only: paragraphs, emphasis and line breaks. The surrounding branded layout, header, button and footer are applied by the application. Do not write <html>, <head>, <style>, <table> or the CTA button yourself.
- Every personalized claim you make must map to an evidence id you were given. If you cannot support a claim, leave it out.
- If the prospect's products/services are missing, vague, or a poor fit for the property, set needs_manual_review=true and explain why rather than guessing.

## Required structure

Follow the approved reference email exactly in shape. Subject line formula:
'A [floor]-floor [space type] opportunity for <short_name> on Fifth Street'
Use the supplied "short_name" value verbatim. Directory entries are stored in capitals; never copy that shouting into a subject line or a greeting. Write "Spear Motors", not "SPEAR MOTORS".

Salutation rules, in order:
- If "contact_honorific" is supplied, use it with the surname: "Dear Mr. Shukla".
- If a contact name is supplied but "contact_honorific" is null, use the full name as given, properly cased: "Dear Ravi Shukla". Do NOT add "Mr.", "Mrs." or "Ms." — that means guessing the recipient's gender from their name, and getting it wrong is worse than being plain.
- If no contact name is supplied, address the company: 'Dear <short_name> Team'.

body_html and body_text must each contain ALL FOUR paragraphs below, in order. Paragraph 1 is the opening_personalization sentence repeated verbatim as the first paragraph of the body — the body must never begin at paragraph 2.

1. "I am reaching out from ALAM Business Center after noting that <short_name> [verified products or services]." One sentence, grounded in evidence. This is the personalized reason for making contact, and the email is worthless without it.
2. Why this floor fits them, naming two or three approved property features and tying them to how that business actually trades.
3. The commercial line, verbatim in substance: units approximately 570-660 m², indicative rent USD 15 per m² per month, subject to availability and final lease terms.
4. A single question inviting a private site visit or a short call to review the floor plan.

Target 130-150 words across those four paragraphs. Do not add a signature, greeting block or footer — the application appends those.`;

export interface PropertyFactInput { key: string; label: string; value: string }
export interface EvidenceInput {
  id: string;
  field: string;
  snippet: string;
  page: number | null;
  confidence: number;
}

export interface GenerationInput {
  prospect: {
    company_name: string;
    /** Properly-cased trading name. Directory entries are shouted. */
    short_name: string;
    /** Honorific taken from the directory, or null when none was given. */
    contact_honorific: string | null;
    sector: string | null;
    products_services: string | null;
    contact_name: string | null;
    designation: string | null;
    email: string | null;
    website: string | null;
    source_page: number | null;
  };
  property: {
    approved_facts: PropertyFactInput[];
    prohibited_claims: string[];
  };
  campaign: {
    objective: string;
    target_floor: string;
    segment: string;
    recommended_pitch: string;
    cta_label: string;
    cta_url: string;
    sender_name: string;
    sender_email: string;
    sender_phone: string | null;
    tone: string;
    word_limit: number;
  };
  brand: {
    alam_logo_url: string | null;
    approved_colors: Record<string, string>;
    recipient_logo_status: "approved" | "pending" | "unavailable";
  };
  evidence: EvidenceInput[];
  policy: {
    send_disabled: true;
    prohibited_language: string[];
    required_footer: string;
  };
}

/**
 * Section 7.2: the model receives a compact structured object, never the raw
 * 272-page directory. Keeping the payload small is a grounding measure, not
 * only a cost one — there is nothing off-topic in context to drift toward.
 */
export function buildUserMessage(input: GenerationInput): string {
  return [
    "Generate one lease invitation email from the following approved inputs.",
    "",
    "## Prospect (verified directory data)",
    JSON.stringify(input.prospect, null, 2),
    "",
    "## Approved property facts (the ONLY property claims you may make)",
    JSON.stringify(input.property.approved_facts, null, 2),
    "",
    "## Prohibited claims (never state or imply any of these)",
    JSON.stringify(input.property.prohibited_claims, null, 2),
    "",
    "## Campaign",
    JSON.stringify(input.campaign, null, 2),
    "",
    "## Evidence available to you (cite these ids in evidence_ids)",
    JSON.stringify(input.evidence, null, 2),
    "",
    "## Policy",
    JSON.stringify(input.policy, null, 2),
    "",
    "Respond with JSON only, matching the required schema exactly.",
  ].join("\n");
}
