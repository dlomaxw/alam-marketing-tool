import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";

/**
 * Outbound mail.
 *
 * One real provider: SMTP, pointed at the mailbox that hosts the sending
 * domain. The domain's SPF and DKIM already authorise that host, so messages
 * authenticate as they stand.
 *
 * `console` exists alongside it so staging can exercise the whole queue,
 * approval and audit path without anything reaching an inbox. It is not an
 * alternative way to send; it is the way to not send.
 */

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

/** Failures that mean "this will never work until a human changes something". */
export class EmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

/**
 * Writes the message to the server log and returns a synthetic id. Nothing
 * reaches an inbox, so the full pipeline can be exercised safely.
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
 * the source of truth, and EMAIL_FROM_ADDRESS is honoured only when it belongs
 * to the same domain.
 */
export function effectiveSender(): string {
  const configured = env.EMAIL_FROM_ADDRESS.trim().toLowerCase();
  const mailbox = (env.SMTP_USER ?? "").trim().toLowerCase();
  if (!mailbox) return configured;
  if (!configured || !configured.includes("@")) return mailbox;

  const sameDomain = configured.split("@")[1] === mailbox.split("@")[1];
  return sameDomain ? configured : mailbox;
}

function missingSmtpSettings(): string[] {
  return [
    !env.SMTP_HOST && "SMTP_HOST",
    !env.SMTP_USER && "SMTP_USER",
    !env.SMTP_PASS && "SMTP_PASS",
  ].filter(Boolean) as string[];
}

function smtpProvider(): EmailProvider {
  const missing = missingSmtpSettings();
  if (missing.length) {
    throw new EmailConfigurationError(
      `EMAIL_PROVIDER is smtp but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. ` +
      `SMTP_USER must be the full mailbox address, e.g. info@alambusinesscentre.com.`,
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
        replyTo: message.replyTo ?? env.EMAIL_REPLY_TO ?? effectiveSender(),
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

export function getEmailProvider(): EmailProvider {
  return env.EMAIL_PROVIDER === "smtp" ? smtpProvider() : consoleProvider;
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
  const sender = effectiveSender();
  const replyTo = env.EMAIL_REPLY_TO ?? sender;

  if (env.EMAIL_PROVIDER !== "smtp") {
    return {
      provider: "console",
      live: false,
      ready: true,
      sender,
      replyTo,
      detail: "Messages are written to the server log only. Nothing reaches an inbox.",
    };
  }

  const missing = missingSmtpSettings();
  return {
    provider: "smtp",
    live: true,
    ready: missing.length === 0,
    sender,
    replyTo,
    detail: missing.length
      ? `Not ready: ${missing.join(", ")} not set in the environment.`
      : `Sending through ${env.SMTP_HOST}:${env.SMTP_PORT} as ${sender}.`,
  };
}
