/**
 * Verifies the SMTP settings without sending anything.
 *
 *   npm run smtp:check
 *
 * Opens the connection, negotiates STARTTLS and authenticates, then closes.
 * Separating this from the send test matters: if a message does not arrive,
 * this says whether the credentials were ever the problem, rather than leaving
 * "it did not work" covering both the login and the delivery.
 */
import nodemailer from "nodemailer";
import { env } from "../src/lib/env";

if (!env.SMTP_HOST) {
  console.error("SMTP_HOST is not set in .env.local.");
  process.exit(1);
}
if (!env.SMTP_USER || !env.SMTP_PASS) {
  console.error(
    "SMTP_USER and SMTP_PASS must be set in .env.local.\n" +
    "SMTP_USER is the full mailbox address, e.g. leasing@alambusinesscentre.com.",
  );
  process.exit(1);
}

console.log(`host : ${env.SMTP_HOST}:${env.SMTP_PORT}`);
console.log(`user : ${env.SMTP_USER}`);
console.log(`mode : ${env.SMTP_PORT === 465 ? "implicit TLS" : "STARTTLS"}`);
console.log("");

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  connectionTimeout: 20_000,
  greetingTimeout: 20_000,
});

try {
  await transporter.verify();
  console.log("Connection and authentication succeeded.");
  console.log(`\nSend a test with:\n  npm run email:test -- <an allow-listed address>`);
} catch (err) {
  const e = err as NodeJS.ErrnoException & { responseCode?: number };
  console.error("Verification failed:\n");
  console.error(`  ${e.message}`);

  // The three failures that account for almost every case here.
  if (e.responseCode === 535 || /auth/i.test(e.message)) {
    console.error(
      "\n  535 is a rejected login. Check the mailbox address and password.\n" +
      "  Namecheap Private Email expects the full address as the username,\n" +
      "  not just the part before the @.",
    );
  } else if (e.code === "ETIMEDOUT" || e.code === "ECONNREFUSED") {
    console.error(
      "\n  The connection never completed. Port 587 with STARTTLS is the most\n" +
      "  widely reachable option; some networks block 465 outright.",
    );
  } else if (/self.signed|certificate/i.test(e.message)) {
    console.error(
      "\n  A certificate problem usually means something is intercepting TLS\n" +
      "  on this network, rather than a fault at the mail host.",
    );
  }
  process.exitCode = 1;
}
