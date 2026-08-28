import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { buildMimeMessage, sendViaGmail, gmailConfigured } from "./gmail";

export interface OutboundMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Passed to providers that deduplicate, so a retry cannot send twice. */
  idempotencyKey?: string;
}

export interface DeliveryResult {
  providerMessageId: string;
  accepted: boolean;
  detail?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/**
 * Default provider. Writes the message to the server log and returns a
 * synthetic id. Nothing reaches an inbox, so staging can exercise the full
 * queue and audit path without a configured domain.
 */
const consoleProvider: EmailProvider = {
  name: "console",
  async send(message) {
    const id = `console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    console.info(
      [
        "──────── EMAIL (console provider — not delivered) ────────",
        `to:      ${message.to}`,
        `subject: ${message.subject}`,
        `id:      ${id}`,
        "─────────────────────────────────────────────────────────",
        message.text,
        "─────────────────────────────────────────────────────────",
      ].join("\n"),
    );
    return { providerMessageId: id, accepted: true, detail: "console provider" };
  },
};

let transporter: Transporter | null = null;

/**
 * The address mail is actually sent as.
 *
 * A hosted mailbox will only send as itself or a verified alias, and rejects
 * or silently rewrites anything else — which would break DKIM alignment and
 * with it the domain's authentication. The authenticated mailbox is therefore
 * the source of truth, and EMAIL_FROM_ADDRESS is used only when it belongs to
 * the same domain.
 */
export function effectiveSender(): string {
  const configured = env.EMAIL_FROM_ADDRESS.trim().toLowerCase();
  const mailbox = (env.SMTP_USER ?? "").trim().toLowerCase();
  if (!mailbox) return configured;
  if (!configured || !configured.includes("@")) return mailbox;

  const sameDomain = configured.split("@")[1] === mailbox.split("@")[1];
  return sameDomain ? configured : mailbox;
}

function smtpProvider(): EmailProvider {
  const missing = [
    !env.SMTP_HOST && "SMTP_HOST",
    !env.SMTP_USER && "SMTP_USER",
    !env.SMTP_PASS && "SMTP_PASS",
  ].filter(Boolean);

  if (missing.length) {
    throw new EmailConfigurationError(
      `EMAIL_PROVIDER is smtp but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
      `SMTP_USER must be the full mailbox address, e.g. leasing@alambusinesscentre.com.`,
    );
  }

  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
  });

  return {
    name: "smtp",
    async send(message) {
      const info = await transporter!.sendMail({
        from: { name: env.EMAIL_FROM_NAME, address: effectiveSender() },
        to: message.to,
        replyTo: message.replyTo ?? env.EMAIL_REPLY_TO ?? env.EMAIL_FROM_ADDRESS,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });
      return {
        providerMessageId: info.messageId,
        accepted: (info.accepted?.length ?? 0) > 0,
        detail: info.response,
      };
    },
  };
}

/** Failures that mean "this will never work until a human changes something". */
export class EmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 30_000;

function fromHeader(): string {
  // Resend takes the display name inline. Quote it so a comma in the name
  // cannot split the header into two addresses.
  return `"${env.EMAIL_FROM_NAME.replace(/"/g, "")}" <${env.EMAIL_FROM_ADDRESS}>`;
}

function resendProvider(): EmailProvider {
  if (!env.RESEND_API_KEY) {
    throw new EmailConfigurationError(
      "EMAIL_PROVIDER is resend but RESEND_API_KEY is not set.",
    );
  }

  return {
    name: "resend",
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

      let res: Response;
      let body: string;
      try {
        res = await fetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            "content-type": "application/json",
            // Resend deduplicates on this, so a retried worker cannot produce
            // a second copy of an already-accepted message.
            ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from: fromHeader(),
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            reply_to: message.replyTo ?? env.EMAIL_REPLY_TO ?? env.EMAIL_FROM_ADDRESS,
            headers: message.headers,
          }),
          signal: controller.signal,
        });
        body = await res.text();
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(`Resend did not respond within ${RESEND_TIMEOUT_MS / 1000}s.`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        let detail = body.slice(0, 300);
        try {
          const parsed = JSON.parse(body) as { message?: string; name?: string };
          if (parsed.message) detail = parsed.message;
        } catch { /* keep the raw body */ }

        // 401/403 are settings problems, not transient ones. Saying so stops
        // an operator retrying a send that can never succeed as configured.
        if (res.status === 401) {
          throw new EmailConfigurationError(`Resend rejected the API key: ${detail}`);
        }
        if (res.status === 403) {
          throw new EmailConfigurationError(
            `Resend refused the sender "${env.EMAIL_FROM_ADDRESS}": ${detail} ` +
            `A domain must be verified in Resend before it can send to arbitrary recipients.`,
          );
        }
        throw new Error(`Resend returned ${res.status}: ${detail}`);
      }

      const parsed = JSON.parse(body) as { id?: string };
      if (!parsed.id) {
        throw new Error("Resend accepted the request but returned no message id.");
      }

      return {
        providerMessageId: parsed.id,
        accepted: true,
        detail: `resend ${res.status}`,
      };
    },
  };
}

