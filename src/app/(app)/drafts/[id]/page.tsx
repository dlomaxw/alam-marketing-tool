import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  emailDrafts, prospects, contacts, campaigns, draftEvidence,
  approvals, users, sourcePages,
} from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { getSendSwitch } from "@/lib/settings";
import { availableActions, type DraftStatus } from "@/lib/draft-state";
import { authorizeSend } from "@/lib/email/send-guard";
import { Card, CardHeader, StatusBadge, Badge, SendStateBanner, Empty } from "@/components/ui";
import { ReviewPanel } from "./review-panel";
import { EmailPreview } from "./email-preview";
import { EditPanel } from "./edit-panel";

/**
 * Reviewer screen, specification section 8.2.
 *
 * Left: who this is and where the facts came from. Centre: exactly what the
 * recipient will see. Right: the evidence behind every personalized claim,
 * the automated risk flags, and the version and approval history.
 */
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("draft:read");
  const { id } = await params;

  const [draft] = await db.select().from(emailDrafts).where(eq(emailDrafts.id, id)).limit(1);
  if (!draft) notFound();

  const [prospect] = await db.select().from(prospects)
    .where(eq(prospects.id, draft.prospectId)).limit(1);
  const [campaign] = await db.select().from(campaigns)
    .where(eq(campaigns.id, draft.campaignId)).limit(1);
  const contact = draft.contactId
    ? (await db.select().from(contacts).where(eq(contacts.id, draft.contactId)).limit(1))[0]
    : null;

  const [evidence, versions, decisions, send] = await Promise.all([
    db.select().from(draftEvidence).where(eq(draftEvidence.draftId, draft.id)),
    db.select({
      id: emailDrafts.id, version: emailDrafts.version, status: emailDrafts.status,
      hash: emailDrafts.contentHash, createdAt: emailDrafts.createdAt,
    }).from(emailDrafts).where(eq(emailDrafts.threadId, draft.threadId))
      .orderBy(desc(emailDrafts.version)),
    db.select({
      id: approvals.id, decision: approvals.decision, reason: approvals.reason,
      version: approvals.draftVersion, hash: approvals.contentHash,
      at: approvals.createdAt, approver: users.email,
    }).from(approvals)
      .innerJoin(users, eq(users.id, approvals.approverId))
      .where(eq(approvals.draftId, draft.id))
      .orderBy(desc(approvals.createdAt)),
    getSendSwitch(),
  ]);

  // The source snippet behind the directory listing, so a reviewer can read
  // the original entry rather than trusting the parsed fields.
  const sourceSnippet = prospect?.sourceDocumentId && prospect.sourcePage
    ? (await db.select({ text: sourcePages.text }).from(sourcePages)
        .where(eq(sourcePages.sourceDocumentId, prospect.sourceDocumentId))
        .limit(1))[0]
    : null;

  const actions = availableActions(draft.status as DraftStatus, user);

  // Show the reviewer the live send verdict rather than an optimistic button.
  const sendCheck = draft.status === "approved" || draft.status === "queued"
    ? await authorizeSend({ draftId: draft.id, actorId: user.id })
    : null;

  const issues = (draft.generationMeta?.issues ?? []) as {
    code: string; severity: string; message: string; excerpt?: string;
  }[];

  return (
    <div className="space-y-4">
      <SendStateBanner enabled={send.enabled} reason={send.reason} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">
            {prospect?.companyName ?? "Unknown prospect"}
          </h1>
          <p className="text-sm text-[var(--color-muted)]">
            Version {draft.version} · {campaign?.name} ·{" "}
            <span className="font-mono text-xs">{draft.contentHash.slice(0, 16)}…</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {draft.needsManualReview && <Badge tone="danger">Manual review required</Badge>}
          <StatusBadge status={draft.status as DraftStatus} />
        </div>
      </div>

      {draft.manualReviewReason && (
        /* The reason was always recorded but never shown, which left a
           reviewer to guess why a draft was flagged. */
        <Card className="border-amber-300 bg-[var(--color-warn-bg)] px-5 py-3">
          <p className="text-xs font-semibold text-[var(--color-warn)]">
            Why this needs manual review
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-2)]">
            {draft.manualReviewReason}
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_minmax(0,20rem)]">
        {/* ---------------------------------------------------------- left */}
        <div className="space-y-4">
          <Card>
            <CardHeader title="Prospect" />
            <dl className="space-y-2.5 px-5 py-4 text-sm">
              <Row label="Company" value={prospect?.companyName} />
              <Row label="Sector" value={prospect?.sector} />
              <Row label="Products / services" value={prospect?.productsServices} />
              <Row label="Address" value={prospect?.address} />
              <Row label="Website" value={prospect?.website} />
              <Row label="Directory page" value={prospect?.sourcePage ? `p. ${prospect.sourcePage}` : null} />
              <Row label="Segment" value={`${prospect?.segment} → ${prospect?.suggestedFloor} floor`} />
              <Row label="Relevance score" value={String(prospect?.score ?? "-")} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Recipient" />
            <dl className="space-y-2.5 px-5 py-4 text-sm">
              <Row label="Name" value={contact?.fullName} />
              <Row label="Designation" value={contact?.designation} />
              <Row label="Email" value={draft.recipientEmail} />
              <Row label="Contact confidence" value={contact ? `${contact.confidence}/100` : null} />
              <Row label="Verified" value={contact?.verifiedAt ? "Yes" : "Not verified"} />
            </dl>
          </Card>

          {prospect?.rationale && (
            <Card>
              <CardHeader title="Why this prospect" />
              <p className="px-5 py-4 text-sm text-[var(--color-ink-2)]">{prospect.rationale}</p>
            </Card>
          )}
        </div>

        {/* -------------------------------------------------------- centre */}
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Subject line"
              subtitle="Exactly as the recipient will see it in their inbox."
            />
            <div className="px-5 py-4">
              <p className="text-sm font-medium text-[var(--color-ink)]">{draft.subject}</p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">{draft.previewText}</p>
            </div>
          </Card>

          <EmailPreview html={draft.bodyHtml} text={draft.bodyText} />

          {actions.includes("edit") && (
            <EditPanel
              draftId={draft.id}
              status={draft.status}
              subject={draft.subject}
              previewText={draft.previewText ?? ""}
              salutation={draft.salutation ?? ""}
              bodyInnerHtml={draft.bodyInnerHtml ?? ""}
              ctaLabel={draft.ctaLabel}
              ctaUrl={draft.ctaUrl}
              recipientEmail={draft.recipientEmail ?? ""}
              isApproved={draft.status === "approved"}
            />
          )}
        </div>

        {/* --------------------------------------------------------- right */}
        <div className="space-y-4">
          <ReviewPanel
            draftId={draft.id}
            contentHash={draft.contentHash}
            status={draft.status as DraftStatus}
            actions={actions}
            canApprove={user.permissions.includes("draft:approve")}
            isAuthor={draft.createdBy === user.id}
            mfaSatisfied={user.mfaSatisfied}
            sendFailures={sendCheck && !sendCheck.ok ? sendCheck.failures : []}
            subject={draft.subject}
            recipient={draft.recipientEmail}
            company={prospect?.companyName ?? ""}
          />

          <Card>
            <CardHeader
              title={`Evidence (${evidence.length})`}
              subtitle="Every personalized claim traces to a source."
            />
            {evidence.length === 0 ? (
              <Empty>No evidence recorded. This draft cannot be approved.</Empty>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {evidence.map((e) => (
                  <li key={e.id} className="px-5 py-3">
                    <div className="text-xs font-medium text-[var(--color-ink-2)]">{e.claim}</div>
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{e.snippet}</p>
                    <div className="mt-1 flex gap-3 text-xs text-[var(--color-muted)]">
                      {e.page && <span>Directory p. {e.page}</span>}
                      <span>confidence {e.confidence}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {issues.length > 0 && (
            <Card>
              <CardHeader title={`Automated checks (${issues.length})`} />
              <ul className="divide-y divide-[var(--color-line)]">
                {issues.map((i, n) => (
                  <li key={n} className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={i.severity === "blocking" ? "danger" : "warn"}>
                        {i.severity}
                      </Badge>
                      <span className="font-mono text-xs text-[var(--color-muted)]">{i.code}</span>
                    </div>
                    <p className="mt-1 text-sm text-[var(--color-ink-2)]">{i.message}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Version history" />
            <ul className="divide-y divide-[var(--color-line)]">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <Link
                    href={`/drafts/${v.id}`}
                    className={v.id === draft.id ? "font-medium text-[var(--color-ink)]" : "text-[var(--color-muted)] hover:underline"}
                  >
                    Version {v.version}
                  </Link>
                  <span className="font-mono text-xs text-[var(--color-muted)]">
                    {v.hash.slice(0, 10)}…
                  </span>
                  <StatusBadge status={v.status as DraftStatus} />
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Decisions" />
            {decisions.length === 0 ? (
              <Empty>No decision has been recorded for this version.</Empty>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {decisions.map((dec) => (
                  <li key={dec.id} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone={dec.decision === "approved" ? "ok" : "danger"}>
                        {dec.decision}
                      </Badge>
                      <time className="tnum text-xs text-[var(--color-muted)]">
                        {dec.at.toISOString().slice(0, 16).replace("T", " ")}
                      </time>
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-muted)]">
                      {dec.approver} · v{dec.version} · {dec.hash.slice(0, 10)}…
                    </div>
                    {dec.reason && (
                      <p className="mt-1 text-sm text-[var(--color-ink-2)]">{dec.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {sourceSnippet && (
            <Card>
              <CardHeader title="Directory source" subtitle={`Page ${prospect?.sourcePage}`} />
              <pre className="max-h-56 overflow-auto px-5 py-3 text-xs whitespace-pre-wrap text-[var(--color-muted)]">
                {sourceSnippet.text.slice(0, 1200)}
              </pre>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--color-ink-2)]">{value || "—"}</dd>
    </div>
  );
}
