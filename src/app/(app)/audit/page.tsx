import { desc, sql, and, ilike, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { Card, CardHeader, Empty, Badge, inputClass, btn } from "@/components/ui";
import Link from "next/link";

const PAGE_SIZE = 100;

/**
 * Read-only compliance history. There is no edit or delete affordance
 * anywhere on this page by design: an audit trail that can be tidied up is
 * not an audit trail.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string; page?: string }>;
}) {
  await guardPage("audit:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const filters: SQL[] = [];
  if (sp.action?.trim()) filters.push(ilike(auditLog.action, `%${sp.action.trim()}%`));
  if (sp.actor?.trim()) filters.push(ilike(auditLog.actorLabel, `%${sp.actor.trim()}%`));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db.select().from(auditLog).where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    db.select({ total: sql<number>`count(*)::int` }).from(auditLog).where(where),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader
        title={`Audit log (${total.toLocaleString()})`}
        subtitle="Append-only. Secrets and personal data are redacted before anything is written."
      />

      <form className="flex flex-wrap gap-2 px-5 py-4">
        <input name="action" defaultValue={sp.action ?? ""} placeholder="Action contains…" className={`${inputClass} max-w-xs`} />
        <input name="actor" defaultValue={sp.actor ?? ""} placeholder="Actor contains…" className={`${inputClass} max-w-xs`} />
        <button className={btn.primary}>Filter</button>
        <Link href="/audit" className={btn.ghost}>Reset</Link>
      </form>

      {rows.length === 0 ? (
        <Empty>No audit entries match.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-[var(--color-line)] bg-[var(--color-canvas)] text-left text-xs text-[var(--color-muted)]">
              <tr>
                <th className="px-5 py-2 font-medium">When (UTC)</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Hash before → after</th>
                <th className="px-5 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="tnum px-5 py-2 whitespace-nowrap text-xs text-[var(--color-muted)]">
                    {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-ink-2)]">{r.actorLabel}</td>
                  <td className="px-3 py-2">
                    <Badge tone={
                      r.action.includes("failed") || r.action.includes("refused") || r.action.includes("blocked")
                        ? "danger"
                        : r.action.includes("approved") || r.action.includes("delivered")
                        ? "ok" : "neutral"
                    }>
                      {r.action}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-muted)]">
                    {r.entity}
                    {r.entityId && <div className="font-mono">{r.entityId.slice(0, 8)}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">
                    {r.beforeHash ? r.beforeHash.slice(0, 8) : "—"} → {r.afterHash ? r.afterHash.slice(0, 8) : "—"}
                  </td>
                  <td className="px-5 py-2 text-xs text-[var(--color-ink-2)]">{r.reason ?? "—"}</td>
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
            {page > 1 && <Link href={`/audit?page=${page - 1}`} className={btn.ghost}>Previous</Link>}
            {page < pages && <Link href={`/audit?page=${page + 1}`} className={btn.ghost}>Next</Link>}
          </div>
        </div>
      )}
    </Card>
  );
}
