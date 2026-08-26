"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmContact, setProspectStatus } from "@/app/actions/admin";
import { generateForProspect } from "@/app/actions/drafts";
import { Card, CardHeader, Field, inputClass, btn } from "@/components/ui";

interface Props {
  prospectId: string;
  status: string;
  segment: string;
  campaigns: { id: string; name: string }[];
  contacts: { id: string; label: string; email: string | null; confidence: number }[];
  canWrite: boolean;
  canDraft: boolean;
}

export function ProspectActions(props: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [campaignId, setCampaignId] = useState(props.campaigns[0]?.id ?? "");
  const [contactId, setContactId] = useState(props.contacts[0]?.id ?? "");
  const [correctedEmail, setCorrectedEmail] = useState(
    props.contacts[0]?.email ?? "",
  );
  const [exclusionReason, setExclusionReason] = useState("");
  const [pending, start] = useTransition();

  const selected = props.contacts.find((c) => c.id === contactId);
  const lowConfidence = (selected?.confidence ?? 0) < 70;

  const run = (fn: () => Promise<{ ok: boolean; message: string; draftId?: string }>) =>
    start(async () => {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok && "draftId" in r && r.draftId) router.push(`/drafts/${r.draftId}`);
      else if (r.ok) router.refresh();
    });

  return (
    <Card>
      <CardHeader title="Actions" />
      <div className="space-y-4 px-5 py-4">
        {props.contacts.length > 0 && (
          <Field label="Recipient">
            <select
              value={contactId}
              onChange={(e) => {
                setContactId(e.target.value);
                setCorrectedEmail(
                  props.contacts.find((c) => c.id === e.target.value)?.email ?? "",
                );
              }}
              className={inputClass}
            >
              {props.contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </Field>
        )}

        {lowConfidence && props.canWrite && (
          /* Section 5.1: an address below the confidence threshold has to be
             confirmed by a person before it can be used. */
          <div className="rounded-md bg-[var(--color-warn-bg)] p-3">
            <p className="mb-2 text-xs text-[var(--color-warn)]">
              This address was extracted with low confidence. Check it against
              the directory page and confirm it before generating.
            </p>
            <input
              value={correctedEmail}
              onChange={(e) => setCorrectedEmail(e.target.value)}
              placeholder="name@company.co.ug"
              className={`${inputClass} mb-2`}
            />
            <button
              disabled={pending || !contactId}
              onClick={() => run(() => confirmContact(contactId, correctedEmail))}
              className={btn.primary}
            >
              Confirm this address
            </button>
          </div>
        )}

        {props.canDraft && (
          <div className="border-t border-[var(--color-line)] pt-4">
            {props.segment === "unclassified" ? (
              <p className="text-xs text-[var(--color-muted)]">
                This prospect has no clear tenant segment. Section 5.3 requires
                manual qualification before a draft can be generated.
              </p>
            ) : (
              <>
                <Field label="Campaign">
                  <select
                    value={campaignId}
                    onChange={(e) => setCampaignId(e.target.value)}
                    className={inputClass}
                  >
                    {props.campaigns.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </Field>
                <button
                  disabled={pending || !campaignId || lowConfidence}
                  onClick={() => run(() =>
                    generateForProspect(campaignId, props.prospectId, contactId || undefined))}
                  className={`${btn.primary} mt-3 w-full`}
                >
                  {pending ? "Generating…" : "Generate draft"}
                </button>
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  Generating creates a draft only. It never schedules a send.
                </p>
              </>
            )}
          </div>
        )}

        {props.canWrite && (
          <div className="space-y-2 border-t border-[var(--color-line)] pt-4">
            <div className="flex flex-wrap gap-2">
              {props.status !== "qualified" && (
                <button
                  disabled={pending}
                  onClick={() => run(() => setProspectStatus(props.prospectId, "qualified"))}
                  className={btn.ghost}
                >
                  Mark qualified
                </button>
              )}
              {props.status !== "excluded" && (
                <button
                  disabled={pending || !exclusionReason.trim()}
                  onClick={() => run(() =>
                    setProspectStatus(props.prospectId, "excluded", exclusionReason))}
                  className={btn.ghost}
                >
                  Exclude
                </button>
              )}
            </div>
            {props.status !== "excluded" && (
              <input
                value={exclusionReason}
                onChange={(e) => setExclusionReason(e.target.value)}
                placeholder="Reason for exclusion"
                className={inputClass}
              />
            )}
          </div>
        )}

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
      </div>
    </Card>
  );
}
