import { redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "./session";
import { MFA_REQUIRED_PERMISSIONS, type Permission } from "./rbac";

/**
 * Page-level authorization.
 *
 * Server actions throw on a failed check, because a mutation must fail loudly.
 * A page render is different: throwing there gives the user an opaque server
 * error when the real answer is usually "verify your second factor" or "your
 * role does not include this". This redirects somewhere useful instead.
 */
export async function guardPage(needed: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  if (!user.permissions.includes(needed)) {
    redirect(`/dashboard?denied=${encodeURIComponent(needed)}`);
  }

  if (MFA_REQUIRED_PERMISSIONS.has(needed) && !user.mfaSatisfied) {
    redirect(`/mfa?next=${encodeURIComponent(needed)}`);
  }

  return user;
}

export async function guardSignedIn(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
