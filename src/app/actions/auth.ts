"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, roles } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { verifyTotp, generateMfaSecret, buildOtpAuthUrl, buildQrDataUrl } from "@/lib/auth/mfa";
import {
  createSession, destroySession, getCurrentUser, markSessionMfaSatisfied,
  requestIp, requireUser,
} from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { MFA_REQUIRED_PERMISSIONS } from "@/lib/auth/rbac";
import { checkLoginRateLimit } from "@/lib/auth/rate-limit";

export interface FormState { error?: string; notice?: string }

/** Uniform delay so a wrong email and a wrong password look the same. */
async function levelTiming(start: number) {
  const elapsed = Date.now() - start;
  if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const started = Date.now();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "Enter your email address and password." };

  const ip = await requestIp();
  const limit = await checkLoginRateLimit(email, ip);
  if (limit.blocked) {
    await writeAudit({
      actorLabel: email,
      action: "auth.rate_limited",
      entity: "user",
      ip,
      reason: limit.reason,
    });
    await levelTiming(started);
    return {
      error: `Too many failed sign-in attempts. Try again in ${limit.retryAfterMinutes} minutes.`,
    };
  }

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      status: users.status,
      mfaEnabled: users.mfaEnabled,
      permissions: roles.permissions,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.email, email))
    .limit(1);

  const ok = row ? await verifyPassword(password, row.passwordHash) : false;
  await levelTiming(started);

  if (!row || !ok || row.status !== "active") {
    await writeAudit({
      actorLabel: email || "unknown",
      action: "auth.sign_in_failed",
      entity: "user",
      entityId: row?.id ?? null,
      ip,
      reason: !row ? "no such user" : !ok ? "bad password" : `status ${row.status}`,
    });
    return { error: "Those sign-in details were not recognised." };
  }

  await createSession({
    userId: row.id,
    // No session ever starts MFA-satisfied. A user without an authenticator
    // enrolled therefore holds an unelevated session: enough to read and
    // draft, never enough to approve, send or change settings.
    mfaSatisfied: false,
    ip: await requestIp(),
  });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));

  await writeAudit({
    actorId: row.id,
    actorLabel: row.email,
    action: "auth.sign_in",
    entity: "user",
    entityId: row.id,
    ip: await requestIp(),
    metadata: { mfaRequired: row.mfaEnabled },
  });

  redirect(row.mfaEnabled ? "/mfa" : "/dashboard");
}

export async function submitMfa(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const code = String(formData.get("code") ?? "");
  const [row] = await db.select({ secret: users.mfaSecret })
    .from(users).where(eq(users.id, user.id)).limit(1);

  if (!row?.secret) return { error: "No authenticator is enrolled for this account." };

  if (!(await verifyTotp(code, row.secret))) {
    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "auth.mfa_failed", entity: "user", entityId: user.id,
      ip: await requestIp(),
    });
    return { error: "That code was not accepted. Check your authenticator and try again." };
  }

  await markSessionMfaSatisfied(user.sessionId);
  await writeAudit({
    actorId: user.id, actorLabel: user.email,
    action: "auth.mfa_satisfied", entity: "user", entityId: user.id,
    ip: await requestIp(),
  });

  redirect("/dashboard");
}

/** Begins enrolment and returns the QR payload. The secret is not yet stored. */
export async function beginMfaEnrolment(): Promise<{ secret: string; qr: string }> {
  const user = await requireUser();
  const secret = generateMfaSecret();
  const qr = await buildQrDataUrl(buildOtpAuthUrl(user.email, secret));
  return { secret, qr };
}

/** Confirms enrolment only after a working code proves the secret was saved. */
export async function confirmMfaEnrolment(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const secret = String(formData.get("secret") ?? "");
  const code = String(formData.get("code") ?? "");

  if (!secret) return { error: "Enrolment session expired. Start again." };
  if (!(await verifyTotp(code, secret))) {
    return { error: "That code did not match. Check the time on your phone and try again." };
  }

  await db.update(users)
    .set({ mfaSecret: secret, mfaEnabled: true })
    .where(eq(users.id, user.id));
  await markSessionMfaSatisfied(user.sessionId);

  await writeAudit({
    actorId: user.id, actorLabel: user.email,
    action: "auth.mfa_enrolled", entity: "user", entityId: user.id,
    ip: await requestIp(),
  });

  return { notice: "Multi-factor authentication is now active on this account." };
}

export async function signOut() {
  const user = await getCurrentUser();
  if (user) {
    await writeAudit({
      actorId: user.id, actorLabel: user.email,
      action: "auth.sign_out", entity: "user", entityId: user.id,
    });
  }
  await destroySession();
  redirect("/login");
}

/** Permissions the current session holds but cannot exercise without MFA. */
export async function blockedByMfa(permissions: string[]): Promise<string[]> {
  return permissions.filter((p) => MFA_REQUIRED_PERMISSIONS.has(p as never));
}
