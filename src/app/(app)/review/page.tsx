import Link from "next/link";
import { eq, desc, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import { emailDrafts, prospects, contacts } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { getSendSwitch } from "@/lib/settings";
import { Card, CardHeader, Empty, StatusBadge, Badge, SendStateBanner } from "@/components/ui";
import type { DraftStatus } from "@/lib/draft-state";

/**
 * The one-by-one approval queue. Section 8.1 disables bulk approval in
 * version 1, so this page deliberately offers no multi-select: the only way
 * forward is to open a draft and read it.
 */
export default async function ReviewPage() {
  await guardPage("draft:read");
  const send = await getSendSwitch();

  const rows = await db
    .select({
      id: emailDrafts.id,
      version: emailDrafts.version,
      subject: emailDrafts.subject,
      status: emailDrafts.status,
      recipient: emailDrafts.recipientEmail,
      needsManualReview: emailDrafts.needsManualReview,
      riskFlags: emailDrafts.riskFlags,
      createdAt: emailDrafts.createdAt,
      company: prospects.companyName,
      segment: prospects.segment,
      score: prospects.score,
      contactName: contacts.fullName,
    })
    .from(emailDrafts)
    .innerJoin(prospects, eq(prospects.id, emailDrafts.prospectId))
    .leftJoin(contacts, eq(contacts.id, emailDrafts.contactId))
    // Only current versions: a superseded version is history, not work.
    .where(isNull(emailDrafts.supersededById))
    .orderBy(desc(emailDrafts.createdAt))
    .limit(200);

  const waiting = rows.filter((r) => r.status === "needs_review");
  const drafts = rows.filter((r) => r.status === "draft");

  return (
    <div className="space-y-6">
      <SendStateBanner enabled={send.enabled} reason={send.reason} />

      <Card>
        <CardHeader
          title={`Waiting for approval (${waiting.length})`}
          subtitle="Each message is reviewed and decided individually. Bulk approval is disabled."
        />
        {waiting.length === 0 ? (
          <Empty>Nothing is waiting for a decision.</Empty>
        ) : (
          <QueueTable rows={waiting} />
        )}
      </Card>

      <Card>
        <CardHeader
          title={`Drafts not yet submitted (${drafts.length})`}
          subtitle="Generated or edited, never approved."
        />
        {drafts.length === 0 ? <Empty>No open drafts.</Empty> : <QueueTable rows={drafts} />}
      </Card>
    </div>
  );
}

type Row = {
  id: string; version: number; subject: string; status: string;
  recipient: string | null; needsManualReview: boolean; riskFlags: string[];
  company: string; segment: string; score: number; contactName: string | null;
};

function QueueTable({ rows }: { rows: Row[] }) {
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {rows.map((r) => (
        <li key={r.id}>
          <Link
            href={`/drafts/${r.id}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 transition hover:bg-[var(--color-canvas)]"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-[var(--color-ink)]">
                  {r.company}
                </span>
                <span className="shrink-0 text-xs text-[var(--color-muted)]">v{r.version}</span>
              </div>
              <div className="mt-0.5 truncate text-sm text-[var(--color-muted)]">{r.subject}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                <span>{r.recipient ?? "no recipient"}</span>
                {r.contactName && <span>· {r.contactName}</span>}
                <span>· score {r.score}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {r.needsManualReview && <Badge tone="danger">Manual review</Badge>}
              {r.riskFlags.length > 0 && (
                <Badge tone="warn">{r.riskFlags.length} flag{r.riskFlags.length > 1 ? "s" : ""}</Badge>
              )}
              <StatusBadge status={r.status as DraftStatus} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
