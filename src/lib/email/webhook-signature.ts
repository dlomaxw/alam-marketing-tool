import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Svix webhook signature verification, which is what Resend uses.
 *
 * Written out rather than pulled in as a dependency: it is thirty lines of
 * HMAC, and this is the only thing standing between the public internet and a
 * handler that suppresses recipients. Being able to read and test it in full
 * is worth more here than the convenience of a library.
 *
 * The signed payload is `${id}.${timestamp}.${body}` — the raw body exactly as
 * received. Re-serializing parsed JSON would change the bytes and every
 * signature would fail.
 */

/** Reject anything older than this, so a captured request cannot be replayed. */
export const TOLERANCE_SECONDS = 5 * 60;

export type VerifyFailure =
  | "missing_headers"
  | "bad_timestamp"
  | "timestamp_out_of_tolerance"
  | "malformed_secret"
  | "no_matching_signature";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailure; detail: string };

export interface SignatureHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

function decodeSecret(secret: string): Buffer {
  // Svix secrets are base64 behind a "whsec_" label.
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(raw, "base64");
}

function equal(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyWebhookSignature(opts: {
  body: string;
  headers: SignatureHeaders;
  secret: string;
  now?: Date;
}): VerifyResult {
  const { id, timestamp, signature } = opts.headers;

  if (!id || !timestamp || !signature) {
    return {
      ok: false,
      reason: "missing_headers",
      detail: "svix-id, svix-timestamp and svix-signature are all required.",
    };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: "bad_timestamp", detail: "svix-timestamp is not a number." };
  }

  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const drift = Math.abs(nowSeconds - sentAt);
  if (drift > TOLERANCE_SECONDS) {
    return {
      ok: false,
      reason: "timestamp_out_of_tolerance",
      detail: `Timestamp is ${drift}s away from now; the tolerance is ${TOLERANCE_SECONDS}s.`,
    };
  }

  const key = decodeSecret(opts.secret);
  if (key.length === 0) {
    return { ok: false, reason: "malformed_secret", detail: "The signing secret did not decode." };
  }

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${opts.body}`)
    .digest();

  // The header carries space-separated "v1,<base64>" entries, because more
  // than one secret can be live during a rotation.
  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (equal(expected, candidate)) return { ok: true };
  }

  return {
    ok: false,
    reason: "no_matching_signature",
    detail: "No v1 signature in the header matched the computed value.",
  };
}

/** Used by the tests, and by anyone reproducing a signature by hand. */
export function signWebhookPayload(opts: {
  body: string; id: string; timestamp: number; secret: string;
}): string {
  const mac = createHmac("sha256", decodeSecret(opts.secret))
    .update(`${opts.id}.${opts.timestamp}.${opts.body}`)
    .digest("base64");
  return `v1,${mac}`;
}
