import Link from "next/link";
import { sql, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  prospects, emailDrafts, sendJobs, auditLog, propertyFacts, suppressions,
} from "@/db/schema";
import { getSendSwitch } from "@/lib/settings";
import { guardSignedIn } from "@/lib/auth/page-guard";
import { Card, CardHeader, Stat, SendStateBanner, Empty, Badge } from "@/components/ui";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const user = await guardSignedIn();
  const { denied } = await searchParams;
  const send = await getSendSwitch();

  const [draftCounts, prospectCounts, jobCounts, facts, recent, suppressed] = await Promise.all([
    db.select({ status: emailDrafts.status, n: sql<number>`count(*)::int` })
      .from(emailDrafts).groupBy(emailDrafts.status),
    db.select({ status: prospects.status, n: sql<number>`count(*)::int` })
      .from(prospects).groupBy(prospects.status),
    db.select({ status: sendJobs.status, n: sql<number>`count(*)::int` })
      .from(sendJobs).groupBy(sendJobs.status),
    db.select().from(propertyFacts),
    db.select({
      id: auditLog.id, action: auditLog.action, actor: auditLog.actorLabel,
      entity: auditLog.entity, at: auditLog.createdAt,
    }).from(auditLog).orderBy(desc(auditLog.createdAt)).limit(8),
    db.select({ n: sql<number>`count(*)::int` }).from(suppressions),
  ]);

  const d = (s: string) => draftCounts.find((r) => r.status === s)?.n ?? 0;
  const p = (s: string) => prospectCounts.find((r) => r.status === s)?.n ?? 0;
  const j = (s: string) => jobCounts.find((r) => r.status === s)?.n ?? 0;

  const unapprovedFacts = facts.filter((f) => f.approvedAt === null).length;

  // Section 10.1: what needs a human first, before vanity totals.
  const attention = ([
    { label: "Prospects needing data review", count: p("needs_data_review"), href: "/prospects?status=needs_data_review", tone: "warn" },
    { label: "Drafts waiting for approval", count: d("needs_review"), href: "/review", tone: "warn" },
    { label: "Failed deliveries", count: d("failed") + d("bounced"), href: "/activity", tone: "danger" },
    { label: "Property facts not yet approved", count: unapprovedFacts, href: "/settings", tone: "danger" },
  ] as const).filter((a) => a.count > 0);

  return (
    <div className="space-y-6">
      <SendStateBanner enabled={send.enabled} reason={send.reason} />

      {denied && (
        <Card className="border-amber-300 bg-[var(--color-warn-bg)] px-5 py-3 text-sm text-[var(--color-warn)]">
          Your role does not include <code className="font-mono">{denied}</code>,
          so that page is not available to you.
        </Card>
      )}

      {attention.length > 0 && (
        <Card>
          <CardHeader
            title="Needs attention"
            subtitle="Items that stop work moving forward, listed before anything else."
          />
          <ul className="divide-y divide-[var(--color-line)]">
            {attention.map((a) => (
              <li key={a.label}>
                <Link href={a.href} className="flex items-center justify-between px-5 py-3 transition hover:bg-[var(--color-canvas)]">
                  <span className="text-sm text-[var(--color-ink-2)]">{a.label}</span>
                  <Badge tone={a.tone}>{a.count}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Pipeline</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Imported" value={p("imported") + p("qualified")} href="/prospects" />
          <Stat label="Needs data review" value={p("needs_data_review")} tone={p("needs_data_review") ? "warn" : "default"} href="/prospects?status=needs_data_review" />
          <Stat label="Drafted" value={d("draft")} href="/review" />
          <Stat label="Needs review" value={d("needs_review")} tone={d("needs_review") ? "warn" : "default"} href="/review" />
          <Stat label="Approved" value={d("approved")} tone="ok" href="/send-queue" />
          <Stat label="Queued" value={j("queued")} href="/send-queue" />
          <Stat label="Sent" value={d("sent")} href="/activity" />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Outcomes</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Replied" value={d("replied")} tone="ok" href="/activity" />
          <Stat label="Failed" value={d("failed")} tone={d("failed") ? "danger" : "default"} href="/activity" />
          <Stat label="Bounced" value={d("bounced")} tone={d("bounced") ? "danger" : "default"} href="/activity" />
          <Stat label="Suppressed contacts" value={suppressed[0]?.n ?? 0} href="/settings" />
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Section 10.1: replies, scheduled visits and signed leases are the
          measure of success here, not open rates.
        </p>
      </section>

      <Card>
        <CardHeader title="Recent activity" subtitle="Every action is recorded against an account." />
        {recent.length === 0 ? (
          <Empty>Nothing has happened yet.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                <span className="font-mono text-xs text-[var(--color-ink-2)]">{r.action}</span>
                <span className="flex-1 truncate text-[var(--color-muted)]">{r.actor}</span>
                <time className="tnum shrink-0 text-xs text-[var(--color-muted)]">
                  {r.at.toISOString().replace("T", " ").slice(0, 16)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!user.mfaSatisfied && (
        <Card className="border-amber-300 bg-[var(--color-warn-bg)] p-4 text-sm text-[var(--color-warn)]">
          Your session is not multi-factor verified, so you cannot approve,
          send or change settings. <Link href="/mfa" className="underline">Verify now</Link>.
        </Card>
      )}
    </div>
  );
}
