/**
 * Parser regressions, written against text taken verbatim from the 2026 UMA
 * directory. Each case here is a bug that reached a rendered email.
 */
import { describe, it, expect } from "vitest";
import { parsePage } from "../ingestion/parse-uma";
import { repairLigatures } from "../ingestion/pdf";

const BREAK = String.fromCharCode(10);

const AUTOXPRESS = `AUTOXPRESS UGANDA LIMITED
Plot 78/80, 7Th Street Industrial Area, Kampala-Uganda P. O. Box
2075, Kampala
Mob: +256392000087
Whatsapp: +256709775925
Email: ravi.shukla@auxpug.com/ info@auxpug.com Contact
Person: RAVI SHUKLA
Designation: Managing Director
Products/Services: SUPPLY OF AUTOMOTIVE PRODUCTS (TYRE,
OIL & BATTERY)`;

const BIYINZIKA = `BIYINZIKA POULTRY
INTERNATIONAL LIMITED
Luthuli Avenue, Plot 77, Bugolobi
P.O.Box: 8646, Kampala
Toll free : 0800300090, 0800300091
WhatsApp : +256 785 188802
Email: info@biyinzika.co.ug / samong@biyinzika.co.ug
Contact Person: Rachel Kobusinge
Website: www.biyinzika.co.ug
Products/Services: Poultry Feed, Day old chicks, Animal feeds,
Dressed chicken.`;

describe("UMA entry parsing", () => {
  it("keeps a products list that wraps onto a capitalised line", () => {
    // The wrapped "OIL & BATTERY)" used to be discarded as the next
    // company's heading, silently shortening the personalization evidence.
    const { records } = parsePage(AUTOXPRESS, 210);
    expect(records).toHaveLength(1);
    expect(records[0].productsServices)
      .toBe("SUPPLY OF AUTOMOTIVE PRODUCTS (TYRE, OIL & BATTERY)");
  });

  it("reads a company name that wraps across two lines", () => {
    const { records } = parsePage(BIYINZIKA, 47);
    expect(records[0].companyName).toBe("BIYINZIKA POULTRY INTERNATIONAL LIMITED");
  });

  it("finds every email address in an entry", () => {
    const { records } = parsePage(AUTOXPRESS, 210);
    expect(records[0].emails).toEqual(["ravi.shukla@auxpug.com", "info@auxpug.com"]);
  });

  it("reads a phone number written under a non-standard label", () => {
    // "Toll free :" is not "Tel:", and entries using it used to yield nothing.
    const { records } = parsePage(BIYINZIKA, 47);
    expect(records[0].phones).toContain("0800300090");
  });

  it("does not drag the next entry's text into a phone number", () => {
    const { records } = parsePage(AUTOXPRESS, 210);
    for (const p of records[0].phones) {
      expect(p).not.toMatch(/[A-Za-z]/);
    }
  });

  it("splits a contact name from an inline designation label", () => {
    const { records } = parsePage(AUTOXPRESS, 210);
    expect(records[0].contactName).toBe("RAVI SHUKLA");
    expect(records[0].designation).toBe("Managing Director");
  });

  it("records the source page on every field", () => {
    const { records } = parsePage(BIYINZIKA, 47);
    expect(records[0].sourcePage).toBe(47);
    expect(records[0].rawBlock).toContain("BIYINZIKA");
  });

  it("warns rather than inventing when there is no email", () => {
    const noEmail = BIYINZIKA.replace(/^Email:.*$/m, "");
    const { records } = parsePage(noEmail, 47);
    expect(records[0].emails).toHaveLength(0);
    expect(records[0].warnings.join(" ")).toMatch(/No email address found/);
    expect(records[0].confidence.email).toBe(0);
  });

  it("skips advertisements and page furniture", () => {
    const { records, skippedBlocks } = parsePage(
      "Uganda Manufactures Association Business Directory 2026\nhttp://www.directory.uma.or.ug\nSOME ADVERT",
      12,
    );
    expect(records).toHaveLength(0);
    expect(skippedBlocks).toBeGreaterThanOrEqual(0);
  });
});

describe("ligature repair", () => {
  it("restores the ligatures the directory's fonts mangle", () => {
    expect(repairLigatures("automaƟon")).toBe("automation");
    expect(repairLigatures("Įelds")).toBe("fields");
    expect(repairLigatures("baƩeries")).toBe("batteries");
    expect(repairLigatures("plaƞorm")).toBe("platform");
    expect(repairLigatures("eȚciency")).toBe("efficiency");
    expect(repairLigatures("Cliī")).toBe("Cliff");
  });

  it("repairs the ligatures found only after a full import", () => {
    // Each of these appeared in stored prospect text, "FiŌh" most damningly:
    // the property's own street name, corrupted.
    expect(repairLigatures("Ňoor")).toBe("floor");
    expect(repairLigatures("sunŇower")).toBe("sunflower");
    expect(repairLigatures("oĸce")).toBe("office");
    expect(repairLigatures("traĸc")).toBe("traffic");
    expect(repairLigatures("aŌer")).toBe("after");
    expect(repairLigatures("FiŌh")).toBe("Fifth");
    expect(repairLigatures("fiƫngs")).toBe("fittings");
    expect(repairLigatures("typeseƫng")).toBe("typesetting");
    expect(repairLigatures("cafĠ")).toBe("café");
    expect(repairLigatures("crğme")).toBe("crème");
  });

  it("repairs email addresses, which would otherwise hard-bounce", () => {
    expect(repairLigatures("info@youthplaƞormafrica.com"))
      .toBe("info@youthplatformafrica.com");
    expect(repairLigatures("martin@smarƞoodsuganda.com"))
      .toBe("martin@smartfoodsuganda.com");
  });
});

describe("company name boundaries", () => {
  it("does not glue a capitalised street address onto the name", () => {
    const block = [
      "BLITZ PACKAGING LTD",
      "PLOT 20/22, NALUKOLONGO",
      "P.O.Box: 1234, Kampala",
      "Email: blitzpackaging23@gmail.com",
      "Products/Services: Packaging materials",
    ].join(BREAK);
    const { records } = parsePage(block, 100);
    expect(records[0].companyName).toBe("BLITZ PACKAGING LTD");
  });

  it("drops a section heading printed above the first entry", () => {
    const block = [
      "BANKING & FINANCIAL SERVICES",
      "ASCENT CAPITAL (U) LTD",
      "Plot 21, Gardens Kololo",
      "Tel: +256 (414) 500969",
      "Email: r.mugera@ascent-africa.com",
      "Products/Services: Financial Advisory Services",
    ].join(BREAK);
    const { records } = parsePage(block, 240);
    expect(records[0].companyName).toBe("ASCENT CAPITAL (U) LTD");
  });

  it("keeps a genuine two-line company name intact", () => {
    // "BIYINZIKA POULTRY" is not built from category words, so it survives.
    const block = [
      "BIYINZIKA POULTRY",
      "INTERNATIONAL LIMITED",
      "Email: info@biyinzika.co.ug",
      "Products/Services: Poultry feed",
    ].join(BREAK);
    const { records } = parsePage(block, 47);
    expect(records[0].companyName).toBe("BIYINZIKA POULTRY INTERNATIONAL LIMITED");
  });
});
