import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { beginMfaEnrolment } from "@/app/actions/auth";
import { MfaChallengeForm, MfaEnrolForm } from "./mfa-forms";

/**
 * Handles both cases: verifying a code for an enrolled user, and enrolling an
 * authenticator for one who has none. Approving and sending require MFA, so a
 * user without it would otherwise be permanently unable to do their job.
 */
export default async function MfaPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mfaSatisfied) redirect("/dashboard");

  const enrolment = user.mfaEnabled ? null : await beginMfaEnrolment();

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <div className="text-lg font-bold tracking-tight text-[var(--color-ink)]">
            Two-factor verification
          </div>
          <div className="text-sm text-[var(--color-muted)]">
            Signed in as {user.email}
          </div>
        </div>

        {enrolment
          ? <MfaEnrolForm secret={enrolment.secret} qr={enrolment.qr} />
          : <MfaChallengeForm />}
      </div>
    </div>
  );
}
