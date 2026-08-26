/**
 * Seeds roles, the locked property-facts record, prohibited claims, default
 * settings and a first administrator.
 *
 * Idempotent: safe to re-run. Property facts are seeded as *unapproved*, so
 * generation cannot use them until a named administrator approves them in the
 * UI. Section 2 requires management verification before production launch, and
 * seeding them pre-approved would quietly skip that step.
 */
import { eq, sql } from "drizzle-orm";
import { db, pool } from "./index";
import {
  roles, users, propertyFacts, prohibitedClaims, settings, campaigns,
} from "./schema";
import { ROLE_PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_NAMES } from "@/lib/auth/rbac";
import { hashPassword, checkPasswordStrength } from "@/lib/auth/password";
import { SETTING_DEFAULTS } from "@/lib/settings";

/** Section 2. Values are as supplied; approval is a separate human act. */
const PROPERTY_FACTS: { key: string; label: string; value: string }[] = [
  { key: "property_name", label: "Property", value: "ALAM Business Center" },
  { key: "location", label: "Location", value: "Plots 98-99, Fifth Street, Industrial Area, Kampala" },
  { key: "positioning", label: "Positioning", value: "Prime commercial location in Kampala's Industrial Area" },
  { key: "lettable_space", label: "Total lettable space", value: "Approximately 4,940 m² (Phase One)" },
  { key: "units", label: "Units", value: "Eight showrooms / commercial units" },
  { key: "unit_range", label: "Unit range", value: "Approximately 570-660 m²" },
  { key: "architecture", label: "Architecture", value: "Six-metre floor-to-floor heights and fully glazed frontage" },
  { key: "parking_access", label: "Parking and access", value: "31 parking bays, separate vehicle entry and two service lifts" },
  { key: "indicative_rent", label: "Indicative rent", value: "USD 15 per m² per month" },
  { key: "ground_floor_fit", label: "Ground-floor fit", value: "Vehicle and motorcycle dealerships, supermarkets and appliances" },
  { key: "first_floor_fit", label: "First-floor fit", value: "Corporate headquarters, banks, furniture and interior showrooms" },
  { key: "second_floor_fit", label: "Second-floor fit", value: "Hospitality, wellness and leisure uses, including gyms, spas and nightclubs" },
];

/**
 * Section 2 leadership statement and section 7.4 constraints, enforced by
 * src/lib/ai/validate.ts against every generated draft.
 */
const PROHIBITED: { pattern: string; reason: string; isRegex: boolean }[] = [
  {
    pattern: "(abid\\s+alam|alam\\s+group)[^.]{0,80}\\b(owns|owner|owned|proprietor)\\b",
    reason: "Ownership language about H.E. Abid Alam or the Alam Group is not verified or approved (section 2).",
    isRegex: true,
  },
  {
    pattern: "\\b(guaranteed|assured)\\s+(returns?|profits?|occupancy|tenants?)\\b",
    reason: "Financial guarantees are never permitted in leasing outreach.",
    isRegex: true,
  },
  {
    pattern: "\\brent[- ]free\\b|\\bfree\\s+rent\\b|\\bdiscount(ed)?\\s+rent\\b",
    reason: "Commercial terms beyond the approved indicative rent require management approval.",
    isRegex: true,
  },
  {
    pattern: "\\balready\\s+(a\\s+)?tenant\\b|\\byour\\s+(current\\s+)?(unit|lease)\\s+at\\b",
    reason: "Implies an existing tenancy that does not exist.",
    isRegex: true,
  },
  {
    pattern: "\\bfully\\s+(let|occupied|leased)\\b|\\blast\\s+remaining\\s+unit\\b",
    reason: "Availability claims must come from the verified property facts, not urgency framing.",
    isRegex: true,
  },
  {
    pattern: "we know your business is expanding",
    reason: "Asserts a business circumstance that has not been verified (section 7.1).",
    isRegex: false,
  },
];

