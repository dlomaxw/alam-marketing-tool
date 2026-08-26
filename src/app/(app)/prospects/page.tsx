import Link from "next/link";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { prospects, contacts } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { Card, CardHeader, Empty, Badge, inputClass, btn } from "@/components/ui";

const SEGMENTS = [
  "vehicle_motorcycle", "appliances_electronics", "supermarket_retail",
  "furniture_interior", "bank_financial", "corporate_hq",
  "wellness_leisure", "unclassified",
] as const;

const STATUSES = ["imported", "needs_data_review", "qualified", "excluded"] as const;

const PAGE_SIZE = 50;

export default async function ProspectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; segment?: string; page?: string }>;
}) {
  await guardPage("prospect:read");
  const sp = await searchParams;

  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const filters: SQL[] = [];

  if (sp.q?.trim()) filters.push(ilike(prospects.companyName, `%${sp.q.trim()}%`));
  if (sp.status && STATUSES.includes(sp.status as never)) {
    filters.push(eq(prospects.status, sp.status as never));
  }
  if (sp.segment && SEGMENTS.includes(sp.segment as never)) {
    filters.push(eq(prospects.segment, sp.segment as never));
  }

  const where = filters.length ? and(...filters) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select({
      id: prospects.id,
      companyName: prospects.companyName,
      segment: prospects.segment,
      floor: prospects.suggestedFloor,
      score: prospects.score,
      status: prospects.status,
      sourcePage: prospects.sourcePage,
      duplicateOfId: prospects.duplicateOfId,
      email: sql<string | null>`(
        SELECT c.email FROM ${contacts} c
        WHERE c.prospect_id = ${prospects.id} AND c.is_primary = true
        LIMIT 1
      )`,
    })
      .from(prospects)
      .where(where)
      .orderBy(desc(prospects.score), prospects.companyName)
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(prospects).where(where),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={`Prospects (${total.toLocaleString()})`}
          subtitle="Sorted by relevance score. Every record traces to a directory page."
        />
        <form className="flex flex-wrap gap-2 px-5 py-4">
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search company name"
            className={`${inputClass} max-w-xs`}
          />
          <select name="status" defaultValue={sp.status ?? ""} className={`${inputClass} max-w-48`}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
          <select name="segment" defaultValue={sp.segment ?? ""} className={`${inputClass} max-w-56`}>
            <option value="">Any segment</option>
            {SEGMENTS.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
          <button className={btn.primary}>Filter</button>
          <Link href="/prospects" className={btn.ghost}>Reset</Link>
        </form>

        {rows.length === 0 ? (
          <Empty>No prospects match. Upload the directory under Sources to import them.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-y border-[var(--color-line)] bg-[var(--color-canvas)] text-left text-xs text-[var(--color-muted)]">
                <tr>
                  <th className="px-5 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Segment → floor</th>
                  <th className="px-3 py-2 font-medium">Primary email</th>
                  <th className="px-3 py-2 font-medium">Page</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {rows.map((r) => (
                  <tr key={r.id} className="transition hover:bg-[var(--color-canvas)]">
                    <td className="px-5 py-2.5">
                      <Link href={`/prospects/${r.id}`} className="font-medium text-[var(--color-ink)] hover:underline">
                        {r.companyName}
                      </Link>
                      {r.duplicateOfId && (
                        <span className="ml-2"><Badge tone="warn">duplicate?</Badge></span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-muted)]">
                      {r.segment.replace(/_/g, " ")} → {r.floor}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--color-muted)]">{r.email ?? "—"}</td>
                    <td className="tnum px-3 py-2.5 text-[var(--color-muted)]">{r.sourcePage ?? "—"}</td>
                    <td className="tnum px-3 py-2.5 text-right font-medium">{r.score}</td>
                    <td className="px-5 py-2.5">
                      <Badge tone={
                        r.status === "excluded" ? "danger"
                          : r.status === "needs_data_review" ? "warn"
                          : r.status === "qualified" ? "ok" : "neutral"
                      }>
                        {r.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-[var(--color-line)] px-5 py-3 text-sm">
            <span className="text-[var(--color-muted)]">Page {page} of {pages}</span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link href={buildHref(sp, page - 1)} className={btn.ghost}>Previous</Link>
              )}
              {page < pages && (
                <Link href={buildHref(sp, page + 1)} className={btn.ghost}>Next</Link>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function buildHref(sp: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && k !== "page") params.set(k, v);
  params.set("page", String(page));
  return `/prospects?${params}`;
}
