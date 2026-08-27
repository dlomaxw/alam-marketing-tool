import { NextResponse } from "next/server";
import { getCurrentUser, type CurrentUser } from "./session";
import { MFA_REQUIRED_PERMISSIONS, type Permission } from "./rbac";

/**
 * Authorization for route handlers.
 *
 * Pages redirect and server actions throw; a route handler has to answer with
 * a status code, so it gets its own small guard rather than reusing either.
 */
export type ApiGuardResult =
  | { ok: true; user: CurrentUser }
  | { ok: false; response: NextResponse };

export async function guardApi(needed: Permission): Promise<ApiGuardResult> {
  const user = await getCurrentUser();

  if (!user) {
    return { ok: false, response: new NextResponse("Not signed in.", { status: 401 }) };
  }

  if (!user.permissions.includes(needed)) {
    return { ok: false, response: new NextResponse("Forbidden.", { status: 403 }) };
  }

  if (MFA_REQUIRED_PERMISSIONS.has(needed) && !user.mfaSatisfied) {
    return {
      ok: false,
      response: new NextResponse("A multi-factor verified session is required.", { status: 403 }),
    };
  }

  return { ok: true, user };
}
