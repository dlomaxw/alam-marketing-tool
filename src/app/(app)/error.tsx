"use client";

import { useEffect } from "react";

/**
 * Safety net for genuinely unexpected failures. Authorization is handled by
 * redirects in guardPage, so anything reaching here is a real fault and is
 * reported as one — without leaking the underlying message to the browser.
 */
export default function AppError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[app error]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg rounded-lg border border-[var(--color-line)] bg-white p-6">
      <h1 className="text-sm font-semibold text-[var(--color-alam-red)]">
        This page could not be loaded
      </h1>
      <p className="mt-2 text-sm text-[var(--color-ink-2)]">
        Something failed while preparing this view. No data was changed by the
        attempt, and nothing was sent.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-xs text-[var(--color-muted)]">
          Reference: {error.digest}
        </p>
      )}
      <button
        onClick={reset}
        className="mt-4 inline-flex items-center justify-center rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white hover:bg-black"
      >
        Try again
      </button>
    </div>
  );
}
