import { and, eq, gte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

/**
 * Brute-force protection for sign-in, required by section 14.
 *
 * Counts recent failures already recorded in the audit log rather than adding
 * a counters table. Two reasons: the data is written anyway, so there is one
 * source of truth for "what happened"; and it works across serverless
 * instances, where an in-memory limiter would reset on every cold start and
 * protect nothing.
 */

const WINDOW_MINUTES = 15;
/** Per account. Generous enough for a person mistyping a password. */
const MAX_PER_EMAIL = 8;
/** Per address. Higher, because an office shares one public IP. */
const MAX_PER_IP = 25;

export interface RateLimitResult {
  blocked: boolean;
  reason?: string;
  retryAfterMinutes: number;
}

export async function checkLoginRateLimit(
  email: string, ip: string | null,
): Promise<RateLimitResult> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const [row] = await db
      .select({
        byEmail: sql<number>`count(*) FILTER (WHERE ${auditLog.actorLabel} = ${normalizedEmail})::int`,
        byIp: sql<number>`count(*) FILTER (WHERE ${auditLog.ip} IS NOT DISTINCT FROM ${ip})::int`,
      })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "auth.sign_in_failed"),
        gte(auditLog.createdAt, since),
        or(
          eq(auditLog.actorLabel, normalizedEmail),
          ip ? eq(auditLog.ip, ip) : undefined,
        ),
      ));

    if ((row?.byEmail ?? 0) >= MAX_PER_EMAIL) {
      return {
        blocked: true,
        reason: "too_many_for_account",
        retryAfterMinutes: WINDOW_MINUTES,
      };
    }
    if (ip && (row?.byIp ?? 0) >= MAX_PER_IP) {
      return {
        blocked: true,
        reason: "too_many_from_address",
        retryAfterMinutes: WINDOW_MINUTES,
      };
    }
  } catch (err) {
    // A limiter that fails closed would lock everybody out of an approval
    // system if the audit query broke. Fail open, but make it visible.
    console.error("[rate-limit] check failed, allowing attempt", err);
  }

  return { blocked: false, retryAfterMinutes: 0 };
}

export const RATE_LIMIT_WINDOW_MINUTES = WINDOW_MINUTES;
