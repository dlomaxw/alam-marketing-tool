import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { sourceDocuments, users } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import { storageStatus } from "@/lib/storage";
import { Card, CardHeader, Empty, Badge } from "@/components/ui";
import { UploadForm } from "./upload-form";

export default async function SourcesPage() {
  await guardPage("source:upload");
  const storage = storageStatus();

  const rows = await db
    .select({
      id: sourceDocuments.id,
      filename: sourceDocuments.filename,
      sizeBytes: sourceDocuments.sizeBytes,
      pageCount: sourceDocuments.pageCount,
      status: sourceDocuments.status,
      checksum: sourceDocuments.checksum,
      error: sourceDocuments.error,
      createdAt: sourceDocuments.createdAt,
      uploader: users.email,
    })
    .from(sourceDocuments)
    .innerJoin(users, eq(users.id, sourceDocuments.uploadedBy))
    .orderBy(desc(sourceDocuments.createdAt));

  return (
    <div className="space-y-4">
      {storage.ready ? (
        <p className="px-1 text-xs text-[var(--color-muted)]">
          Storage: <span className="font-medium text-[var(--color-ink-2)]">{storage.driver}</span> — {storage.detail}
        </p>
      ) : (
        <Card className="border-amber-300 bg-[var(--color-warn-bg)] px-5 py-3 text-sm text-[var(--color-warn)]">
          Uploads will fail: {storage.detail}
        </Card>
      )}

      <Card>
        <CardHeader
          title="Upload a source directory"
          subtitle="The original file, its checksum and every extracted page are retained so each claim stays auditable."
        />
        <UploadForm />
      </Card>

      <Card>
        <CardHeader title={`Source documents (${rows.length})`} />
        {rows.length === 0 ? (
          <Empty>No source has been uploaded yet.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {rows.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--color-ink)]">
                      {r.filename}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                      <span>{(r.sizeBytes / 1_048_576).toFixed(1)} MB</span>
                      {r.pageCount && <span>{r.pageCount} pages</span>}
                      <span>uploaded by {r.uploader}</span>
                      <span className="font-mono">{r.checksum.slice(0, 12)}…</span>
                    </div>
                  </div>
                  <Badge tone={
                    r.status === "extracted" ? "ok"
                      : r.status === "failed" ? "danger" : "warn"
                  }>
                    {r.status}
                  </Badge>
                </div>
                {r.error && (
                  <p className="mt-2 rounded bg-[var(--color-danger-bg)] px-3 py-2 text-xs text-[var(--color-alam-red)]">
                    {r.error}
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
