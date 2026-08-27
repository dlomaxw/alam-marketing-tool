import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sourceDocuments } from "@/db/schema";
import { getObject } from "@/lib/storage";
import { guardApi } from "@/lib/auth/api-guard";

/**
 * Serves a stored source document to an authorized user.
 *
 * The R2 driver hands out a short-lived signed URL for this; the local driver
 * has no such concept, so this route is its equivalent. Unlike the brand-asset
 * route — which must be open because mail clients cannot hold a session — this
 * one is authenticated, because source directories are internal documents and
 * section 14 restricts who may export them.
 */
export async function GET(request: Request) {
  const auth = await guardApi("source:upload");
  if (!auth.ok) return auth.response;

  const key = new URL(request.url).searchParams.get("key");
  if (!key) return new NextResponse("Missing key", { status: 400 });

  // Only keys the application itself recorded are servable. This is what stops
  // the parameter being used to read an arbitrary path.
  const [doc] = await db.select().from(sourceDocuments)
    .where(eq(sourceDocuments.storageKey, key)).limit(1);

  if (!doc) return new NextResponse("Not found", { status: 404 });

  let body: Uint8Array;
  try {
    body = await getObject(doc.storageKey);
  } catch (err) {
    console.error("[assets/by-key] failed to read", doc.storageKey, err);
    return new NextResponse("The stored file could not be read.", { status: 502 });
  }

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition":
        `attachment; filename="${doc.filename.replace(/[^A-Za-z0-9._-]+/g, "_")}"`,
    },
  });
}
