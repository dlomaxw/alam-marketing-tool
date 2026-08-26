import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaigns, users, emailDrafts } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { Card, CardHeader, Empty, Badge } from "@/components/ui";

export default async function CampaignsPage() {
  await guardPage("campaign:read");

  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      objective: campaigns.objective,
      segment: campaigns.segment,
      floor: campaigns.targetFloor,
      cta: campaigns.ctaLabel,
      sender: campaigns.senderEmail,
      dailyLimit: campaigns.dailyLimit,
      status: campaigns.status,
      owner: users.email,
      draftCount: sql<number>`(
        SELECT count(*)::int FROM ${emailDrafts} d WHERE d.campaign_id = ${campaigns.id}
      )`,
    })
    .from(campaigns)
    .innerJoin(users, eq(users.id, campaigns.ownerId))
    .orderBy(desc(campaigns.createdAt));

  return (
    <Card>
      <CardHeader
        title={`Campaigns (${rows.length})`}
        subtitle="A campaign defines the offer, call to action and sender identity. It never sends anything by itself."
      />
      {rows.length === 0 ? (
        <Empty>No campaign has been created.</Empty>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {rows.map((c) => (
            <li key={c.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--color-ink)]">{c.name}</div>
                  <p className="mt-0.5 text-sm text-[var(--color-muted)]">{c.objective}</p>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                    <span>{c.segment.replace(/_/g, " ")} → {c.floor} floor</span>
                    <span>CTA: {c.cta}</span>
                    <span>from {c.sender}</span>
                    <span>owner {c.owner}</span>
                    <span>limit {c.dailyLimit}/day</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>{c.draftCount} drafts</Badge>
                  <Badge tone={c.status === "active" ? "ok" : "neutral"}>{c.status}</Badge>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
