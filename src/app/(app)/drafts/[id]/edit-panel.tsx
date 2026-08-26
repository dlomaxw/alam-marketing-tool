"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editDraft } from "@/app/actions/drafts";
import { Card, CardHeader, Field, inputClass, btn } from "@/components/ui";

interface Props {
  draftId: string;
  status: string;
  subject: string;
  previewText: string;
  salutation: string;
  bodyInnerHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  recipientEmail: string;
  /** Editing an approved draft voids the approval; the UI must say so first. */
  isApproved: boolean;
}

export function EditPanel(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [subject, setSubject] = useState(props.subject);
  const [previewText, setPreviewText] = useState(props.previewText);
  const [salutation, setSalutation] = useState(props.salutation);
  const [body, setBody] = useState(props.bodyInnerHtml);
  const [ctaLabel, setCtaLabel] = useState(props.ctaLabel);
  const [ctaUrl, setCtaUrl] = useState(props.ctaUrl);
  const [recipientEmail, setRecipientEmail] = useState(props.recipientEmail);
  const [reason, setReason] = useState("");

  const dirty =
    subject !== props.subject ||
    previewText !== props.previewText ||
    salutation !== props.salutation ||
    body !== props.bodyInnerHtml ||
    ctaLabel !== props.ctaLabel ||
    ctaUrl !== props.ctaUrl ||
    recipientEmail !== props.recipientEmail;

  function save() {
    start(async () => {
      const r = await editDraft(
        props.draftId,
        {
          subject,
          previewText,
          salutation,
          bodyInnerHtml: body,
          ctaLabel,
          ctaUrl,
          recipientEmail,
        },
        reason || undefined,
      );
      setResult(r);
      if (r.ok) {
        setOpen(false);
        // The edit wrote a new version at a new id. Staying on this page would
        // leave the reviewer looking at superseded content.
        if (r.draftId && r.draftId !== props.draftId) router.push(`/drafts/${r.draftId}`);
        else router.refresh();
      }
    });
  }

  if (!open) {
    return (
      <Card>
        <CardHeader
          title="Edit"
          subtitle="Every edit creates a new version. Nothing is overwritten."
        />
        <div className="px-5 py-4">
          <button onClick={() => setOpen(true)} className={btn.ghost}>
            Edit this draft
          </button>
          {props.isApproved && (
            <p className="mt-2 text-xs text-[var(--color-warn)]">
              This version is approved. Editing it cancels that approval and
              sends the new version back for review.
            </p>
          )}
          {result && (
            <p
              role="status"
              className={`mt-3 rounded-md px-3 py-2 text-sm ${
                result.ok
                  ? "bg-emerald-50 text-emerald-800"
                  : "bg-[var(--color-danger-bg)] text-[var(--color-alam-red)]"
              }`}
            >
              {result.message}
            </p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Editing"
        subtitle="Changes are saved as a new version once you apply them."
      />
      <div className="space-y-4 px-5 py-4">
        {props.isApproved && (
          <p className="rounded-md bg-[var(--color-warn-bg)] px-3 py-2 text-xs text-[var(--color-warn)]">
            Applying these changes cancels the existing approval. The new
            version must be reviewed and approved again before it can be sent.
          </p>
        )}

        <Field label="Subject line">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Preview text" hint="Shown next to the subject in the inbox.">
          <input value={previewText} onChange={(e) => setPreviewText(e.target.value)} className={inputClass} />
        </Field>

        <Field label="Salutation" hint='Without the trailing comma — "Dear Mr. Shukla".'>
          <input value={salutation} onChange={(e) => setSalutation(e.target.value)} className={inputClass} />
        </Field>

        <Field
          label="Message body"
          hint="The message only. The ALAM header, building image, button, signature and footer are applied automatically and cannot be edited here."
        >
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            spellCheck
            className={`${inputClass} font-mono text-xs leading-relaxed`}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Button label">
            <input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Button link">
            <input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} className={inputClass} />
          </Field>
        </div>

        <Field label="Recipient" hint="Changing this changes who receives the message.">
          <input
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Reason for the change" hint="Recorded in the audit log.">
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>

        {result && !result.ok && (
          <p role="alert" className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-alam-red)]">
            {result.message}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button disabled={pending || !dirty} onClick={save} className={btn.primary}>
            {pending ? "Saving…" : "Save as new version"}
          </button>
          <button
            onClick={() => { setOpen(false); setResult(null); }}
            className={btn.ghost}
          >
            Cancel
          </button>
          {!dirty && (
            <span className="self-center text-xs text-[var(--color-muted)]">
              Nothing changed yet.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
