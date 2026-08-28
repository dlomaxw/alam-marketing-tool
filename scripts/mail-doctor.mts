/**
 * Checks the sending domain's authentication records.
 *
 *   npm run mail:doctor
 *   npm run mail:doctor -- alambusinesscentre.com
 *
 * Section 13 requires SPF, DKIM and DMARC to be configured before production
 * sending. This reports what is actually published in DNS, and whether it
 * authorizes the provider the application is configured to use — a domain can
 * pass SPF for its own mail host and still fail for everything sent through an
 * API provider that was never added to the record.
 *
 * Read-only: it resolves DNS and sends nothing.
 */
import { Resolver } from "node:dns/promises";

const resolver = new Resolver();
// A public resolver, so a local DNS cache cannot report stale records.
resolver.setServers(["8.8.8.8", "1.1.1.1"]);

const domain =
  process.argv[2] ??
  (process.env.EMAIL_FROM_ADDRESS ?? "").split("@")[1] ??
  "";

if (!domain) {
  console.error("No domain. Pass one, or set EMAIL_FROM_ADDRESS in .env.local.");
  process.exit(1);
}

const provider = process.env.EMAIL_PROVIDER ?? "console";

/** Selectors worth probing, by the service that uses them. */
const DKIM_SELECTORS: Record<string, string> = {
  privateemail: "Namecheap Private Email",
  resend: "Resend",
  google: "Google Workspace",
  s1: "generic / Zoho",
  s2: "generic / Zoho",
  k1: "Mailchimp / Mandrill",
  fm1: "Fastmail",
};

/** SPF include: mechanisms that authorize each provider. */
const SPF_INCLUDES: Record<string, string> = {
  resend: "amazonses.com",
  gmail: "_spf.google.com",
  smtp: "spf.privateemail.com",
};

const ok = (s: string) => `  OK       ${s}`;
const warn = (s: string) => `  WARNING  ${s}`;
const bad = (s: string) => `  MISSING  ${s}`;

async function txt(name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

console.log(`\nDomain:   ${domain}`);
console.log(`Provider: ${provider}\n`);

let failures = 0;

/* ------------------------------------------------------------------- MX */

try {
  const mx = await resolver.resolveMx(domain);
  console.log("MX");
  for (const r of mx.sort((a, b) => a.priority - b.priority)) {
    console.log(`  ${String(r.priority).padStart(3)}  ${r.exchange}`);
  }
} catch {
  console.log("MX");
  console.log(warn("no MX records — replies to this domain will not be delivered"));
}

/* ------------------------------------------------------------------ SPF */

console.log("\nSPF");
const spfRecords = (await txt(domain)).filter((r) => r.toLowerCase().startsWith("v=spf1"));

if (spfRecords.length === 0) {
  console.log(bad("no SPF record"));
  failures++;
} else if (spfRecords.length > 1) {
  // More than one SPF record is a permanent error under RFC 7208.
  console.log(warn(`${spfRecords.length} SPF records — RFC 7208 permits only one, so evaluation fails`));
  failures++;
} else {
  const spf = spfRecords[0];
  console.log(`  ${spf}`);

  const needed = SPF_INCLUDES[provider];
  if (needed) {
    if (spf.includes(needed)) {
      console.log(ok(`authorizes ${provider} (include:${needed})`));
    } else {
      console.log(warn(
        `does not authorize ${provider}: no "include:${needed}". ` +
        `Mail sent through ${provider} from @${domain} will fail SPF.`,
      ));
      failures++;
    }
  }

  const all = /[-~?+]all\b/.exec(spf)?.[0];
  if (all === "-all") console.log(ok("strict fail policy (-all)"));
  else if (all === "~all") console.log(ok("softfail policy (~all) — fine while establishing reputation"));
  else console.log(warn(`policy "${all ?? "none"}" is permissive`));
}

/* ----------------------------------------------------------------- DKIM */

console.log("\nDKIM");
let foundDkim = false;
for (const [selector, label] of Object.entries(DKIM_SELECTORS)) {
  const records = await txt(`${selector}._domainkey.${domain}`);
  const dkim = records.find((r) => r.toLowerCase().includes("v=dkim1"));
  if (!dkim) continue;

  foundDkim = true;
  const key = /p=([A-Za-z0-9+/=]*)/.exec(dkim)?.[1] ?? "";
  const bits = key ? Math.round((key.length * 3) / 4 - 38) * 8 : 0;
  const detail = key.length === 0
    ? "key revoked (empty p=)"
    : `~${bits >= 2000 ? 2048 : 1024}-bit key`;
  console.log(ok(`${selector}._domainkey — ${label}, ${detail}`));
}
if (!foundDkim) {
  console.log(bad("no DKIM record found at any known selector"));
  failures++;
}
if (provider === "resend" && !(await txt(`resend._domainkey.${domain}`)).length) {
  console.log(warn("provider is resend but resend._domainkey is not published"));
  failures++;
}

/* ---------------------------------------------------------------- DMARC */

console.log("\nDMARC");
const dmarc = (await txt(`_dmarc.${domain}`)).find((r) => r.toLowerCase().startsWith("v=dmarc1"));

if (!dmarc) {
  console.log(bad("no DMARC record — required by section 13 before production sending"));
  console.log("\n  Add this TXT record to start in monitoring mode:");
  console.log(`    Host:  _dmarc`);
  console.log(`    Value: v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1`);
  console.log("  Once reports look clean, tighten p=none to p=quarantine, then p=reject.");
  failures++;
} else {
  console.log(`  ${dmarc}`);
  const policy = /\bp=(\w+)/.exec(dmarc)?.[1];
  if (policy === "none") console.log(ok("monitoring mode — tighten once reports are clean"));
  else if (policy) console.log(ok(`enforcing (p=${policy})`));
  if (!/\brua=/.test(dmarc)) console.log(warn("no rua= address, so no aggregate reports arrive"));
}

/* --------------------------------------------------------------- verdict */

console.log("");
if (failures === 0) {
  console.log("All checks passed. This domain is ready to authenticate outbound mail.");
} else {
  console.log(`${failures} issue(s) to resolve before production sending.`);
  process.exitCode = 1;
}
