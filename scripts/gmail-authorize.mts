/**
 * One-time Gmail authorization.
 *
 *   npm run gmail:authorize
 *
 * Prints a Google consent URL, waits for the redirect on localhost, exchanges
 * the code for a refresh token and prints the line to paste into .env.local.
 *
 * You complete the sign-in yourself in your own browser. This script never
 * sees your Google password — only the authorization code Google hands back
 * afterwards.
 *
 * Prerequisites, in the Google Cloud Console:
 *   1. Create (or pick) a project.
 *   2. APIs & Services > Library > enable "Gmail API".
 *   3. APIs & Services > OAuth consent screen > External. Add your own Gmail
 *      address under "Test users", or the consent step will be refused.
 *   4. Credentials > Create credentials > OAuth client ID > Web application.
 *      Add this exact authorized redirect URI:
 *          http://localhost:53682/oauth2callback
 *   5. Put the client id and secret in .env.local as GMAIL_CLIENT_ID and
 *      GMAIL_CLIENT_SECRET, then run this script.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { GMAIL_SCOPE } from "../src/lib/email/gmail";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env.local first.\n" +
    "See the comment at the top of this script for how to create them.",
  );
  process.exit(1);
}

/** Guards against a stray request to the callback completing the exchange. */
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", GMAIL_SCOPE);
// offline + consent together are what actually produce a refresh token;
// without prompt=consent Google omits it on repeat authorizations.
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

console.log("\nOpen this URL in your browser and approve access:\n");
console.log(authUrl.toString());
console.log("\nWaiting for the redirect…\n");

const code: string = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname !== "/oauth2callback") {
      res.writeHead(404).end("Not found");
      return;
    }

    const error = url.searchParams.get("error");
    const returned = url.searchParams.get("code");

    if (url.searchParams.get("state") !== state) {
      res.writeHead(400).end("State mismatch. Start again.");
      server.close();
      reject(new Error("State mismatch — the callback did not come from this run."));
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      `<!doctype html><meta charset="utf-8">
       <body style="font:16px system-ui;padding:3rem;max-width:32rem">
       <h1 style="font-size:1.1rem">${error ? "Authorization failed" : "Authorization complete"}</h1>
       <p>${error ? error : "You can close this tab and return to the terminal."}</p>
       </body>`,
    );
    server.close();

    if (error) reject(new Error(`Google returned: ${error}`));
    else if (!returned) reject(new Error("No authorization code in the callback."));
    else resolve(returned);
  });

  server.listen(PORT);
  setTimeout(() => {
    server.close();
    reject(new Error("Timed out after 5 minutes waiting for the redirect."));
  }, 5 * 60_000).unref();
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`\nToken exchange failed (${res.status}):\n${text}`);
  process.exit(1);
}

const json = JSON.parse(text) as { refresh_token?: string; scope?: string };
if (!json.refresh_token) {
  console.error(
    "\nGoogle did not return a refresh token. This happens when the account " +
    "has already granted access. Remove this app at " +
    "https://myaccount.google.com/permissions and run the script again.",
  );
  process.exit(1);
}

console.log("\nAdd this line to .env.local:\n");
console.log(`GMAIL_REFRESH_TOKEN="${json.refresh_token}"`);
console.log(`\nGranted scope: ${json.scope}`);
console.log(
  "\nThen set EMAIL_PROVIDER=gmail and EMAIL_FROM_ADDRESS to the mailbox you " +
  "just authorized.\nKeep the refresh token secret: it can send mail as that account.",
);
