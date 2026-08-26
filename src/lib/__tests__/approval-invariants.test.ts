/**
 * Acceptance tests for the approval invariants, specification section 16.
 *
 * These cover the pure logic — hashing, the state machine, RBAC and the
 * generation safety checks — with no database. The point is that the rules
 * that make sending safe are testable in isolation and cannot drift.
 */
import { describe, it, expect } from "vitest";
import { computeContentHash, hashesMatch, type HashableDraft } from "../content-hash";
import { canTransition, availableActions, NON_SENDABLE } from "../draft-state";
import { ROLE_PERMISSIONS, MFA_REQUIRED_PERMISSIONS } from "../auth/rbac";
import { validateGeneration } from "../ai/validate";
import { classifyProspect, scoreProspect, dedupeKey } from "../scoring";
import { sanitizeBodyHtml } from "../email/template";
import type { GenerationOutput } from "../ai/schema";

const baseDraft: HashableDraft = {
  subject: "AutoXpress Uganda Limited: showroom opportunity on Fifth Street",
  previewText: "A brief note about space at ALAM Business Center.",
  salutation: "Dear Mr Ravi Shukla",
  bodyHtml: "<p>The UMA directory lists AutoXpress Uganda Limited as a supplier of tyres.</p>",
  bodyText: "The UMA directory lists AutoXpress Uganda Limited as a supplier of tyres.",
  ctaLabel: "Schedule a Private Site Visit",
  ctaUrl: "https://example.com/visit",
  recipientEmail: "ravi.shukla@auxpug.com",
  recipientLogoAssetId: null,
};

describe("content hash", () => {
  it("is stable for identical content", () => {
    expect(computeContentHash(baseDraft)).toBe(computeContentHash({ ...baseDraft }));
  });

  it("changes when any deliverable field changes", () => {
    const original = computeContentHash(baseDraft);
    const fields: (keyof HashableDraft)[] = [
      "subject", "previewText", "salutation", "bodyHtml",
      "bodyText", "ctaLabel", "ctaUrl", "recipientEmail",
    ];
    for (const field of fields) {
      const mutated = { ...baseDraft, [field]: `${baseDraft[field]} changed` };
      expect(computeContentHash(mutated), `field ${field} must affect the hash`)
        .not.toBe(original);
    }
  });

  it("cannot be spoofed by shifting text between fields", () => {
    // Without length-prefixing, "a|b" in one field could collide with "a" and
    // "b" in two adjacent fields.
    const a = computeContentHash({ ...baseDraft, subject: "ab", previewText: "" });
    const b = computeContentHash({ ...baseDraft, subject: "a", previewText: "b" });
    expect(a).not.toBe(b);
  });

  it("treats a changed recipient as a different message", () => {
    const other = { ...baseDraft, recipientEmail: "someone.else@example.com" };
    expect(computeContentHash(other)).not.toBe(computeContentHash(baseDraft));
  });

  it("compares hashes safely", () => {
    const h = computeContentHash(baseDraft);
    expect(hashesMatch(h, h)).toBe(true);
    expect(hashesMatch(h, h.slice(0, -1) + "0")).toBe(false);
    expect(hashesMatch(h, "")).toBe(false);
  });
});

describe("draft state machine", () => {
  const approver = { permissions: [...ROLE_PERMISSIONS.Administrator] };
  const agent = { permissions: [...ROLE_PERMISSIONS["Sales Agent"]] };
  const reviewer = { permissions: [...ROLE_PERMISSIONS.Reviewer] };

  it("refuses to send an unapproved draft", () => {
    for (const status of ["draft", "needs_review", "rejected"] as const) {
      expect(canTransition(status, "queue", approver).allowed).toBe(false);
    }
  });

  it("only allows queueing from approved", () => {
    expect(canTransition("approved", "queue", approver).allowed).toBe(true);
  });

  it("returns an approved draft to draft status when edited", () => {
    const t = canTransition("approved", "edit", approver);
    expect(t.allowed).toBe(true);
    expect(t.to).toBe("draft");
  });

  it("stops a Sales Agent approving or sending", () => {
    expect(canTransition("needs_review", "approve", agent).allowed).toBe(false);
    expect(canTransition("approved", "queue", agent).allowed).toBe(false);
  });

  it("lets a Reviewer approve but not send", () => {
    expect(canTransition("needs_review", "approve", reviewer).allowed).toBe(true);
    expect(canTransition("approved", "queue", reviewer).allowed).toBe(false);
  });

  it("never auto-resends after a failure or bounce", () => {
    expect(availableActions("failed", approver)).toHaveLength(0);
    expect(availableActions("bounced", approver)).toHaveLength(0);
    expect(availableActions("replied", approver)).toHaveLength(0);
  });

  it("reserves delivery outcomes for the system", () => {
    expect(canTransition("queued", "mark_sent", approver).allowed).toBe(false);
    expect(canTransition("queued", "mark_sent", { ...approver, isSystem: true }).allowed).toBe(true);
  });

  it("treats every unapproved status as non-sendable", () => {
    for (const s of ["draft", "needs_review", "rejected", "sent", "failed", "bounced", "replied"] as const) {
      expect(NON_SENDABLE.has(s)).toBe(true);
    }
    expect(NON_SENDABLE.has("approved")).toBe(false);
  });
});

