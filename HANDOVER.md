# Developer Handover — ALAM Lease Email Approval Tool

For whoever (or whatever) picks this up next. Read this before changing code.
It records what is built, what is deliberately the way it is, what is not
finished, and the specific traps in this codebase.

**Status:** working and deployed. 73 unit tests + 16 integration tests green.
Production sending is **off** and must stay off until the launch checklist at
the end of this document is complete.

- Repo: https://github.com/dlomaxw/alam-marketing-tool
- Live: https://alam-marketing-tool.vercel.app
- Stack: Next.js 16 (App Router) · React 19 · Drizzle · Neon Postgres ·
  Cloudflare R2 · Tailwind 4 · Vitest

---

## 1. What this product actually is

An **approval system that happens to send email**. That ordering matters for
every design decision. Drafting is automated; sending is not, and the codebase
is arranged so that no reasonable mistake — a bug, a retry, a double click, a
stale page, a compromised row — results in an unapproved message reaching a
prospect.

If you are about to make a change that touches drafts, approvals, or delivery,
the question to ask is not "does this work?" but "can this send something
nobody approved?"

---

## 2. The four safety mechanisms

These are independent on purpose. Do not collapse them into one.

**1. Draft versions are immutable.** `email_drafts` rows are never updated in
place for content. An edit inserts a new row (`version + 1`, same `threadId`)
and sets `superseded_by_id` on the old one. See `reviseDraft()` in
`src/lib/drafts.ts`.

**2. Approvals bind to a content hash.** `computeContentHash()` in
`src/lib/content-hash.ts` is a length-prefixed SHA-256 over exactly the nine
fields that reach a recipient. An `approvals` row stores that hash. Change any
of those fields and the hash no longer matches, so the approval stops applying
on its own. This is *why* "editing an approved draft cancels the approval" is
true — it is a property of the data, not a rule someone remembered to write.

> Length-prefixing is not decoration. Without it, subject `"a|b"` could hash
> identically to subject `"a"` + preview `"b"`. There is a test for this.

**3. `authorizeSend()` is the only path to delivery, and it runs twice.**
`src/lib/email/send-guard.ts`. It runs when a user queues a message, and again
**inside the worker immediately before the provider call**. The second run is
the one that matters: between queueing and sending, an approval can be revoked,
a recipient can opt out, or an administrator can hit the kill switch. Because
the worker re-checks, none of those require hunting down in-flight jobs.

**4. The kill switch has two halves.** Delivery requires
`GLOBAL_SEND_ENABLED=true` in the environment **and** the `global_send_enabled`
setting row. Neither a config change nor a database compromise enables sending
alone. Turning the switch off also cancels everything queued.

Additionally: `draft:approve` and `email:send` are separate permissions, both
require an MFA-verified session, an author cannot approve their own draft, and
bulk approval does not exist in this version.

### Where the rules live

| Concern | File | Note |
| --- | --- | --- |
| Status transitions | `src/lib/draft-state.ts` | Pure. The transition table is the source of truth; API routes ask it, they don't reimplement it. |
| Delivery authorization | `src/lib/email/send-guard.ts` | Every check, in one place. |
| Approval binding | `src/lib/content-hash.ts` | Constant-time comparison. |
| Permissions | `src/lib/auth/rbac.ts` | Note what is *absent* per role. |
| Generation safety | `src/lib/ai/validate.ts` | Verifies the model obeyed the prompt. |

---

## 3. Traps in this codebase

Things that have already caused bugs here. Each cost real debugging time.

**Drizzle correlated subqueries.** `${prospects.id}` renders as a bare `"id"`,
which inside a subquery binds to the *inner* table. It fails silently — you get
nulls, not an error. Use `${prospects}.id`. This made every email address on
`/prospects` render blank. See the comment in
`src/app/(app)/prospects/page.tsx`.

**`server-only` breaks scripts.** Any module importing `server-only` throws
outside the Next runtime, so it cannot be used by `scripts/` or the worker. It
is therefore only in `src/lib/auth/session.ts`, which is Next-coupled anyway
via `next/headers`. Don't add it to shared modules.

**Absolute URLs are baked into hashed draft content.** The logo URL comes from
`NEXT_PUBLIC_APP_URL` at generation time and is part of `body_html`, which is
part of the content hash. Drafts generated locally embed
`http://localhost:3000/...` and show a broken logo in production. That is
correct behaviour — the content is immutable — but it means **drafts are
environment-bound**. Regenerate rather than trying to rewrite them.