function gmailProvider(): EmailProvider {
  if (!gmailConfigured()) {
    throw new EmailConfigurationError(
      "EMAIL_PROVIDER is gmail but GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and " +
      "GMAIL_REFRESH_TOKEN are not all set. Run \"npm run gmail:authorize\".",
    );
  }

  return {
    name: "gmail",
    async send(message) {
      // Gmail sends as the authorised mailbox; a From that disagrees with it
      // is rewritten by Google, so the configured address must be that account
      // or one of its verified send-as aliases.
      const mime = buildMimeMessage({
        fromName: env.EMAIL_FROM_NAME,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        to: message.to,
        replyTo: message.replyTo ?? env.EMAIL_REPLY_TO ?? env.EMAIL_FROM_ADDRESS,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
      });

      const result = await sendViaGmail(mime);
      return {
        providerMessageId: result.id,
        accepted: true,
        detail: `gmail thread ${result.threadId ?? "unknown"}`,
      };
    },
  };
}

export function getEmailProvider(): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case "gmail": return gmailProvider();
    case "resend": return resendProvider();
    case "smtp": return smtpProvider();
    default: return consoleProvider;
  }
}

export interface EmailStatus {
  provider: string;
  /** True when a send would reach a real mailbox rather than the log. */
  live: boolean;
  ready: boolean;
  sender: string;
  replyTo: string;
  detail: string;
}

/**
 * What an administrator needs to see in Settings: which provider is live, the
 * address mail actually leaves as, and whether it is configured well enough to
 * send at all. Reports configuration only — it opens no connection.
 */
export function emailStatus(): EmailStatus {
  const replyTo = env.EMAIL_REPLY_TO ?? env.EMAIL_FROM_ADDRESS;

  switch (env.EMAIL_PROVIDER) {
    case "smtp": {
      const missing = [
        !env.SMTP_HOST && "SMTP_HOST",
        !env.SMTP_USER && "SMTP_USER",
        !env.SMTP_PASS && "SMTP_PASS",
      ].filter(Boolean);

      return {
        provider: "smtp",
        live: true,
        ready: missing.length === 0,
        sender: effectiveSender(),
        replyTo,
        detail: missing.length
          ? `Not ready: ${missing.join(", ")} not set in the environment.`
          : `Sending through ${env.SMTP_HOST}:${env.SMTP_PORT} as ${effectiveSender()}.`,
      };
    }

    case "resend":
      return {
        provider: "resend",
        live: true,
        ready: Boolean(env.RESEND_API_KEY),
        sender: env.EMAIL_FROM_ADDRESS,
        replyTo,
        detail: env.RESEND_API_KEY
          ? "Sending through the Resend API. The sender's domain must be verified in Resend."
          : "Not ready: RESEND_API_KEY is not set.",
      };

    case "gmail":
      return {
        provider: "gmail",
        live: true,
        ready: gmailConfigured(),
        sender: env.EMAIL_FROM_ADDRESS,
        replyTo,
        detail: gmailConfigured()
          ? "Sending through the Gmail API as the authorized mailbox."
          : "Not ready: run \"npm run gmail:authorize\" to obtain a refresh token.",
      };

    default:
      return {
        provider: "console",
        live: false,
        ready: true,
        sender: env.EMAIL_FROM_ADDRESS,
        replyTo,
        detail: "Messages are written to the server log only. Nothing reaches an inbox.",
      };
  }
}
