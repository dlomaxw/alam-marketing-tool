/**
 * The approved reference email addresses "Mr. Shukla" about "AutoXpress".
 * These tests pin that behaviour, including the cases where guessing would be
 * worse than falling back to the company name.
 */
import { describe, it, expect } from "vitest";
import { shortCompanyName, buildSalutation, buildSubject } from "../naming";

describe("short company name", () => {
  it("produces the trading name used in the approved subject line", () => {
    expect(shortCompanyName("AUTOXPRESS UGANDA LIMITED")).toBe("Autoxpress");
  });

  it("strips legal suffixes", () => {
    expect(shortCompanyName("Spear Motors Ltd.")).toBe("Spear Motors");
    expect(shortCompanyName("Motorcare (U) Ltd")).toBe("Motorcare");
    expect(shortCompanyName("Furniture City Uganda Limited")).toBe("Furniture City");
  });

  it("keeps acronyms uppercase", () => {
    expect(shortCompanyName("DFCU BANK (U) LTD")).toBe("DFCU Bank");
  });

  it("leaves deliberate capitalization alone", () => {
    expect(shortCompanyName("HMH Rainbow Ltd")).toBe("HMH Rainbow");
  });

  it("falls back rather than returning something unrecognisable", () => {
    // Stripping would leave nothing usable here.
    expect(shortCompanyName("Uganda Limited").length).toBeGreaterThan(2);
  });
});

describe("salutation", () => {
  it("uses honorific plus surname, as in the approved example", () => {
    expect(buildSalutation("Mr. Ravi Shukla", "AutoXpress Uganda Limited").salutation)
      .toBe("Dear Mr. Shukla");
  });

  it("adds the honorific full stop consistently", () => {
    expect(buildSalutation("Mr Ravikumar Venkataraman", "Nish Auto Limited").salutation)
      .toBe("Dear Mr. Venkataraman");
  });

  it("uses the full name when no title is supplied", () => {
    // "Dear Kobusinge" reads abruptly, and adding "Ms." would mean guessing
    // the recipient's gender from their name.
    expect(buildSalutation("Rachel Kobusinge", "Biyinzika Poultry Limited").salutation)
      .toBe("Dear Rachel Kobusinge");
  });

  it("normalises shouted directory names", () => {
    expect(buildSalutation("WANJUN WU", "Harmony Bags Industries Ug Limited").salutation)
      .toBe("Dear Wanjun Wu");
  });

  it("addresses the company when a single name could be either part", () => {
    // "Zhang" alone might be a family name or a given name; guessing wrong is
    // more damaging than a company greeting.
    const r = buildSalutation("Zhang", "Backbone Feeds Company Limited");
    expect(r.personal).toBe(false);
    expect(r.salutation).toBe("Dear Backbone Feeds Team");
  });

  it("addresses the company when there is no contact at all", () => {
    const r = buildSalutation(null, "DFCU BANK (U) LTD");
    expect(r.personal).toBe(false);
    expect(r.salutation).toBe("Dear DFCU Bank Team");
  });

  it("never invents an honorific", () => {
    expect(buildSalutation("Rachel Kobusinge", "X Ltd").salutation)
      .not.toMatch(/Mr|Mrs|Ms/);
  });
});

describe("subject line", () => {
  it("matches the approved formula", () => {
    expect(buildSubject("AUTOXPRESS UGANDA LIMITED", "ground", "vehicle_motorcycle"))
      .toBe("A ground-floor showroom opportunity for Autoxpress on Fifth Street");
  });

  it("adapts floor and space type per segment", () => {
    expect(buildSubject("DFCU BANK (U) LTD", "first", "bank_financial"))
      .toBe("A first-floor branch and office space opportunity for DFCU Bank on Fifth Street");
    expect(buildSubject("Kampala Fitness Centre", "second", "wellness_leisure"))
      .toContain("A second-floor destination space opportunity");
  });

  it("stays within a sensible subject length", () => {
    const s = buildSubject("ELSHRIF FURNITURE LIMITED", "first", "furniture_interior");
    expect(s.length).toBeLessThanOrEqual(120);
  });
});
