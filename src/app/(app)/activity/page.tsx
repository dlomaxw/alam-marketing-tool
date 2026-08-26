import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { events, prospects, emailDrafts } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { Card, CardHeader, Empty, Badge, StatusBadge } from "@/components/ui";
import type { DraftStatus } from "@/lib/draft-state";

export default async function ActivityPage() {
  await guardPage("dashboard:read");

  const [rows, problems] = await Promise.all([
    db.select({
      id: events.id,
      type: events.type,
      at: events.occurredAt,
      company: prospects.companyName,
      prospectId: prospects.id,
      draftId: events.draftId,
    })
      .from(events)
      .leftJoin(prospects, eq(prospects.id, events.prospectId))
      .orderBy(desc(events.occurredAt))
      .limit(150),

    db.select({
      id: emailDrafts.id,
      subject: emailDrafts.subject,
      status: emailDrafts.status,
      recipient: emailDrafts.recipientEmail,
      company: prospects.companyName,
    })
      .from(emailDrafts)
      .innerJoin(prospects, eq(prospects.id, emailDrafts.prospectId))
      .orderBy(desc(emailDrafts.createdAt))
      .limit(200),
  ]);

  const failed = problems.filter((p) => p.status === "failed" || p.status === "bounced");
  const replied = problems.filter((p) => p.status === "replied");

  return (
    <div className="space-y-4">
      {failed.length > 0 && (
        <Card>
          <CardHeader
            title={`Delivery problems (${failed.length})`}
            subtitle="Never resent automatically. A person must review and create a new version."
          />
          <ul className="divide-y divide-[var(--color-line)]">
            {failed.map((p) => (
              <li key={p.id}>
                <Link href={`/drafts/${p.id}`} className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-[var(--color-canvas)]">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-ink)]">{p.company}</div>
                    <div className="text-xs text-[var(--color-muted)]">{p.recipient}</div>
                  </div>
                  <StatusBadge status={p.status as DraftStatus} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {replied.length > 0 && (
        <Card>
          <CardHeader
            title={`Replies (${replied.length})`}
            subtitle="Follow-up automation is paused for these prospects."
          />
          <ul className="divide-y divide-[var(--color-line)]">
            {replied.map((p) => (
              <li key={p.id}>
                <Link href={`/drafts/${p.id}`} className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-[var(--color-canvas)]">
                  <span className="text-sm font-medium text-[var(--color-ink)]">{p.company}</span>
                  <Badge tone="ok">replied</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title={`Event stream (${rows.length})`} />
        {rows.length === 0 ? (
          <Empty>No delivery or engagement events yet.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                <Badge tone={
                  r.type === "replied" ? "ok"
                    : r.type === "bounced" || r.type === "complained" ? "danger" : "neutral"
                }>
                  {r.type}
                </Badge>
                <span className="flex-1 truncate text-[var(--color-ink-2)]">
                  {r.prospectId
                    ? <Link href={`/prospects/${r.prospectId}`} className="hover:underline">{r.company}</Link>
                    : "—"}
                </span>
                <time className="tnum shrink-0 text-xs text-[var(--color-muted)]">
                  {r.at.toISOString().replace("T", " ").slice(0, 16)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
