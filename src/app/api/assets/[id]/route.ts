import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brandAssets } from "@/db/schema";
import { getObject } from "@/lib/storage/r2";

/**
 * Serves brand assets from the application's own domain.
 *
 * Section 6 forbids hot-linking a recipient's logo, and section 14 forbids
 * exposing stored files through public object-storage URLs. So the R2 bucket
 * stays private and this route is the only way out.
 *
 * It is deliberately unauthenticated: the fetch comes from the recipient's
 * mail client, which cannot hold a session. The access rule is therefore the
 * asset's own approval state — only an approved asset is ever served, so an
 * uploaded-but-unapproved logo is unreachable even if its id leaks.
 */

const IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const [asset] = await db.select().from(brandAssets)
    .where(eq(brandAssets.id, id)).limit(1);

  // A single 404 for "missing" and "not approved" alike: distinguishing them
  // would confirm the existence of assets a caller has no right to know about.
  if (!asset || asset.approvalStatus !== "approved") {
    return new NextResponse("Not found", { status: 404 });
  }

  if (!IMAGE_TYPES.has(asset.mimeType)) {
    return new NextResponse("Unsupported asset type", { status: 415 });
  }

  let body: Uint8Array;
  try {
    body = await getObject(asset.fileKey);
  } catch (err) {
    console.error("[assets] failed to read", asset.fileKey, err);
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(body.byteLength),
      // Approval is immutable per asset id, so this can cache hard. Mail
      // clients and proxies fetch these repeatedly.
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
