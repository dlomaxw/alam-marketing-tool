import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Filesystem storage driver.
 *
 * Used when object storage is unreachable or deliberately not configured, so
 * that ingestion still works and the original file is still retained — section
 * 5.1 requires keeping the source document, and dropping it silently because
 * the network is blocked would break the audit trail.
 *
 * Not intended for a multi-instance deployment: files live on one machine's
 * disk. Production should use R2.
 */

const ROOT = resolve(process.env.LOCAL_STORAGE_DIR ?? "storage");

/**
 * Keys are built by the application, but this is the boundary where a
 * traversal would become a real file write, so it is enforced here rather
 * than trusted from the caller.
 */
function pathFor(key: string): string {
  const target = resolve(join(ROOT, key));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    throw new Error(`Refusing to access "${key}" outside the storage directory.`);
  }
  return target;
}

export async function putObject(key: string, body: Uint8Array): Promise<void> {
  const target = pathFor(key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

export async function getObject(key: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(pathFor(key)));
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await unlink(pathFor(key));
  } catch (err) {
    // Deleting something already gone is the desired end state.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * There is no signed-URL concept on local disk. Callers get the application's
 * own authenticated asset route, which is what the R2 driver's signed URL
 * ultimately protects too.
 */
export function downloadUrl(key: string): string {
  return `/api/assets/by-key?key=${encodeURIComponent(key)}`;
}