async function seedRoles() {
  for (const name of ROLE_NAMES) {
    await db.insert(roles)
      .values({
        name,
        description: ROLE_DESCRIPTIONS[name],
        permissions: ROLE_PERMISSIONS[name],
        isSystem: true,
      })
      .onConflictDoUpdate({
        target: roles.name,
        // Keep permissions in step with the code as the vocabulary evolves.
        set: { permissions: ROLE_PERMISSIONS[name], description: ROLE_DESCRIPTIONS[name] },
      });
  }
  console.log(`  roles:            ${ROLE_NAMES.length} upserted`);
}

async function seedPropertyFacts() {
  let inserted = 0;
  for (const fact of PROPERTY_FACTS) {
    const [existing] = await db.select().from(propertyFacts)
      .where(eq(propertyFacts.key, fact.key)).limit(1);
    if (existing) continue;
    await db.insert(propertyFacts).values({
      ...fact,
      notes: "Seeded from the approved development specification, section 2. Requires management verification before production use.",
    });
    inserted++;
  }
  console.log(`  property facts:   ${inserted} inserted (UNAPPROVED until an admin signs them off)`);
}

async function seedProhibited() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(prohibitedClaims);
  if (count > 0) {
    console.log(`  prohibited claims: ${count} already present, skipped`);
    return;
  }
  await db.insert(prohibitedClaims).values(PROHIBITED);
  console.log(`  prohibited claims: ${PROHIBITED.length} inserted`);
}

async function seedSettings() {
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    // `value` is a NOT NULL jsonb column, and a JS null becomes SQL NULL
    // rather than JSON null. Settings whose default is "unset" simply get no
    // row; getSetting() falls back to the default when the row is absent.
    if (value === null) continue;
    await db.insert(settings)
      .values({ key, value: value as never })
      .onConflictDoNothing({ target: settings.key });
  }
  console.log(`  settings:         defaults ensured (global send OFF)`);
}

async function seedAdmin(): Promise<string | null> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.log("  admin:            skipped (set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD)");
    return null;
  }

  const strength = checkPasswordStrength(password);
  if (!strength.ok) {
    throw new Error(`SEED_ADMIN_PASSWORD is too weak: ${strength.problems.join(" ")}`);
  }

  const [existing] = await db.select().from(users)
    .where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing) {
    console.log(`  admin:            ${email} already exists`);
    return existing.id;
  }

  const [adminRole] = await db.select().from(roles)
    .where(eq(roles.name, "Administrator")).limit(1);

  const [created] = await db.insert(users).values({
    name: process.env.SEED_ADMIN_NAME ?? "Administrator",
    email: email.toLowerCase(),
    passwordHash: await hashPassword(password),
    roleId: adminRole.id,
    status: "active",
  }).returning({ id: users.id });

  console.log(`  admin:            ${email} created (enrol MFA at first sign-in)`);
  return created.id;
}

async function seedCampaign(ownerId: string | null) {
  if (!ownerId) {
    console.log("  campaign:         skipped (no admin user to own it)");
    return;
  }
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(campaigns);
  if (count > 0) {
    console.log(`  campaign:         ${count} already present, skipped`);
    return;
  }

  await db.insert(campaigns).values({
    name: "Fifth Street Phase One — Showroom Outreach",
    objective: "Introduce ALAM Business Center to suitable UMA member companies and secure private site visits.",
    segment: "vehicle_motorcycle",
    targetFloor: "ground",
    ctaLabel: "Schedule a Private Site Visit",
    ctaUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/visit`,
    senderName: process.env.SEED_ADMIN_NAME ?? "Administrator",
    senderEmail: process.env.EMAIL_FROM_ADDRESS ?? "leasing@example-not-configured.com",
    ownerId,
  });
  console.log("  campaign:         1 seeded");
}

async function main() {
  console.log("Seeding ALAM lease outreach database…");
  await seedRoles();
  await seedPropertyFacts();
  await seedProhibited();
  await seedSettings();
  const adminId = await seedAdmin();
  await seedCampaign(adminId);
  console.log("Done. Global sending remains DISABLED until launch approval.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
