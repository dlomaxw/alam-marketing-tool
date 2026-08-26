"use client";

import { useState, useTransition } from "react";
import {
  decideOnDraft, submitForReview, queueSend, revokeApproval,
  type ActionResult,
} from "@/app/actions/drafts";
import { Card, CardHeader, btn, inputClass } from "@/components/ui";
import type { DraftAction, DraftStatus } from "@/lib/draft-state";

interface Props {
  draftId: string;
  contentHash: string;
  status: DraftStatus;
  actions: DraftAction[];
  canApprove: boolean;
  isAuthor: boolean;
  mfaSatisfied: boolean;
  sendFailures: { code: string; message: string }[];
  subject: string;
  recipient: string | null;
  company: string;
}

export function ReviewPanel(props: Props) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setResult(await fn());
      setConfirming(false);
    });

  const has = (a: DraftAction) => props.actions.includes(a);
  const blockedForAuthor = props.isAuthor && props.canApprove;

  return (
    <Card>
      <CardHeader title="Decision" subtitle="Bound to this exact version and content hash." />

      <div className="space-y-3 px-5 py-4">
        {!props.mfaSatisfied && (
          <p className="rounded-md bg-[var(--color-warn-bg)] px-3 py-2 text-xs text-[var(--color-warn)]">
            Your session is not multi-factor verified. Approving and sending are
            unavailable until you verify.
          </p>
        )}

        {blockedForAuthor && props.status === "needs_review" && (
          <p className="rounded-md bg-[var(--color-warn-bg)] px-3 py-2 text-xs text-[var(--color-warn)]">
            You created this draft, so you cannot approve it. A second
            authorized person must review it.
          </p>
        )}

        {props.sendFailures.length > 0 && (
          <div className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2">
            <p className="text-xs font-semibold text-[var(--color-alam-red)]">
              This message cannot be sent right now:
            </p>
            <ul className="mt-1 space-y-1">
              {props.sendFailures.map((f) => (
                <li key={f.code} className="text-xs text-[var(--color-ink-2)]">
                  <span className="font-mono">{f.code}</span> — {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {(has("reject") || has("request_changes")) && (
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Reason (required to reject or request changes)"
            className={inputClass}
          />
        )}

        <div className="flex flex-wrap gap-2">
          {has("submit") && (
            <button
              disabled={pending}
              onClick={() => run(() => submitForReview(props.draftId))}
              className={btn.primary}
            >
              Submit for review
            </button>
          )}

          {has("approve") && !blockedForAuthor && (
            <button
              disabled={pending || !props.mfaSatisfied}
              onClick={() => run(() =>
                decideOnDraft(props.draftId, "approved", props.contentHash))}
              className={btn.primary}
            >
              Approve
            </button>
          )}

          {has("request_changes") && (
            <button
              disabled={pending}
              onClick={() => run(() =>
                decideOnDraft(props.draftId, "changes_requested", props.contentHash, reason))}
              className={btn.ghost}
            >
              Request changes
            </button>
          )}

          {has("reject") && (
            <button
              disabled={pending}
              onClick={() => run(() =>
                decideOnDraft(props.draftId, "rejected", props.contentHash, reason))}
              className={btn.ghost}
            >
              Reject
            </button>
          )}

          {has("revoke_approval") && (
            <button
              disabled={pending}
              onClick={() => run(() => revokeApproval(props.draftId, reason || "No reason given"))}
              className={btn.ghost}
            >
              Revoke approval
            </button>
          )}
        </div>

        {has("queue") && (
          <div className="border-t border-[var(--color-line)] pt-3">
            {confirming ? (
              /* Section 8.1: the final confirmation restates exactly what is
                 about to leave the building, and to whom. */
              <div className="rounded-md border border-[var(--color-alam-red)]/30 bg-[var(--color-danger-bg)] p-3">
                <p className="text-xs font-semibold text-[var(--color-alam-red)]">
                  Confirm delivery
                </p>
                <dl className="mt-2 space-y-1 text-xs text-[var(--color-ink-2)]">
                  <div><dt className="inline text-[var(--color-muted)]">To: </dt><dd className="inline">{props.recipient}</dd></div>
                  <div><dt className="inline text-[var(--color-muted)]">Company: </dt><dd className="inline">{props.company}</dd></div>
                  <div><dt className="inline text-[var(--color-muted)]">Subject: </dt><dd className="inline">{props.subject}</dd></div>
                  <div><dt className="inline text-[var(--color-muted)]">Attachments: </dt><dd className="inline">None</dd></div>
                  <div><dt className="inline text-[var(--color-muted)]">Version hash: </dt><dd className="inline font-mono">{props.contentHash.slice(0, 16)}…</dd></div>
                </dl>
                <div className="mt-3 flex gap-2">
                  <button
                    disabled={pending}
                    onClick={() => run(() => queueSend(props.draftId, false))}
                    className={btn.danger}
                  >
                    {pending ? "Queueing…" : "Confirm and send"}
                  </button>
                  <button onClick={() => setConfirming(false)} className={btn.ghost}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={pending || !props.mfaSatisfied || props.sendFailures.length > 0}
                  onClick={() => setConfirming(true)}
                  className={btn.danger}
                >
                  Approve &amp; Send
                </button>
                <button
                  disabled={pending}
                  onClick={() => run(() => queueSend(props.draftId, true))}
                  className={btn.ghost}
                >
                  Send test
                </button>
              </div>
            )}
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              A test goes only to an internal allow-listed address and is marked
              TEST. It is not an approval.
            </p>
          </div>
        )}

        {props.actions.length === 0 && (
          <p className="text-xs text-[var(--color-muted)]">
            No actions are available to you from status &ldquo;{props.status}&rdquo;.
          </p>
        )}

        {result && (
          <div
            role="status"
            className={`rounded-md px-3 py-2 text-sm ${
              result.ok
                ? "bg-emerald-50 text-emerald-800"
                : "bg-[var(--color-danger-bg)] text-[var(--color-alam-red)]"
            }`}
          >
            {result.message}
            {result.failures && (
              <ul className="mt-1 space-y-0.5">
                {result.failures.map((f) => (
                  <li key={f.code} className="text-xs">
                    <span className="font-mono">{f.code}</span> — {f.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
