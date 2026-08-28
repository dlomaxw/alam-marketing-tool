import { env } from "@/lib/env";

/**
 * Gmail API sender (specification section 9.1, "Gmail/Workspace API").
 *
 * Uses an OAuth2 refresh token rather than a service account: domain-wide
 * delegation only works on Google Workspace, and this account is a personal
 * mailbox. The refresh token is obtained once with `npm run gmail:authorize`
 * and does not expire unless it is revoked or left unused for six months.
 *
 * Sending as the mailbox owner means messages are signed by Google and land
 * in the account's Sent folder, so replies thread normally — but it also means
 * Gmail's own sending limits and bulk-mail policies apply. See the README.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** Only the send scope. This integration never needs to read the mailbox. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export function gmailConfigured(): boolean {
  return Boolean(
    env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN,
  );
}

interface CachedToken { value: string; expiresAt: number }
let cached: CachedToken | null = null;

/**
 * Access tokens last an hour. Refreshing on every send would add a round trip
 * to each message and burn quota, so one is held until shortly before expiry.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID!,
      client_secret: env.GMAIL_CLIENT_SECRET!,
      refresh_token: env.GMAIL_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(": ") || detail;
    } catch { /* keep raw */ }
    throw new Error(
      `Gmail refused the refresh token (${res.status}): ${detail}. ` +
      `Re-run "npm run gmail:authorize" to issue a new one.`,
    );
  }

  const json = JSON.parse(text) as { access_token: string; expires_in: number };
  cached = {
    value: json.access_token,
    // 60s of slack so a token cannot expire mid-request.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cached.value;
}

/** RFC 2047 encoding, so a non-ASCII subject or display name survives. */
function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function foldableHeader(name: string, value: string): string {
  return `${name}: ${value}`;
}

/**
 * Builds a multipart/alternative message. Section 6.1 requires both an HTML
 * body and a complete plain-text alternative, and the text part must come
 * first so clients that pick the last understandable part choose the HTML.
 */
export function buildMimeMessage(opts: {
  fromName: string;
  fromAddress: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}): string {
  const boundary = `alam_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const lines: string[] = [
    foldableHeader("From", `${encodeHeaderWord(opts.fromName)} <${opts.fromAddress}>`),
    foldableHeader("To", opts.to),
    foldableHeader("Subject", encodeHeaderWord(opts.subject)),
    "MIME-Version: 1.0",
  ];

  if (opts.replyTo) lines.push(foldableHeader("Reply-To", opts.replyTo));
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    // Strip CR/LF: a header value carrying a newline could inject headers.
    lines.push(foldableHeader(k, v.replace(/[\r\n]+/g, " ")));
  }

  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, "");

  const part = (contentType: string, body: string) => [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    // Base64 in 76-character lines, as the spec for the encoding requires.
    Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    "",
  ];

  lines.push(...part("text/plain", opts.text));
  lines.push(...part("text/html", opts.html));
  lines.push(`--${boundary}--`, "");

  return lines.join("\r\n");
}

export function toBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface GmailSendResult { id: string; threadId?: string }

export async function sendViaGmail(mime: string): Promise<GmailSendResult> {
  const token = await getAccessToken();

  const res = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ raw: toBase64Url(mime) }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch { /* keep raw */ }
    throw new Error(`Gmail API returned ${res.status}: ${detail}`);
  }

  return JSON.parse(text) as GmailSendResult;
}
