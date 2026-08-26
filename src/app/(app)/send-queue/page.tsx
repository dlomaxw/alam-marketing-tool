import Link from "next/link";
import { desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sendJobs, emailDrafts, prospects, users } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { getSendSwitch } from "@/lib/settings";
import { Card, CardHeader, Empty, Badge, SendStateBanner, StatusBadge } from "@/components/ui";
import { CancelButton } from "./cancel-button";
import type { DraftStatus } from "@/lib/draft-state";

export default async function SendQueuePage() {
  const user = await guardPage("draft:read");
  const send = await getSendSwitch();

  const [jobs, approved] = await Promise.all([
    db.select({
      id: sendJobs.id,
      status: sendJobs.status,
      recipient: sendJobs.recipientEmail,
      isTest: sendJobs.isTest,
      scheduledAt: sendJobs.scheduledAt,
      sentAt: sendJobs.sentAt,
      error: sendJobs.error,
      attempts: sendJobs.attempts,
      providerMessageId: sendJobs.providerMessageId,
      draftId: sendJobs.draftId,
      company: prospects.companyName,
      subject: emailDrafts.subject,
      createdBy: users.email,
    })
      .from(sendJobs)
      .innerJoin(emailDrafts, eq(emailDrafts.id, sendJobs.draftId))
      .innerJoin(prospects, eq(prospects.id, emailDrafts.prospectId))
      .leftJoin(users, eq(users.id, sendJobs.createdBy))
      .orderBy(desc(sendJobs.createdAt))
      .limit(100),

    db.select({
      id: emailDrafts.id,
      subject: emailDrafts.subject,
      recipient: emailDrafts.recipientEmail,
      status: emailDrafts.status,
      company: prospects.companyName,
    })
      .from(emailDrafts)
      .innerJoin(prospects, eq(prospects.id, emailDrafts.prospectId))
      .where(eq(emailDrafts.status, "approved"))
      .orderBy(desc(emailDrafts.createdAt))
      .limit(50),
  ]);

  const canCancel = user.permissions.includes("email:cancel");

  return (
    <div className="space-y-4">
      <SendStateBanner enabled={send.enabled} reason={send.reason} />

      <Card>
        <CardHeader
          title={`Approved, not yet queued (${approved.length})`}
          subtitle="Approved messages wait here until somebody explicitly schedules or sends them."
        />
        {approved.length === 0 ? (
          <Empty>Nothing is approved and waiting.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {approved.map((d) => (
              <li key={d.id}>
                <Link href={`/drafts/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-[var(--color-canvas)]">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-ink)]">{d.company}</div>
                    <div className="truncate text-sm text-[var(--color-muted)]">{d.subject}</div>
                    <div className="text-xs text-[var(--color-muted)]">{d.recipient}</div>
                  </div>
                  <StatusBadge status={d.status as DraftStatus} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={`Send jobs (${jobs.length})`}
          subtitle="The worker re-runs every authorization check immediately before delivery."
        />
        {jobs.length === 0 ? (
          <Empty>No send job has been created.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {jobs.map((j) => (
              <li key={j.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/drafts/${j.draftId}`} className="text-sm font-medium text-[var(--color-ink)] hover:underline">
                        {j.company}
                      </Link>
                      {j.isTest && <Badge tone="warn">TEST</Badge>}
                    </div>
                    <div className="truncate text-sm text-[var(--color-muted)]">{j.subject}</div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                      <span>{j.recipient}</span>
                      {j.createdBy && <span>queued by {j.createdBy}</span>}
                      <span>attempts {j.attempts}</span>
                      {j.providerMessageId && (
                        <span className="font-mono">{j.providerMessageId.slice(0, 24)}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={
                      j.status === "sent" ? "ok"
                        : j.status === "failed" ? "danger"
                        : j.status === "cancelled" ? "warn" : "neutral"
                    }>
                      {j.status}
                    </Badge>
                    {j.status === "queued" && canCancel && <CancelButton jobId={j.id} />}
                  </div>
                </div>

                {j.error && (
                  <p className="mt-2 rounded bg-[var(--color-danger-bg)] px-3 py-2 text-xs text-[var(--color-alam-red)]">
                    {j.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
