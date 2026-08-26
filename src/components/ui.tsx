import Link from "next/link";
import type { ReactNode } from "react";
import { STATUS_LABELS, type DraftStatus } from "@/lib/draft-state";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[var(--color-line)] bg-white ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: {
  title: string; subtitle?: string; action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-[var(--color-muted)]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, href, tone = "default" }: {
  label: string; value: number | string; href?: string;
  tone?: "default" | "warn" | "danger" | "ok";
}) {
  const toneClass = {
    default: "text-[var(--color-ink)]",
    warn: "text-[var(--color-warn)]",
    danger: "text-[var(--color-alam-red)]",
    ok: "text-[var(--color-ok)]",
  }[tone];

  const inner = (
    <>
      <div className={`tnum text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-1 text-xs text-[var(--color-muted)]">{label}</div>
    </>
  );

  return href ? (
    <Link href={href} className="block rounded-lg border border-[var(--color-line)] bg-white px-4 py-3 transition hover:border-[var(--color-muted)]">
      {inner}
    </Link>
  ) : (
    <div className="rounded-lg border border-[var(--color-line)] bg-white px-4 py-3">{inner}</div>
  );
}

const STATUS_TONES: Record<DraftStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  needs_review: "bg-amber-100 text-amber-800",
  rejected: "bg-rose-100 text-rose-800",
  approved: "bg-emerald-100 text-emerald-800",
  queued: "bg-sky-100 text-sky-800",
  sent: "bg-indigo-100 text-indigo-800",
  failed: "bg-rose-100 text-rose-800",
  bounced: "bg-rose-100 text-rose-800",
  replied: "bg-teal-100 text-teal-800",
};

export function StatusBadge({ status }: { status: DraftStatus }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Badge({ children, tone = "neutral" }: {
  children: ReactNode; tone?: "neutral" | "warn" | "danger" | "ok";
}) {
  const cls = {
    neutral: "bg-slate-100 text-slate-700",
    warn: "bg-amber-100 text-amber-800",
    danger: "bg-rose-100 text-rose-800",
    ok: "bg-emerald-100 text-emerald-800",
  }[tone];
  return <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

/**
 * The banner the specification asks to be visible wherever a draft can be
 * acted on. It states the live state of the two-part kill switch rather than a
 * static warning, so it stays informative once sending is switched on.
 */
export function SendStateBanner({ enabled, reason }: { enabled: boolean; reason: string }) {
  return enabled ? (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
      <strong className="font-semibold">Sending is ENABLED.</strong>{" "}
      Approved messages will be delivered to real recipients.
    </div>
  ) : (
    <div className="rounded-md border border-[var(--color-alam-red)]/25 bg-[var(--color-danger-bg)] px-4 py-2.5 text-sm text-[var(--color-ink-2)]">
      <strong className="font-semibold text-[var(--color-alam-red)]">SEND DISABLED.</strong>{" "}
      {reason}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-[var(--color-muted)]">{children}</p>;
}

export function Field({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--color-ink-2)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-[var(--color-line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--color-ink-2)]";

export const btn = {
  primary: "inline-flex items-center justify-center rounded-md bg-[var(--color-ink)] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-black disabled:opacity-40",
  danger: "inline-flex items-center justify-center rounded-md bg-[var(--color-alam-red)] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[var(--color-alam-red-dark)] disabled:opacity-40",
  ghost: "inline-flex items-center justify-center rounded-md border border-[var(--color-line)] bg-white px-3.5 py-2 text-sm font-medium text-[var(--color-ink-2)] transition hover:border-[var(--color-muted)] disabled:opacity-40",
};
