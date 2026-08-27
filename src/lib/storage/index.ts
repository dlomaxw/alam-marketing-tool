import { resolve } from "node:path";
import { env } from "@/lib/env";
import * as r2 from "./r2";

/**
 * The filesystem driver is imported on demand. A static import pulls Node's
 * fs into every route that touches storage, which makes the bundler trace the
 * whole project and ship it in each serverless function — wasteful when
 * production uses R2 and never calls this driver at all.
 */
const localDriver = () => import("./local");

const localRoot = () => resolve(env.LOCAL_STORAGE_DIR);

/**
 * Storage driver selection.
 *
 * R2 is the deployment target, but its endpoints are not always reachable:
 * some networks filter `*.r2.cloudflarestorage.com` by TLS SNI, which surfaces
 * as a raw handshake failure part-way through an upload. The local driver
 * keeps ingestion working in that situation instead of losing the source
 * document, which section 5.1 requires be retained.
 *
 *   auto   R2 when credentials are present, otherwise local (default)
 *   r2     always R2; fail loudly if it is unreachable
 *   local  always the filesystem
 */
export type StorageDriver = "r2" | "local";

export function activeDriver(): StorageDriver {
  const configured = env.STORAGE_DRIVER;
  if (configured === "r2" || configured === "local") return configured;
  return r2.storageConfigured() ? "r2" : "local";
}

export interface StorageStatus {
  driver: StorageDriver;
  /** True when the driver can actually accept a write. */
  ready: boolean;
  detail: string;
}

export function storageStatus(): StorageStatus {
  const driver = activeDriver();
  if (driver === "local") {
    return {
      driver,
      ready: true,
      detail: `Files are stored on this machine under ${localRoot()}. Suitable for development and a single-instance deployment; use R2 in production.`,
    };
  }
  return r2.storageConfigured()
    ? { driver, ready: true, detail: `Files are stored in the private R2 bucket "${env.R2_BUCKET}".` }
    : {
        driver,
        ready: false,
        detail: "STORAGE_DRIVER is r2 but R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are not all set.",
      };
}

export class StorageUnreachableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StorageUnreachableError";
  }
}

/** Network-level failures reaching the object store, as opposed to auth or 404s. */
const NETWORK_CODES = new Set([
  "EPROTO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND",
  "EAI_AGAIN", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isNetworkFailure(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: string }).code;
    if (code && NETWORK_CODES.has(code)) return true;
    const msg = (cur as { message?: string }).message ?? "";
    if (/handshake failure|EPROTO|socket hang up|ssl3_read_bytes/i.test(msg)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Turns a TLS or socket failure into something a reviewer can act on. The raw
 * "write EPROTO ... ssl/tls alert handshake failure ... alert number 40" tells
 * an operator nothing about what to do next.
 */
function rethrow(err: unknown, action: string): never {
  if (isNetworkFailure(err)) {
    throw new StorageUnreachableError(
      `Could not ${action}: the object storage endpoint could not be reached over TLS. ` +
      `This is usually a network restriction rather than a problem with the file or the credentials — ` +
      `some networks block "*.r2.cloudflarestorage.com" by SNI. ` +
      `Set STORAGE_DRIVER=local to store source files on this machine instead.`,
      err,
    );
  }
  throw err;
}

export function storageKeyFor(prefix: string, filename: string, checksum: string): string {
  return r2.storageKeyFor(prefix, filename, checksum);
}

export async function putObject(
  key: string, body: Uint8Array, contentType: string,
): Promise<void> {
  if (activeDriver() === "local") return (await localDriver()).putObject(key, body);
  try {
    await r2.putObject(key, body, contentType);
  } catch (err) {
    rethrow(err, "store the uploaded file");
  }
}

export async function getObject(key: string): Promise<Uint8Array> {
  if (activeDriver() === "local") return (await localDriver()).getObject(key);
  try {
    return await r2.getObject(key);
  } catch (err) {
    rethrow(err, "read the stored file");
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (activeDriver() === "local") return (await localDriver()).deleteObject(key);
  try {
    await r2.deleteObject(key);
  } catch (err) {
    rethrow(err, "delete the stored file");
  }
}

export async function signedDownloadUrl(key: string, expiresIn = 300): Promise<string> {
  if (activeDriver() === "local") return (await localDriver()).downloadUrl(key);
  try {
    return await r2.signedDownloadUrl(key, expiresIn);
  } catch (err) {
    rethrow(err, "produce a download link");
  }
}

/** Kept for callers that only want to know whether storage will accept a write. */
export function storageConfigured(): boolean {
  return storageStatus().ready;
}
