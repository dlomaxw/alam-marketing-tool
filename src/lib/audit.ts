import { db, type Db } from "@/db";
import { auditLog } from "@/db/schema";

/** Keys whose values are replaced with a marker before anything is stored. */
const REDACT = /^(password|passwordHash|mfaSecret|token|secret|apiKey|authorization|smtpPass)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface AuditEntry {
  actorId?: string | null;
  /** Human-readable actor, e.g. an email or "system:send-worker". */
  actorLabel: string;
  action: string;
  entity: string;
  entityId?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append-only. Never throws into the caller: losing an audit row is bad, but
 * failing the surrounding action because logging hiccuped is worse for a
 * workflow whose whole point is recording human decisions. Failures are
 * written to stderr so they surface in the platform log.
 *
 * Pass `tx` to keep the entry inside the caller's transaction where the write
 * genuinely must be atomic with the action (approvals, send jobs).
 */
export async function writeAudit(entry: AuditEntry, tx?: Db): Promise<void> {
  const client = tx ?? db;
  try {
    await client.insert(auditLog).values({
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      beforeHash: entry.beforeHash ?? null,
      afterHash: entry.afterHash ?? null,
      reason: entry.reason ?? null,
      metadata: (entry.metadata
        ? (redact(entry.metadata) as Record<string, unknown>)
        : null),
      ip: entry.ip ?? null,
    });
  } catch (err) {
    if (tx) throw err; // caller asked for atomicity; honour it
    console.error("[audit] failed to write entry", entry.action, err);
  }
}
