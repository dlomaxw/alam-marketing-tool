"use client";

import Image from "next/image";
import { useActionState } from "react";
import { submitMfa, confirmMfaEnrolment, type FormState } from "@/app/actions/auth";
import { Card, Field, inputClass, btn } from "@/components/ui";

const codeInputProps = {
  name: "code",
  inputMode: "numeric" as const,
  autoComplete: "one-time-code",
  pattern: "[0-9]{6}",
  maxLength: 6,
  required: true,
  placeholder: "000000",
};

export function MfaChallengeForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(submitMfa, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <Field label="Six-digit code" hint="From your authenticator app.">
          <input {...codeInputProps} className={`${inputClass} tnum tracking-[0.3em]`} />
        </Field>

        {state.error && (
          <p role="alert" className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-alam-red)]">
            {state.error}
          </p>
        )}

        <button type="submit" disabled={pending} className={`${btn.primary} w-full`}>
          {pending ? "Verifying…" : "Verify"}
        </button>
      </form>
    </Card>
  );
}

export function MfaEnrolForm({ secret, qr }: { secret: string; qr: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(confirmMfaEnrolment, {});

  return (
    <Card className="p-5">
      <p className="mb-4 text-sm text-[var(--color-ink-2)]">
        Approving and sending require two-factor authentication. Scan this code
        with your authenticator app, then enter the six-digit code it shows.
      </p>

      <div className="mb-4 flex justify-center rounded-md border border-[var(--color-line)] p-3">
        <Image src={qr} alt="Authenticator enrolment QR code" width={220} height={220} unoptimized />
      </div>

      <p className="mb-4 break-all text-xs text-[var(--color-muted)]">
        Cannot scan? Enter this key manually: <code className="text-[var(--color-ink-2)]">{secret}</code>
      </p>

      <form action={action} className="space-y-4">
        <input type="hidden" name="secret" value={secret} />

        <Field label="Six-digit code">
          <input {...codeInputProps} className={`${inputClass} tnum tracking-[0.3em]`} />
        </Field>

        {state.error && (
          <p role="alert" className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-alam-red)]">
            {state.error}
          </p>
        )}
        {state.notice && (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {state.notice} <a href="/dashboard" className="underline">Continue</a>
          </p>
        )}

        <button type="submit" disabled={pending} className={`${btn.primary} w-full`}>
          {pending ? "Confirming…" : "Confirm and enable"}
        </button>
      </form>
    </Card>
  );
}
