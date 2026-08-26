"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setGlobalSend, approvePropertyFact, updatePropertyFact,
  updateNumericSetting, updateTestAllowlist, addSuppression,
} from "@/app/actions/admin";
import { Field, inputClass, btn, Badge } from "@/components/ui";

function useAction() {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setMessage({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    });

  return { message, pending, run };
}

function Notice({ message }: { message: { ok: boolean; text: string } | null }) {
  if (!message) return null;
  return (
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
  );
}

/** Section 14 emergency control. */
export function KillSwitch({ enabled, pendingJobs }: { enabled: boolean; pendingJobs: number }) {
  const { message, pending, run } = useAction();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-3">
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for this change (recorded in the audit log)"
        className={inputClass}
      />

      {enabled ? (
        <div>
          <button
            disabled={pending || !reason.trim()}
            onClick={() => run(() => setGlobalSend(false, reason))}
            className={btn.danger}
          >
            {pending ? "Stopping…" : "SEND OFF — stop all delivery now"}
          </button>
          {pendingJobs > 0 && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              This will also cancel the {pendingJobs} job(s) currently queued.
            </p>
          )}
        </div>
      ) : confirming ? (
        <div className="rounded-md border border-[var(--color-alam-red)]/30 bg-[var(--color-danger-bg)] p-3">
          <p className="text-sm text-[var(--color-ink-2)]">
            Turning sending on allows approved messages to reach real
            prospects. Confirm that management has completed launch approval,
            the sender domain is authenticated, and the test allow-list is correct.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              disabled={pending}
              onClick={() => run(() => setGlobalSend(true, reason))}
              className={btn.danger}
            >
              Confirm and enable sending
            </button>
            <button onClick={() => setConfirming(false)} className={btn.ghost}>Cancel</button>
          </div>
        </div>
      ) : (
        <button
          disabled={!reason.trim()}
          onClick={() => setConfirming(true)}
          className={btn.ghost}
        >
          Enable sending…
        </button>
      )}

      <Notice message={message} />
    </div>
  );
}

export function FactRow(props: {
  id: string; label: string; factKey: string; value: string;
  version: number; approved: boolean;
}) {
  const { message, pending, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.value);

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-ink)]">{props.label}</span>
            <span className="font-mono text-xs text-[var(--color-muted)]">{props.factKey}</span>
            <span className="text-xs text-[var(--color-muted)]">v{props.version}</span>
          </div>
          {editing ? (
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={2}
              className={`${inputClass} mt-2`}
            />
          ) : (
            <p className="mt-0.5 text-sm text-[var(--color-ink-2)]">{props.value}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={props.approved ? "ok" : "danger"}>
            {props.approved ? "approved" : "not approved"}
          </Badge>
          {editing ? (
            <>
              <button
                disabled={pending}
                onClick={() => run(async () => {
                  const r = await updatePropertyFact(props.id, value);
                  if (r.ok) setEditing(false);
                  return r;
                })}
                className={btn.primary}
              >
                Save as new version
              </button>
              <button onClick={() => { setEditing(false); setValue(props.value); }} className={btn.ghost}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditing(true)} className={btn.ghost}>Edit</button>
              {!props.approved && (
                <button
                  disabled={pending}
                  onClick={() => run(() => approvePropertyFact(props.id))}
                  className={btn.primary}
                >
                  Approve
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="mt-2"><Notice message={message} /></div>
    </li>
  );
}

export function NumericSetting(props: {
  settingKey: string; label: string; hint: string; value: number;
}) {
  const { message, pending, run } = useAction();
  const [value, setValue] = useState(String(props.value));

  return (
    <div>
      <Field label={props.label} hint={props.hint}>
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`${inputClass} max-w-32`}
          />
          <button
            disabled={pending || value === String(props.value)}
            onClick={() => run(() => updateNumericSetting(props.settingKey, Number(value)))}
            className={btn.ghost}
          >
            Save
          </button>
        </div>
      </Field>
      <div className="mt-2"><Notice message={message} /></div>
    </div>
  );
}

export function AllowlistForm({ value }: { value: string }) {
  const { message, pending, run } = useAction();
  const [text, setText] = useState(value);

  return (
    <div className="space-y-3 px-5 py-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="one address per line"
        className={inputClass}
      />
      <button
        disabled={pending}
        onClick={() => run(() => updateTestAllowlist(text))}
        className={btn.primary}
      >
        Save allow-list
      </button>
      <Notice message={message} />
    </div>
  );
}

export function SuppressionForm() {
  const { message, pending, run } = useAction();
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-2 border-b border-[var(--color-line)] px-5 py-4">
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="address@company.co.ug or company.co.ug"
          className={`${inputClass} max-w-xs`}
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason"
          className={`${inputClass} max-w-xs`}
        />
        <button
          disabled={pending || !value.trim() || !reason.trim()}
          onClick={() => run(async () => {
            const r = await addSuppression(value, reason);
            if (r.ok) { setValue(""); setReason(""); }
            return r;
          })}
          className={btn.ghost}
        >
          Suppress
        </button>
      </div>
      <Notice message={message} />
    </div>
  );
}
