import { z } from "zod";

/**
 * Required output schema, section 7.3. Generation that does not parse against
 * this is discarded rather than repaired: a malformed response is a signal
 * the model was not grounded, not something to paper over.
 */
export const generationOutputSchema = z.object({
  subject: z.string().min(8).max(140),
  preview_text: z.string().max(160),
  salutation: z.string().min(2).max(120),
  opening_personalization: z.string().min(10).max(600),
  body_html: z.string().min(40),
  body_text: z.string().min(40),
  primary_cta_label: z.string().min(3).max(60),
  primary_cta_url: z.string().url(),
  /** Property fact keys the copy actually relies on. */
  facts_used: z.array(z.string()).default([]),
  /** Ids from the evidence bundle supporting each personalized claim. */
  evidence_ids: z.array(z.string()).default([]),
  risk_flags: z.array(z.string()).default([]),
  needs_manual_review: z.boolean(),
  manual_review_reason: z.string().nullable().default(null),
});

export type GenerationOutput = z.infer<typeof generationOutputSchema>;

/**
 * Response schema for Gemini's structured output mode.
 *
 * Gemini accepts a subset of OpenAPI, not full JSON Schema: no
 * `additionalProperties`, and a nullable field is `nullable: true` rather than
 * a union type. Without this the model returns valid JSON of the wrong shape —
 * it was silently omitting preview_text, body_text and the CTA fields.
 *
 * `propertyOrdering` matters: the model generates in this order, so the
 * grounded fields come before the prose that depends on them.
 */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    subject: { type: "STRING", description: "Subject line. No emoji, no ALL CAPS." },
    preview_text: { type: "STRING", description: "Inbox preview line, under 160 characters." },
    salutation: { type: "STRING", description: "e.g. 'Dear Mr. Shukla' or 'Dear AutoXpress Team'. No trailing comma." },
    opening_personalization: { type: "STRING", description: "One sentence tying verified products/services to the property." },
    body_html: { type: "STRING", description: "Inner body only, as <p> paragraphs. No html/head/style/table tags, no signature, no CTA button." },
    body_text: { type: "STRING", description: "Plain-text version of the same four paragraphs. No signature, no CTA." },
    primary_cta_label: { type: "STRING" },
    primary_cta_url: { type: "STRING" },
    facts_used: { type: "ARRAY", items: { type: "STRING" }, description: "Property fact keys relied on." },
    evidence_ids: { type: "ARRAY", items: { type: "STRING" }, description: "Evidence ids supporting personalized claims." },
    risk_flags: { type: "ARRAY", items: { type: "STRING" } },
    needs_manual_review: { type: "BOOLEAN" },
    manual_review_reason: { type: "STRING", nullable: true },
  },
  required: [
    "subject", "preview_text", "salutation", "opening_personalization",
    "body_html", "body_text", "primary_cta_label", "primary_cta_url",
    "facts_used", "evidence_ids", "risk_flags", "needs_manual_review",
  ],
  propertyOrdering: [
    "facts_used", "evidence_ids", "subject", "preview_text", "salutation",
    "opening_personalization", "body_html", "body_text",
    "primary_cta_label", "primary_cta_url",
    "risk_flags", "needs_manual_review", "manual_review_reason",
  ],
} as const;

/** JSON Schema handed to the model so it emits the right shape first time. */
export const GENERATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "subject", "preview_text", "salutation", "opening_personalization",
    "body_html", "body_text", "primary_cta_label", "primary_cta_url",
    "facts_used", "evidence_ids", "risk_flags",
    "needs_manual_review", "manual_review_reason",
  ],
  properties: {
    subject: { type: "string", description: "Email subject line. No emoji, no ALL CAPS." },
    preview_text: { type: "string", description: "Inbox preview line, under 160 characters." },
    salutation: { type: "string", description: "e.g. 'Dear Ms Nakato' or 'Dear AutoXpress Uganda Limited Team'." },
    opening_personalization: {
      type: "string",
      description: "One sentence tying the verified products/services to the property. Must be supported by evidence.",
    },
    body_html: { type: "string", description: "Inner HTML of the message body only. No <html>, <head> or <style> tags." },
    body_text: { type: "string", description: "Complete plain-text alternative carrying the same facts and CTA." },
    primary_cta_label: { type: "string" },
    primary_cta_url: { type: "string" },
    facts_used: { type: "array", items: { type: "string" }, description: "Property fact keys relied on." },
    evidence_ids: { type: "array", items: { type: "string" }, description: "Evidence ids supporting personalized claims." },
    risk_flags: { type: "array", items: { type: "string" }, description: "Anything a reviewer should look at closely." },
    needs_manual_review: { type: "boolean" },
    manual_review_reason: { type: ["string", "null"] },
  },
} as const;
