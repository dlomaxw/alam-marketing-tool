import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  prospects, contacts, emailDrafts, campaigns, events, sourcePages,
} from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { Card, CardHeader, Empty, Badge, StatusBadge } from "@/components/ui";
import { ProspectActions } from "./prospect-actions";
import type { DraftStatus } from "@/lib/draft-state";

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("prospect:read");
  const { id } = await params;

  const [prospect] = await db.select().from(prospects).where(eq(prospects.id, id)).limit(1);
  if (!prospect) notFound();

  const [contactRows, drafts, campaignRows, eventRows, source] = await Promise.all([
    db.select().from(contacts).where(eq(contacts.prospectId, id)).orderBy(desc(contacts.isPrimary)),
    db.select({
      id: emailDrafts.id, version: emailDrafts.version, subject: emailDrafts.subject,
      status: emailDrafts.status, createdAt: emailDrafts.createdAt,
    }).from(emailDrafts).where(eq(emailDrafts.prospectId, id)).orderBy(desc(emailDrafts.createdAt)),
    db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns)
      .where(eq(campaigns.status, "active")),
    db.select().from(events).where(eq(events.prospectId, id)).orderBy(desc(events.occurredAt)).limit(20),
    prospect.sourceDocumentId
      ? db.select({ text: sourcePages.text }).from(sourcePages)
          .where(eq(sourcePages.sourceDocumentId, prospect.sourceDocumentId)).limit(1)
      : Promise.resolve([]),
  ]);

  const breakdown = prospect.scoreBreakdown ?? {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-ink)]">{prospect.companyName}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {prospect.segment.replace(/_/g, " ")} → {prospect.suggestedFloor} floor ·
            score {prospect.score} · directory p. {prospect.sourcePage ?? "—"}
          </p>
        </div>
        <Badge tone={
          prospect.status === "excluded" ? "danger"
            : prospect.status === "needs_data_review" ? "warn"
            : prospect.status === "qualified" ? "ok" : "neutral"
        }>
          {prospect.status.replace(/_/g, " ")}
        </Badge>
      </div>

      {prospect.duplicateOfId && (
        <Card className="border-amber-300 bg-[var(--color-warn-bg)] px-5 py-3 text-sm text-[var(--color-warn)]">
          This record may duplicate{" "}
          <Link href={`/prospects/${prospect.duplicateOfId}`} className="underline">
            an existing prospect
          </Link>. Records are never merged automatically, so confirm which one
          holds the correct contact before generating anything.
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Directory record" />
            <dl className="grid gap-3 px-5 py-4 sm:grid-cols-2">
              <Row label="Sector" value={prospect.sector} />
              <Row label="Website" value={prospect.website} />
              <Row label="Address" value={prospect.address} />
              <Row label="Products / services" value={prospect.productsServices} />
            </dl>
          </Card>

          <Card>
            <CardHeader
              title={`Contacts (${contactRows.length})`}
              subtitle="Confirm the right recipient before anything is generated."
            />
            {contactRows.length === 0 ? (
              <Empty>No contact was found in the directory entry.</Empty>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {contactRows.map((c) => (
                  <li key={c.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-[var(--color-ink)]">
                          {c.fullName ?? "Unnamed contact"}
                          {c.isPrimary && <span className="ml-2"><Badge tone="ok">primary</Badge></span>}
                        </div>
                        <div className="text-sm text-[var(--color-muted)]">
                          {c.designation ?? "—"} · {c.email ?? "no email"}
                        </div>
                      </div>
                      <Badge tone={c.confidence >= 70 ? "ok" : "warn"}>
                        confidence {c.confidence}
                      </Badge>
                    </div>
                    {c.verifiedAt && (
                      <p className="mt-1 text-xs text-[var(--color-ok)]">
                        Confirmed by a reviewer on {c.verifiedAt.toISOString().slice(0, 10)}.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title={`Drafts (${drafts.length})`} />
            {drafts.length === 0 ? (
              <Empty>No draft has been generated for this prospect.</Empty>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {drafts.map((d) => (
                  <li key={d.id}>
                    <Link href={`/drafts/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-3 transition hover:bg-[var(--color-canvas)]">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-[var(--color-ink)]">{d.subject}</div>
                        <div className="text-xs text-[var(--color-muted)]">Version {d.version}</div>
                      </div>
                      <StatusBadge status={d.status as DraftStatus} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {source[0] && (
            <Card>
              <CardHeader title="Source page text" subtitle={`Directory page ${prospect.sourcePage}`} />
              <pre className="max-h-72 overflow-auto px-5 py-3 text-xs whitespace-pre-wrap text-[var(--color-muted)]">
                {source[0].text.slice(0, 3000)}
              </pre>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <ProspectActions
            prospectId={prospect.id}
            status={prospect.status}
            campaigns={campaignRows}
            contacts={contactRows.map((c) => ({
              id: c.id, label: `${c.fullName ?? "Unnamed"} — ${c.email ?? "no email"}`,
              email: c.email, confidence: c.confidence,
            }))}
            canWrite={user.permissions.includes("prospect:write")}
            canDraft={user.permissions.includes("draft:write")}
            segment={prospect.segment}
          />

          <Card>
            <CardHeader title="Score breakdown" subtitle="Section 5.4, explainable by design." />
            <dl className="space-y-1.5 px-5 py-4 text-sm">
              {Object.entries(breakdown).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <dt className="text-[var(--color-muted)]">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                  <dd className="tnum font-medium">{v}</dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-[var(--color-line)] pt-1.5">
                <dt className="font-medium">Total</dt>
                <dd className="tnum font-semibold">{prospect.score}</dd>
              </div>
            </dl>
            {prospect.rationale && (
              <p className="border-t border-[var(--color-line)] px-5 py-3 text-xs text-[var(--color-muted)]">
                {prospect.rationale}
              </p>
            )}
          </Card>

          {eventRows.length > 0 && (
            <Card>
              <CardHeader title="Engagement" />
              <ul className="divide-y divide-[var(--color-line)]">
                {eventRows.map((e) => (
                  <li key={e.id} className="flex justify-between px-5 py-2 text-sm">
                    <span className="text-[var(--color-ink-2)]">{e.type}</span>
                    <time className="tnum text-xs text-[var(--color-muted)]">
                      {e.occurredAt.toISOString().slice(0, 16).replace("T", " ")}
                    </time>
                  </li>
                ))}
              </ul>
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
      <dd className="mt-0.5 text-sm text-[var(--color-ink-2)]">{value || "—"}</dd>
    </div>
  );
}
