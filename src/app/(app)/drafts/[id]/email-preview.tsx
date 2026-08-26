"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui";

/**
 * Renders the message in an iframe rather than inline.
 *
 * Two reasons: the email's own CSS cannot leak into the admin interface (or
 * vice versa, which would make the preview a lie), and the desktop/mobile
 * toggle can change the viewport honestly by resizing the frame.
 */
export function EmailPreview({ html, text }: { html: string; text: string }) {
  const [view, setView] = useState<"desktop" | "mobile" | "text">("desktop");

  const width = view === "mobile" ? 320 : "100%";

  return (
    <Card>
      <CardHeader
        title="Message preview"
        subtitle="What the recipient receives, including the branded layout."
        action={
          <div className="flex gap-1">
            {(["desktop", "mobile", "text"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded px-2.5 py-1 text-xs font-medium capitalize transition ${
                  view === v
                    ? "bg-[var(--color-ink)] text-white"
                    : "border border-[var(--color-line)] text-[var(--color-ink-2)] hover:border-[var(--color-muted)]"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        }
      />

      <div className="bg-[#f4f4f4] p-4">
        {view === "text" ? (
          <pre className="max-h-[36rem] overflow-auto rounded border border-[var(--color-line)] bg-white p-4 text-sm whitespace-pre-wrap text-[#333]">
            {text}
          </pre>
        ) : (
          <div className="mx-auto" style={{ width, maxWidth: "100%" }}>
            <iframe
              // sandbox with no allow-scripts: the preview renders markup but
              // can never execute anything that arrived from generation.
              sandbox=""
              srcDoc={html}
              title="Email preview"
              className="h-[36rem] w-full rounded border border-[var(--color-line)] bg-white"
            />
          </div>
        )}
      </div>

      {view === "mobile" && (
        <p className="border-t border-[var(--color-line)] px-5 py-2 text-xs text-[var(--color-muted)]">
          Rendered at 320 px, the narrowest width the specification requires to
          remain readable.
        </p>
      )}
    </Card>
  );
}
