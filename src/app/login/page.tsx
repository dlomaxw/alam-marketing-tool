import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <div className="text-lg font-bold tracking-tight text-[var(--color-ink)]">ALAM</div>
          <div className="text-sm text-[var(--color-muted)]">Business Center — Lease Outreach</div>
        </div>
        <LoginForm />
        <p className="mt-6 text-xs text-[var(--color-muted)]">
          Every action in this system is recorded against your account. No email
          is delivered without a recorded approval.
        </p>
      </div>
    </div>
  );
}
