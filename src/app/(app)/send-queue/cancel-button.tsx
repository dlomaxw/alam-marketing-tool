"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelJob } from "@/app/actions/drafts";
import { inputClass, btn } from "@/components/ui";

export function CancelButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={btn.ghost}>
        Cancel
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        className={`${inputClass} max-w-48`}
      />
      <button
        disabled={pending || !reason.trim()}
        onClick={() => start(async () => {
          const r = await cancelJob(jobId, reason);
          if (r.ok) { setOpen(false); router.refresh(); }
          else setError(r.message);
        })}
        className={btn.danger}
      >
        {pending ? "Cancelling…" : "Confirm"}
      </button>
      <button onClick={() => setOpen(false)} className={btn.ghost}>Keep</button>
      {error && <span className="text-xs text-[var(--color-alam-red)]">{error}</span>}
    </div>
  );
}