**Vercel framework preset.** The project was created as "Other", so deployments
served `public/` statically and never ran a build (0ms build, every route 404).
`vercel.json` now pins `"framework": "nextjs"`. Don't remove it.

**`next lint` is gone.** Use `npx eslint .`.

**Careful with unused-import cleanup.** A sed pass removing "unused" imports
silently broke the build by removing `and` from `drafts.ts`, which *was* used.
Always re-run `npx tsc --noEmit` after.

---

## 4. Ingestion — read this before touching the parser

The UMA directory is a 272-page, two-column PDF. Current yield: **1,734
entries, 1,636 with an email address**, median field confidence 91.

Four properties of the source you must not regress:

1. **Columns have no gutter.** The entry separator rules span the full page
   width, so gap detection finds nothing. Columns are detected by **clustering
   text-item left edges** (`detectColumnStarts` in `src/lib/ingestion/pdf.ts`).
   Naive extraction interleaves the columns and splices one company's contacts
   into another's description.

2. **Ligatures are mapped into Latin Extended-B.** `automaƟon`, `Įelds`,
   `plaƞorm`, `eȚciency`, `Cliī`. This corrupts **email addresses** —
   `info@youthplaƞormafrica.com` would hard-bounce. `repairLigatures()` fixes
   them before parsing.

3. **Capitalised lines are ambiguous.** Addresses and products are often in
   capitals too, so "capitalised means company name" is wrong. See
   `extractCompanyAndAddress` — it stops at address patterns and at a legal
   marker.

4. **Section headings appear once, not repeatedly.** "BANKING & FINANCIAL
   SERVICES" sits above the first entry of a section and looked like the first
   line of a two-line company name. Frequency detection does **not** work
   (they occur once). They are stripped only when the line is built purely from
   category words *and* the line beneath it is already a complete company name.

Every one of these has a regression test in
`src/lib/__tests__/parse-uma.test.ts`. If you change the parser, run
`npx tsx scripts/probe-parse.mts source-documents/UMA-Dirrectory-2026.pdf` and
compare the totals above before and after.

---

## 5. Generation

The model gets a compact structured object — never the raw directory — plus
only **management-approved** property facts. Generation is blocked entirely if
no facts are approved.

Pipeline: `generateDraft()` → provider adapter → strict Zod schema →
`validateGeneration()` → render → hash → insert.

`validateGeneration()` independently checks what the prompt asked for: no
unsupported superlatives, no implied partnership or tenancy, no ownership
claims, no fabricated evidence ids or fact keys, no unsafe HTML, non-generic
salutation when a contact name exists. **Blocking issues force
`needs_manual_review`; nothing is auto-corrected**, because the decision
belongs to a person.

The email structure follows the approved reference in
`ALAM_Personalized_Lease_Email_Proposal draft.pdf`: subject formula, `Dear Mr.
Shukla` style salutation, four-paragraph body, pipe-separated signature. See
`src/lib/naming.ts` and the `## Required structure` block in
`src/lib/ai/prompt.ts`.

`PROMPT_VERSION` is stored on every draft. **Bump it when you change the
prompt**, so past drafts stay attributable to the wording that produced them.

### One deliberate deviation from the reference

Where the directory gives a name with no honorific (`RAVI SHUKLA`), the
salutation is `Dear Ravi Shukla`, not `Dear Mr. Shukla`. Supplying the
honorific means inferring gender from a name. A reviewer can add it, which
creates a new version like any other edit. Don't "fix" this without deciding
that trade-off deliberately.

---

## 6. Running it

```bash
npm install
cp .env.example .env.local          # fill in
npm run db:migrate
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' npm run db:seed
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm test` | 73 unit tests, no database |
| `npm run test:db` | 16 integration tests — needs `ALLOW_DB_TESTS=1 AI_PROVIDER=stub` |
| `npm run import:directory` | Load the whole directory into the database |
| `npm run export:directory` | Write the categorized dataset to `exports/` |
| `npm run worker -- --loop` | Poll and process the send queue |

**Integration tests write to the database in `DATABASE_URL`.** They create
tagged fixtures, clean up in `afterAll`, and restore the send switch in a
`finally`. They are opt-in behind `ALLOW_DB_TESTS=1` for that reason. Point
them at a Neon branch if you'd rather not touch the main database.

`AI_PROVIDER=stub` runs the whole workflow offline with a deterministic
generator that **always** flags manual review, so a stub draft can never be
mistaken for a grounded one.

---

## 7. Current state

