import { z } from "zod";

/**
 * Validated server environment. Importing this from a client component is a
 * build error by design (`server-only`), so secrets cannot leak into a bundle.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_UNPOOLED: z.string().optional(),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().default("alam-lease-assets"),

  AI_PROVIDER: z.enum(["gemini", "stub"]).default("stub"),
  GEMINI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("gemini-2.5-flash"),

  EMAIL_PROVIDER: z.enum(["console", "smtp"]).default("console"),
  EMAIL_FROM_NAME: z.string().default("ALAM Business Center"),
  EMAIL_FROM_ADDRESS: z.string().default("leasing@example-not-configured.com"),
  EMAIL_REPLY_TO: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  /**
   * Environment-level kill switch. The database setting `global_send_enabled`
   * is checked too; sending requires BOTH to be true, so a compromised
   * database row cannot by itself turn delivery on.
   */
  GLOBAL_SEND_ENABLED: z.string().default("false"),
  TEST_SEND_ALLOWLIST: z.string().default(""),
  DAILY_SEND_LIMIT: z.coerce.number().default(25),

  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

/** Env-level half of the send authorization. Never cached. */
export const envSendEnabled = () => process.env.GLOBAL_SEND_ENABLED === "true";

export const testAllowlist = (): string[] =>
  env.TEST_SEND_ALLOWLIST.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