describe("roles and permissions", () => {
  it("separates approve from send", () => {
    expect(ROLE_PERMISSIONS.Reviewer).toContain("draft:approve");
    expect(ROLE_PERMISSIONS.Reviewer).not.toContain("email:send");
  });

  it("gives a Sales Agent neither", () => {
    expect(ROLE_PERMISSIONS["Sales Agent"]).not.toContain("draft:approve");
    expect(ROLE_PERMISSIONS["Sales Agent"]).not.toContain("email:send");
  });

  it("gives a Viewer no write capability at all", () => {
    for (const p of ROLE_PERMISSIONS.Viewer) {
      expect(p.endsWith(":read")).toBe(true);
    }
  });

  it("requires MFA for approval and sending", () => {
    expect(MFA_REQUIRED_PERMISSIONS.has("draft:approve")).toBe(true);
    expect(MFA_REQUIRED_PERMISSIONS.has("email:send")).toBe(true);
    expect(MFA_REQUIRED_PERMISSIONS.has("settings:manage")).toBe(true);
  });

  it("does not let a Campaign Manager approve by default", () => {
    expect(ROLE_PERMISSIONS["Campaign Manager"]).not.toContain("draft:approve");
  });
});

/* ------------------------------------------------------ generation safety */

const goodOutput: GenerationOutput = {
  subject: "AutoXpress Uganda Limited: showroom space on Fifth Street",
  preview_text: "Ground-floor showroom space in Kampala's Industrial Area.",
  salutation: "Dear Mr Ravi Shukla",
  opening_personalization: "The UMA directory lists AutoXpress Uganda Limited as a supplier of tyres, oil and batteries.",
  body_html: "<p>Hello</p>",
  // The body must open with opening_personalization; the validator enforces it.
  body_text: "The UMA directory lists AutoXpress Uganda Limited as a supplier of tyres, oil and batteries. "
    + Array(110).fill("word").join(" "),
  primary_cta_label: "Schedule a Private Site Visit",
  primary_cta_url: "https://example.com/visit",
  facts_used: ["unit_range", "indicative_rent"],
  evidence_ids: ["ev_products"],
  risk_flags: [],
  needs_manual_review: false,
  manual_review_reason: null,
};

const context = {
  contactName: "Mr Ravi Shukla",
  contactHonorific: "Mr.",
  wordLimit: 180,
  availableEvidenceIds: ["ev_products", "ev_sector"],
  availableFactKeys: ["unit_range", "indicative_rent", "location"],
  prohibitedClaims: [
    { pattern: "guaranteed returns", reason: "Financial guarantees are never permitted.", isRegex: false },
    { pattern: "\\bowns\\b", reason: "Ownership language requires separate approval.", isRegex: true },
  ],
};

