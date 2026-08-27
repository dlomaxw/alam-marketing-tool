import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

/**
 * Cloudflare R2 via the S3-compatible API.
 *
 * Section 14 requires that source PDFs and brand assets are never reachable
 * through a public URL. The bucket therefore stays private and the application
 * serves files itself, or issues a short-lived signed URL — nothing is ever
 * hot-linked from an email.
 */

let client: S3Client | null = null;

export function storageConfigured(): boolean {
  return Boolean(env.R2_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

function getClient(): S3Client {
  if (!storageConfigured()) {
    throw new Error(
      "Object storage is not configured. Set R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.",
    );
  }
  client ??= new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

/** Content-addressed key: the same file uploaded twice does not duplicate. */
export function storageKeyFor(prefix: string, filename: string, checksum: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
  return `${prefix}/${checksum.slice(0, 16)}/${safe}`;
}

export async function putObject(
  key: string, body: Uint8Array, contentType: string,
): Promise<void> {
  await getClient().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

export async function getObject(key: string): Promise<Uint8Array> {
  const res = await getClient().send(new GetObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
  }));
  return new Uint8Array(await res.Body!.transformToByteArray());
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

/** Short-lived signed URL for an authorized user to download a source file. */
export async function signedDownloadUrl(key: string, expiresIn = 300): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    { expiresIn },
  );
}
