"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadAndExtract } from "@/app/actions/admin";
import { Field, inputClass, btn } from "@/components/ui";

export function UploadForm() {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(formData: FormData) {
    start(async () => {
      const r = await uploadAndExtract(formData);
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });
  }

  return (
    <form action={onSubmit} className="space-y-4 px-5 py-4">
      <Field
        label="PDF source"
        hint="Extraction of a 272-page directory takes a minute or two. Do not navigate away."
      >
        <input
          type="file"
          name="file"
          accept="application/pdf"
          required
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-[var(--color-ink)] file:px-3 file:py-1 file:text-white`}
        />
      </Field>

      <button disabled={pending} className={btn.primary}>
        {pending ? "Uploading and extracting…" : "Upload and extract"}
      </button>

      {message && (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${
            message.ok
              ? "bg-emerald-50 text-emerald-800"
              : "bg-[var(--color-danger-bg)] text-[var(--color-alam-red)]"
          }`}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