describe("generation safety checks", () => {
  it("passes a clean, grounded draft", () => {
    const r = validateGeneration(goodOutput, context);
    expect(r.needsManualReview).toBe(false);
    expect(r.issues.filter((i) => i.severity === "blocking")).toHaveLength(0);
  });

  it("blocks unsupported superlatives", () => {
    const r = validateGeneration(
      { ...goodOutput, body_text: `${goodOutput.body_text} We are the best in Kampala.` },
      context,
    );
    expect(r.needsManualReview).toBe(true);
    expect(r.issues.some((i) => i.code === "unsupported_superlative")).toBe(true);
  });

  it("blocks a configured prohibited claim", () => {
    const r = validateGeneration(
      { ...goodOutput, body_text: `${goodOutput.body_text} We offer guaranteed returns.` },
      context,
    );
    expect(r.issues.some((i) => i.code === "prohibited_claim")).toBe(true);
    expect(r.needsManualReview).toBe(true);
  });

  it("blocks language implying a partnership", () => {
    const r = validateGeneration(
      { ...goodOutput, body_text: `${goodOutput.body_text} As our partner you already benefit.` },
      context,
    );
    expect(r.issues.some((i) => i.code === "implied_relationship")).toBe(true);
  });

  it("blocks a generic salutation when a contact name is known", () => {
    const r = validateGeneration({ ...goodOutput, salutation: "Dear Sir/Madam" }, context);
    const issue = r.issues.find((i) => i.code === "generic_salutation");
    expect(issue?.severity).toBe("blocking");
  });

  it("allows a generic salutation when no contact name exists", () => {
    const r = validateGeneration(
      { ...goodOutput, salutation: "Dear Sir/Madam" },
      { ...context, contactName: null },
    );
    expect(r.issues.find((i) => i.code === "generic_salutation")?.severity).toBe("warning");
  });

  it("blocks a body that omits the personalized opening", () => {
    // Gemini did this on the first real run: it returned a correct
    // opening_personalization and then started the body at paragraph two, so
    // the message never said why the company was being contacted.
    const r = validateGeneration(
      { ...goodOutput, body_text: Array(120).fill("word").join(" ") },
      context,
    );
    expect(r.issues.some((i) => i.code === "missing_opening")).toBe(true);
    expect(r.needsManualReview).toBe(true);
  });

  it("blocks an honorific the directory never supplied", () => {
    // Gemini did exactly this on the first real run: the directory gave
    // "RAVI SHUKLA" with no title and the model wrote "Dear Mr. Shukla",
    // inferring gender from the name despite the prompt forbidding it.
    const r = validateGeneration(
      { ...goodOutput, salutation: "Dear Mr. Shukla" },
      { ...context, contactName: "RAVI SHUKLA", contactHonorific: null },
    );
    expect(r.issues.some((i) => i.code === "invented_honorific")).toBe(true);
    expect(r.needsManualReview).toBe(true);
  });

  it("allows an honorific the directory did supply", () => {
    const r = validateGeneration(
      { ...goodOutput, salutation: "Dear Mr. Shukla" },
      { ...context, contactName: "Mr. Ravi Shukla", contactHonorific: "Mr." },
    );
    expect(r.issues.some((i) => i.code === "invented_honorific")).toBe(false);
  });

  it("flags a shouted directory name copied into the greeting", () => {
    const r = validateGeneration(
      { ...goodOutput, salutation: "Dear SPEAR MOTORS Team" },
      { ...context, contactName: null, contactHonorific: null },
    );
    expect(r.issues.some((i) => i.code === "shouted_name")).toBe(true);
  });

  it("does not flag legitimate acronyms as shouting", () => {
    const r = validateGeneration(
      { ...goodOutput, subject: "A first-floor opportunity for DFCU Bank on Fifth Street" },
      { ...context, contactName: null, contactHonorific: null },
    );
    expect(r.issues.some((i) => i.code === "shouted_name")).toBe(false);
  });

  it("blocks evidence the model was never given", () => {
    const r = validateGeneration({ ...goodOutput, evidence_ids: ["ev_invented"] }, context);
    expect(r.issues.some((i) => i.code === "fabricated_evidence")).toBe(true);
    expect(r.needsManualReview).toBe(true);
  });

  it("blocks property facts that are not approved", () => {
    const r = validateGeneration({ ...goodOutput, facts_used: ["rooftop_helipad"] }, context);
    expect(r.issues.some((i) => i.code === "fabricated_fact")).toBe(true);
  });

  it("blocks a draft that cites no evidence at all", () => {
    const r = validateGeneration({ ...goodOutput, evidence_ids: [] }, context);
    expect(r.issues.some((i) => i.code === "no_evidence")).toBe(true);
  });

  it("blocks script content in the body HTML", () => {
    const r = validateGeneration(
      { ...goodOutput, body_html: '<p onclick="steal()">Hello</p>' },
      context,
    );
    expect(r.issues.some((i) => i.code === "unsafe_html")).toBe(true);
  });

  it("honours the model asking for review even when nothing else trips", () => {
    const r = validateGeneration(
      { ...goodOutput, needs_manual_review: true, manual_review_reason: "Products/services text was vague." },
      context,
    );
    expect(r.needsManualReview).toBe(true);
    expect(r.manualReviewReason).toContain("vague");
  });

  it("does not silently ignore a malformed prohibited-claim pattern", () => {
    const r = validateGeneration(goodOutput, {
      ...context,
      prohibitedClaims: [{ pattern: "([unclosed", reason: "bad", isRegex: true }],
    });
    expect(r.issues.some((i) => i.code === "prohibited_pattern_invalid")).toBe(true);
  });
});

describe("email body sanitization", () => {
  it("strips script and style blocks", () => {
    const dirty = '<p>ok</p><script>alert(1)</script><style>p{}</style>';
    const clean = sanitizeBodyHtml(dirty);
    expect(clean).not.toMatch(/<script|<style/i);
    expect(clean).toContain("<p>ok</p>");
  });

  it("strips event handlers and javascript URLs", () => {
    const clean = sanitizeBodyHtml('<a href="javascript:evil()" onmouseover="x()">link</a>');
    expect(clean).not.toMatch(/onmouseover/i);
    expect(clean).not.toMatch(/javascript:/i);
  });
});

