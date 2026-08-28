import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { events, sendJobs, emailDrafts, suppressions } from "@/db/schema";
import { env } from "@/lib/env";
import { writeAudit } from "@/lib/audit";
import { verifyWebhookSignature } from "@/lib/email/webhook-signature";

/**
 * Provider delivery events (specification section 15).
 *
 * Unauthenticated by necessity — the provider holds no session — so the
 * signature is the whole access control. An unsigned or unverifiable request
 * is refused before anything is read out of the body, because the actions
 * behind this endpoint (suppressing a recipient, marking a draft bounced) are
 * exactly what an attacker would want to trigger.
 *
 * Section 13 requires hard bounces and complaints to be suppressed
 * immediately; that happens here rather than on a later sweep.
 */

const ACTOR = "system:email-webhook";

/** Provider event names mapped to what they mean for us. */
const BOUNCE_EVENTS = new Set(["email.bounced"]);
const COMPLAINT_EVENTS = new Set(["email.complained"]);
const DELIVERY_EVENTS = new Set(["email.delivered", "email.sent"]);
const ENGAGEMENT_EVENTS = new Set([
  "email.opened", "email.clicked", "email.delivery_delayed",
]);

interface ResendWebhook {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

export async function POST(request: Request) {
  if (!env.RESEND_WEBHOOK_SECRET) {
    // Refuse rather than accept unverified events: a handler that suppresses
    // recipients must never run on unauthenticated input.
    console.error("[email webhook] RESEND_WEBHOOK_SECRET is not configured");
    return new NextResponse("Webhook not configured", { status: 503 });
  }

  // The raw body is what was signed. Parsing first and re-serializing would
  // change the bytes and invalidate every signature.
  const body = await request.text();

  const verification = verifyWebhookSignature({
    body,
    headers: {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    secret: env.RESEND_WEBHOOK_SECRET,
  });

  if (!verification.ok) {
    console.warn(`[email webhook] rejected: ${verification.reason} — ${verification.detail}`);
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: ResendWebhook;
  try {
    payload = JSON.parse(body) as ResendWebhook;
  } catch {
    return new NextResponse("Malformed JSON", { status: 400 });
  }

  const eventType = payload.type ?? "unknown";
  const providerMessageId = payload.data?.email_id ?? null;
  const svixId = request.headers.get("svix-id")!;

  // Webhooks are delivered at least once. The unique index on external_id is
  // the real guard; this is the cheap check that avoids the round trip.
  const [seen] = await db.select({ id: events.id }).from(events)
    .where(eq(events.externalId, svixId)).limit(1);
  if (seen) return NextResponse.json({ status: "already processed" });

  // Correlate back to the job we created, so the event lands on the right
  // prospect rather than only on an address.
  const [job] = providerMessageId
    ? await db.select().from(sendJobs)
        .where(eq(sendJobs.providerMessageId, providerMessageId)).limit(1)
    : [];

  const [draft] = job
    ? await db.select().from(emailDrafts).where(eq(emailDrafts.id, job.draftId)).limit(1)
    : [];

  const recipient = normalizeRecipient(payload.data?.to) ?? job?.recipientEmail ?? null;

  try {
    await db.insert(events).values({
      prospectId: draft?.prospectId ?? null,
      draftId: draft?.id ?? null,
      sendJobId: job?.id ?? null,
      type: mapEventType(eventType),
      externalId: svixId,
      metadata: {
        providerEvent: eventType,
        providerMessageId,
        recipient,
        bounce: payload.data?.bounce ?? null,
      },
      occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
    });
  } catch (err) {
    // A concurrent redelivery lost the race on the unique index. That is the
    // index doing its job, not a failure worth reporting to the provider.
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ status: "already processed" });
    }
    throw err;
  }

  const isBounce = BOUNCE_EVENTS.has(eventType);
  const isComplaint = COMPLAINT_EVENTS.has(eventType);

  if ((isBounce || isComplaint) && recipient) {
    // Section 13: suppress hard bounces and complaints immediately. A soft
    // bounce is a transient condition and must not permanently exclude a
    // company from ever being contacted again.
    const bounceType = payload.data?.bounce?.type?.toLowerCase();
    const permanent = isComplaint || bounceType !== "transient";

    if (permanent) {
      await db.insert(suppressions).values({
        email: recipient,
        reason: isComplaint
          ? "Recipient marked the message as spam."
          : `Hard bounce: ${payload.data?.bounce?.message ?? "no detail supplied"}`,
        source: isComplaint ? "complaint" : "bounce",
      }).onConflictDoNothing();
    }

    if (draft) {
      // Section 13 also forbids automatic resending after a delivery failure,
      // and both of these are terminal states in the draft state machine.
      await db.update(emailDrafts)
        .set({ status: isComplaint ? "failed" : "bounced" })
        .where(eq(emailDrafts.id, draft.id));
    }

    await writeAudit({
      actorLabel: ACTOR,
      action: isComplaint ? "email.complained" : "email.bounced",
      entity: "send_job",
      entityId: job?.id ?? providerMessageId,
      reason: payload.data?.bounce?.message ?? null,
      metadata: { recipient, permanent, eventType },
    });
  } else if (DELIVERY_EVENTS.has(eventType) && job) {
    await writeAudit({
      actorLabel: ACTOR,
      action: "email.delivered",
      entity: "send_job",
      entityId: job.id,
      metadata: { recipient, eventType },
    });
  }

  return NextResponse.json({ status: "ok", event: eventType });
}

function normalizeRecipient(to: string[] | string | undefined): string | null {
  if (!to) return null;
  const first = Array.isArray(to) ? to[0] : to;
  return first ? first.trim().toLowerCase() : null;
}

/** Provider vocabulary to the event types this application records. */
function mapEventType(providerEvent: string): string {
  if (BOUNCE_EVENTS.has(providerEvent)) return "bounced";
  if (COMPLAINT_EVENTS.has(providerEvent)) return "complained";
  if (DELIVERY_EVENTS.has(providerEvent)) return "delivered";
  if (ENGAGEMENT_EVENTS.has(providerEvent)) {
    return providerEvent.replace(/^email\./, "");
  }
  return providerEvent.replace(/^email\./, "") || "unknown";
}

/** A GET makes it easy to confirm the route is reachable before going live. */
export async function GET() {
  return NextResponse.json({
    endpoint: "email webhook",
    configured: Boolean(env.RESEND_WEBHOOK_SECRET),
    note: "POST signed events here. Unsigned requests are refused.",
  });
}
