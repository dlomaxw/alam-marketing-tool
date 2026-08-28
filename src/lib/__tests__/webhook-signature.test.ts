/**
 * The webhook endpoint is unauthenticated by necessity and can suppress a
 * recipient, so the signature check is its only access control. These cover
 * the ways a forged or replayed request could get through.
 */
import { describe, it, expect } from "vitest";
import {
  verifyWebhookSignature, signWebhookPayload, TOLERANCE_SECONDS,
} from "../email/webhook-signature";

const SECRET = "whsec_u9perujQGQBx0PY7Rm+N8gUW2Hp1+3ju";
const BODY = JSON.stringify({
  type: "email.bounced",
  data: { email_id: "abc-123", to: ["someone@example.com"] },
});
const ID = "msg_2abc";

function headersFor(opts: {
  body?: string; id?: string; timestamp?: number; secret?: string;
} = {}) {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return {
    id: opts.id ?? ID,
    timestamp: String(timestamp),
    signature: signWebhookPayload({
      body: opts.body ?? BODY,
      id: opts.id ?? ID,
      timestamp,
      secret: opts.secret ?? SECRET,
    }),
  };
}

describe("webhook signature", () => {
  it("accepts a correctly signed payload", () => {
    const r = verifyWebhookSignature({ body: BODY, headers: headersFor(), secret: SECRET });
    expect(r.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    // The attack this exists to stop: a real signature reused over a body
    // naming a different recipient.
    const headers = headersFor();
    const forged = BODY.replace("someone@example.com", "victim@example.com");
    const r = verifyWebhookSignature({ body: forged, headers, secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_matching_signature");
  });

  it("rejects a signature made with a different secret", () => {
    const headers = headersFor({ secret: "whsec_" + Buffer.from("wrong").toString("base64") });
    const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
    expect(r.ok).toBe(false);
  });

  it("rejects a replayed request outside the tolerance", () => {
    const old = Math.floor(Date.now() / 1000) - (TOLERANCE_SECONDS + 60);
    const r = verifyWebhookSignature({
      body: BODY, headers: headersFor({ timestamp: old }), secret: SECRET,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timestamp_out_of_tolerance");
  });

  it("rejects a timestamp too far in the future", () => {
    const future = Math.floor(Date.now() / 1000) + (TOLERANCE_SECONDS + 60);
    const r = verifyWebhookSignature({
      body: BODY, headers: headersFor({ timestamp: future }), secret: SECRET,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timestamp_out_of_tolerance");
  });

  it("still accepts a request at the edge of the tolerance", () => {
    const edge = Math.floor(Date.now() / 1000) - (TOLERANCE_SECONDS - 5);
    const r = verifyWebhookSignature({
      body: BODY, headers: headersFor({ timestamp: edge }), secret: SECRET,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when the id differs from the one that was signed", () => {
    // The id is part of the signed payload, so a swapped id must not verify.
    const headers = { ...headersFor(), id: "msg_different" };
    const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
    expect(r.ok).toBe(false);
  });

  it("rejects missing headers rather than treating them as unsigned", () => {
    for (const missing of ["id", "timestamp", "signature"] as const) {
      const headers = { ...headersFor(), [missing]: null };
      const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("missing_headers");
    }
  });

  it("rejects a non-numeric timestamp", () => {
    const headers = { ...headersFor(), timestamp: "not-a-number" };
    const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_timestamp");
  });

  it("accepts when one of several signatures matches", () => {
    // Svix sends more than one during a secret rotation.
    const good = headersFor();
    const headers = { ...good, signature: `v1,AAAA ${good.signature}` };
    const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
    expect(r.ok).toBe(true);
  });

  it("ignores signature versions it does not understand", () => {
    const headers = { ...headersFor(), signature: "v2,c29tZXRoaW5n" };
    const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
    expect(r.ok).toBe(false);
  });

  it("works with a secret written without the whsec_ label", () => {
    const bare = SECRET.slice("whsec_".length);
    const headers = headersFor({ secret: bare });
    expect(verifyWebhookSignature({ body: BODY, headers, secret: SECRET }).ok).toBe(true);
  });

  it("does not accept an empty signature header", () => {
    const headers = { ...headersFor(), signature: "" };
    const r = verifyWebhookSignature({ body: BODY, headers, secret: SECRET });
    expect(r.ok).toBe(false);
  });
});
