import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";

export interface OutboundMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
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

function smtpProvider(): EmailProvider {
  if (!env.SMTP_HOST) {
    throw new Error("EMAIL_PROVIDER is smtp but SMTP_HOST is not configured.");
  }
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  return {
    name: "smtp",
    async send(message) {
      const info = await transporter!.sendMail({
        from: { name: env.EMAIL_FROM_NAME, address: env.EMAIL_FROM_ADDRESS },
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

export function getEmailProvider(): EmailProvider {
  return env.EMAIL_PROVIDER === "smtp" ? smtpProvider() : consoleProvider;
}