**Database (Neon):** 1,631 prospects · 2,134 contacts · 12 approved property
facts · 1 user · 0 send jobs · send switch **off**.

**~10 stub drafts exist** from demo runs. They are flagged
`stub_generation` + manual review, and their logo URL points at localhost.
They are safe (nothing can send) but are demo artifacts — delete them when you
want a clean queue.

### Categorized directory

| Category | → Floor | Companies | Emailable |
| --- | --- | --- | --- |
| Furniture & interior | first | 125 | 118 |
| Vehicle & motorcycle | ground | 96 | 93 |
| Corporate HQ | first | 45 | 41 |
| Appliances & electronics | ground | 43 | 40 |
| Banks & financial | first | 36 | 35 |
| Wellness & leisure | second | 24 | 23 |
| Supermarket & retail | ground | 7 | 7 |
| Unclassified | — | 1,358 | 1,279 |

**123 companies** sit in tier 1–2 (score ≥ 60) — the pool for the 20–30 company
pilot. The 1,358 unclassified are mostly food, agro and plastics manufacturers
with no showroom fit; the spec says don't auto-generate for those.

---

## 8. Known gaps — the actual next steps

Ordered by what blocks going live.

**1. OpenRouter has no credits.** `AI_PROVIDER=openrouter` returns **HTTP 402**.
This is the one thing blocking real generation. Top up the account, or set
`ANTHROPIC_API_KEY` and `AI_PROVIDER=anthropic` — the adapter already supports
it, no code change.

**2. Seeded admin password is weak and known.** `ChangeMe-Alam-2026` was used
for setup and appears in the development transcript. Change it, and enrol MFA.

**3. Credentials need rotating.** The Neon password, Cloudflare API token, R2
key pair and OpenRouter key were all transmitted in plaintext during
development.

**4. No email provider configured.** `EMAIL_PROVIDER=console` logs messages and
delivers nothing. Real delivery needs SMTP credentials plus SPF, DKIM and DMARC
on the sending domain.

**5. The deployment is publicly reachable.** Vercel Deployment Protection is
off. Auth protects the app, but consider enabling it or adding SSO if only
ALAM staff should reach the login page.

### Not finished

- **Recipient logo upload UI.** The model, approval gate and `/api/assets/[id]`
  route exist; there is no upload screen. Drafts fall back to the company name
  in text, which is the specified behaviour.
- **Reply / bounce webhooks.** `POST /api/email/webhook` and
  `/api/replies/webhook` from spec §15 are **not implemented**. The data model
  and worker handle the events; nothing receives them. Replies are recorded
  manually via `recordReply()`.
- **Scheduling.** `send_jobs.scheduled_at` is stored and respected by the
  worker, but no UI sets a future date.
- **Retention and deletion procedures** (spec §14) are not implemented.
- **Malware scanning of uploads.** MIME is restricted to PDF; files are not
  scanned.
- **CSP is weak on `script-src`.** It allows `'unsafe-inline'` and
  `'unsafe-eval'` because the Next client runtime needs them without
  nonce-based middleware. Tightening this means adding a nonce middleware.
- **Row-level security** is enforced in the application, not in Postgres. The
  spec asks for row-level permissions; if that matters, add RLS policies.

---

## 9. Before production sending

Delivery must stay off until every one of these is done. Mirrors spec §18/§20.

- [ ] Management verifies and approves all 12 property facts in **Settings**
- [ ] Approved sender name, email, phone and website confirmed
- [ ] H.E. Abid Alam's title and any relationship wording approved (spec §2 —
      ownership language is **not** approved and is blocked by a prohibited-claim rule)
- [ ] SPF, DKIM and DMARC configured; monitored reply-to inbox (never no-reply)
- [ ] `EMAIL_PROVIDER=smtp` with real credentials
- [ ] Internal test allow-list populated and a test send verified
- [ ] Named approvers and senders created, each with MFA enrolled
- [ ] Opt-out and privacy wording reviewed for Uganda data-protection compliance
- [ ] Kill switch tested in **both** directions
- [ ] `GLOBAL_SEND_ENABLED=true` set by a named administrator as the final step

---

## 10. If you change one thing, run these

```bash
npx tsc --noEmit && npx eslint . && npm test && npx next build
```

And if you touched drafts, approvals or delivery:

```bash
ALLOW_DB_TESTS=1 AI_PROVIDER=stub npm run test:db
```

A green `npm test` alone does **not** tell you the approval guarantee still
holds. The integration suite is what proves that.
