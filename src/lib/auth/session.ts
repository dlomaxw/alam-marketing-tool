import "server-only";
import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users, roles } from "@/db/schema";
import { env } from "@/lib/env";
import { MFA_REQUIRED_PERMISSIONS, type Permission } from "./rbac";

const COOKIE = "alam_session";
const MAX_AGE_SECONDS = 60 * 60 * 8; // 8h; section 14 asks for short sessions.

const secret = new TextEncoder().encode(env.SESSION_SECRET);

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  mfaEnabled: boolean;
  mfaSatisfied: boolean;
  sessionId: string;
}

/**
 * The cookie carries only a session id. Every request re-reads the row, so
 * revoking a session or changing a role takes effect immediately rather than
 * waiting for a self-contained token to expire.
 */
async function signSessionToken(sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret);
}

export async function createSession(opts: {
  userId: string;
  mfaSatisfied: boolean;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<string> {
  const expiresAt = new Date(Date.now() + MAX_AGE_SECONDS * 1000);
  const [row] = await db.insert(sessions).values({
    userId: opts.userId,
    mfaSatisfied: opts.mfaSatisfied,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
    expiresAt,
  }).returning({ id: sessions.id });

  const token = await signSessionToken(row.id);
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return row.id;
}

export async function markSessionMfaSatisfied(sessionId: string): Promise<void> {
  await db.update(sessions)
    .set({ mfaSatisfied: true })
    .where(eq(sessions.id, sessionId));
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) {
    const sid = await readSessionId(token);
    if (sid) {
      await db.update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, sid));
    }
  }
  store.delete(COOKIE);
}

async function readSessionId(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return typeof payload.sid === "string" ? payload.sid : null;
  } catch {
    return null;
  }
}

/** Returns null rather than throwing, so pages can redirect gracefully. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;

  const sessionId = await readSessionId(token);
  if (!sessionId) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      mfaSatisfied: sessions.mfaSatisfied,
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      mfaEnabled: users.mfaEnabled,
      roleId: roles.id,
      roleName: roles.name,
      permissions: roles.permissions,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      eq(sessions.id, sessionId),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, new Date()),
    ))
    .limit(1);

  if (!row || row.status !== "active") return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    roleId: row.roleId,
    roleName: row.roleName,
    permissions: row.permissions ?? [],
    mfaEnabled: row.mfaEnabled,
    mfaSatisfied: row.mfaSatisfied,
    sessionId: row.sessionId,
  };
}

export class AuthorizationError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Server-side gate for every mutation. Throws rather than returning a flag so
 * a forgotten `if` cannot silently allow the action.
 */
export async function requirePermission(needed: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("Not signed in.", 401);

  if (!user.permissions.includes(needed)) {
    throw new AuthorizationError(
      `Role "${user.roleName}" does not hold "${needed}".`,
    );
  }

  if (MFA_REQUIRED_PERMISSIONS.has(needed) && !user.mfaSatisfied) {
    throw new AuthorizationError(
      `"${needed}" requires a multi-factor verified session.`,
    );
  }

  return user;
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("Not signed in.", 401);
  return user;
}

export async function requestIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip");
}
