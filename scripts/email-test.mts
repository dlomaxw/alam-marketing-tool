/**
 * Sends one clearly-marked test message through the configured provider.
 *
 *   npm run email:test                      -> first allow-listed address
 *   npm run email:test -- me@example.com    -> that address, if allow-listed
 *
 * This proves the transport only: the provider credentials, the sender
 * identity and the DNS behind it. It deliberately does not touch a draft, an
 * approval or a send job, so nothing here can be mistaken for the approved
 * sending path — the kill switch stays exactly as it was.
 *
 * The recipient must appear in TEST_SEND_ALLOWLIST. That is the same rule the
 * real send guard applies to test sends, and it is what stops this script
 * being pointed at a prospect.
 */
import { getEmailProvider } from "../src/lib/email/provider";
import { env, testAllowlist } from "../src/lib/env";

const allow = testAllowlist();
if (allow.length === 0) {
  console.error("TEST_SEND_ALLOWLIST is empty. Add the internal address to .env.local first.");
  process.exit(1);
}

const to = (process.argv[2] ?? allow[0]).trim().toLowerCase();
if (!allow.includes(to)) {
  console.error(
    `Refusing to send to "${to}": it is not in TEST_SEND_ALLOWLIST.\n` +
    `Allow-listed: ${allow.join(", ")}`,
  );
  process.exit(1);
}

const provider = getEmailProvider();
const stamp = new Date().toISOString();

console.log(`provider : ${provider.name}`);
console.log(`from     : ${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM_ADDRESS}>`);
console.log(`reply-to : ${env.EMAIL_REPLY_TO ?? env.EMAIL_FROM_ADDRESS}`);
console.log(`to       : ${to}`);
console.log("");

const text = [
  "*** TEST MESSAGE - NOT SENT TO A PROSPECT ***",
  "",
  "This is a transport test for the ALAM Business Center lease outreach tool.",
  "",
  `Provider : ${provider.name}`,
  `Sender   : ${env.EMAIL_FROM_ADDRESS}`,
  `Sent at  : ${stamp}`,
  "",
  "If this arrived, the provider credentials and sender identity are working.",
  "It says nothing about whether sending is enabled: the global send switch and",
  "the approval workflow are untouched, and no prospect has been contacted.",
].join("\n");

const html = `<div style="font:16px/1.6 Arial,Helvetica,sans-serif;color:#333;max-width:34rem">
  <p style="background:#1A1A1A;color:#FFD400;padding:10px 14px;margin:0 0 18px;font-weight:700;letter-spacing:.06em">
    TEST MESSAGE &mdash; NOT SENT TO A PROSPECT
  </p>
  <p>This is a transport test for the ALAM Business Center lease outreach tool.</p>
  <table style="border-collapse:collapse;font-size:14px">
    <tr><td style="padding:2px 14px 2px 0;color:#6B6B6B">Provider</td><td>${provider.name}</td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#6B6B6B">Sender</td><td>${env.EMAIL_FROM_ADDRESS}</td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#6B6B6B">Sent at</td><td>${stamp}</td></tr>
  </table>
  <p>If this arrived, the provider credentials and sender identity are working.</p>
  <p style="color:#6B6B6B;font-size:13px">It says nothing about whether sending is enabled:
  the global send switch and the approval workflow are untouched, and no prospect
  has been contacted.</p>
</div>`;

try {
  const result = await provider.send({
    to,
    subject: `[TEST] ALAM lease tool transport check via ${provider.name}`,
    html,
    text,
    headers: { "X-ALAM-Test": "true" },
  });
  console.log("accepted by provider");
  console.log(`  message id : ${result.providerMessageId}`);
  console.log(`  detail     : ${result.detail ?? "-"}`);
  console.log("\nCheck the inbox, including spam.");
} catch (err) {
  console.error("send failed:\n");
  console.error(`  ${(err as Error).message}`);
  process.exitCode = 1;
}
