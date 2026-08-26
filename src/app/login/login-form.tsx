"use client";

import { useActionState } from "react";
import { signIn, type FormState } from "@/app/actions/auth";
import { Card, Field, inputClass, btn } from "@/components/ui";

export function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, {});

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <Field label="Email address">
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className={inputClass}
          />
        </Field>

        <Field label="Password">
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
        </Field>

        {state.error && (
          <p role="alert" className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-alam-red)]">
            {state.error}
          </p>
        )}

        <button type="submit" disabled={pending} className={`${btn.primary} w-full`}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Card>
  );
}