/* ------------------------------------------------ segmentation and scoring */

describe("segmentation", () => {
  it("routes a tyre supplier to the ground floor", () => {
    const c = classifyProspect({
      companyName: "AUTOXPRESS UGANDA LIMITED",
      sector: null,
      productsServices: "Supply of automotive products (tyres, oil, batteries)",
    });
    expect(c.segment).toBe("vehicle_motorcycle");
    expect(c.floor).toBe("ground");
  });

  it("routes a furniture company to the first floor", () => {
    const c = classifyProspect({
      companyName: "FURNITURE CITY UGANDA LIMITED",
      sector: null,
      productsServices: "Foam mattresses and household furniture",
    });
    expect(c.segment).toBe("furniture_interior");
    expect(c.floor).toBe("first");
  });

  it("routes a bank to the first floor", () => {
    const c = classifyProspect({
      companyName: "DFCU BANK (U) LTD",
      sector: null,
      productsServices: "Financial Services",
    });
    expect(c.segment).toBe("bank_financial");
  });

  it("routes a gym to the second floor", () => {
    const c = classifyProspect({
      companyName: "KAMPALA FITNESS CENTRE",
      sector: null,
      productsServices: "Gym and wellness services",
    });
    expect(c.floor).toBe("second");
  });

  it("leaves an unclear business unclassified rather than guessing", () => {
    const c = classifyProspect({
      companyName: "SOMETHING VAGUE LIMITED",
      sector: null,
      productsServices: "General trading",
    });
    expect(c.segment).toBe("unclassified");
    expect(c.floor).toBe("unassigned");
  });

  it("does not classify a poultry producer as a corporate headquarters", () => {
    // A manufacturers' directory makes generic words like "industries" useless
    // as a signal; this guards the narrowed rule from being widened again.
    const c = classifyProspect({
      companyName: "BIYINZIKA POULTRY INTERNATIONAL LIMITED",
      sector: null,
      productsServices: "Poultry feed, day old chicks, animal feeds",
    });
    expect(c.segment).not.toBe("corporate_hq");
  });
});

describe("relevance scoring", () => {
  const classification = classifyProspect({
    companyName: "AUTOXPRESS UGANDA LIMITED",
    sector: null,
    productsServices: "tyres, oil and batteries, automotive",
  });

  it("scores a complete Kampala prospect highly", () => {
    const s = scoreProspect({
      classification,
      contact: { fullName: "Ravi Shukla", designation: "Managing Director", email: "r@auxpug.com", phone: "0772000000" },
      website: "https://auxpug.com",
      address: "Plot 1, Industrial Area, Kampala",
      strategicRelationship: null,
    });
    expect(s.total).toBeGreaterThanOrEqual(80);
    expect(s.band).toBe("priority");
  });

  it("penalises a prospect with no contact email", () => {
    const s = scoreProspect({
      classification,
      contact: { fullName: "Ravi Shukla", designation: null, email: null, phone: null },
      website: null,
      address: null,
      strategicRelationship: null,
    });
    expect(s.total).toBeLessThan(60);
    expect(s.rationale.join(" ")).toContain("cannot be sent");
  });

  it("never infers a strategic relationship on its own", () => {
    const s = scoreProspect({
      classification,
      contact: { fullName: "Abid Alam", designation: "Director", email: "a@example.com", phone: null },
      website: null,
      address: "Kampala",
      strategicRelationship: null,
    });
    // Section 5.4: a relationship score must never come from a surname.
    expect(s.breakdown.strategicRelationship).toBe(0);
  });

  it("caps the total at 100", () => {
    const s = scoreProspect({
      classification,
      contact: { fullName: "A B", designation: "MD", email: "a@b.com", phone: "077" },
      website: "https://x.com",
      address: "Industrial Area, Kampala",
      strategicRelationship: { points: 50, reason: "Existing group relationship" },
    });
    expect(s.total).toBeLessThanOrEqual(100);
  });
});

describe("deduplication", () => {
  it("matches the same company written differently", () => {
    expect(dedupeKey("Spear Motors Ltd")).toBe(dedupeKey("SPEAR MOTORS LIMITED"));
    expect(dedupeKey("Motorcare (U) Ltd")).toBe(dedupeKey("MOTORCARE UGANDA LTD"));
  });

  it("keeps genuinely different companies apart", () => {
    expect(dedupeKey("Nish Auto Limited")).not.toBe(dedupeKey("Nile Auto Limited"));
  });
});
