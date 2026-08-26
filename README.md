# ALAM Business Center — Personalized Lease Email Approval Tool

Turns the 2026 UMA Business Directory into a controlled leasing outreach
pipeline for ALAM Business Center: import prospects, classify them by tenancy
fit, generate evidence-grounded lease emails, and **send only what a named
person has explicitly approved**.

> **Core principle: no email leaves the system without a recorded human
> approval.** The default state is SEND DISABLED. Drafting is automated;
> sending is not.

Built to the approved development specification
(`ALAM_Lease_Email_Approval_Tool_Claude_Handover.docx`) and the approved email
structure (`ALAM_Personalized_Lease_Email_Proposal draft.pdf`).

---

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run db:migrate
npm run db:seed
npm run dev
```

Seeding an administrator requires two extra variables on the seed command:

```bash
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a-long-password' npm run db:seed
```

Then sign in, enrol an authenticator when prompted, and approve the property
facts under **Settings** — generation is blocked until they are approved.

---

## How the approval guarantee works

Four independent mechanisms, each of which alone would stop an unapproved send.

**1. Immutable versions.** `email_drafts` rows are never updated in place. An
edit inserts a new version and marks the old one superseded. What somebody
approved cannot change afterwards.

**2. Approval binds to a content hash.** `computeContentHash()` takes a
length-prefixed SHA-256 over exactly the fields that reach the recipient
(subject, preview, salutation, HTML, text, CTA, recipient, logo). An approval
records that hash. Change any of those fields and the hash no longer matches,
so the approval silently stops applying — this is why "editing an approved
draft cancels the approval" is a property of the data model rather than a rule
someone has to remember.

**3. The send guard runs twice.** `authorizeSend()` in
`src/lib/email/send-guard.ts` is the only path to delivery. It checks draft
status, a live approval for this exact version *and* hash, later revocations,
whether the approver still holds the permission, recipient validity,
suppression, the daily cap, the requester's permission, and that the approver
is not the author. It runs when a user queues a message **and again inside the
worker immediately before the provider call** — so revoking an approval or
hitting the kill switch takes effect on already-queued work.

**4. A two-part kill switch.** Delivery requires `GLOBAL_SEND_ENABLED=true` in
the deployment environment **and** the administrator switch in the database.
Neither a config change nor a database compromise can enable sending alone,
and turning the switch off also cancels everything queued.

Separately: `draft:approve` and `email:send` are distinct permissions, both
require an MFA-verified session, and bulk approval does not exist in this
version.

---

## Architecture

```
src/
  db/            Drizzle schema (spec §9), client, seed
  lib/
    auth/        password, TOTP MFA, sessions, RBAC, page guards
    ingestion/   PDF extraction, UMA parser, import + evidence
    ai/          prompt contract, provider adapter, output schema, validator
    email/       branded template, provider adapter, send guard
    content-hash.ts   approval binding
    draft-state.ts    status machine (spec §8)
    scoring.ts        segmentation + explainable 0-100 score (spec §5.3-5.4)
    naming.ts         subject and salutation construction
  worker/        send worker — re-authorizes, then delivers
  app/           Next.js App Router pages and server actions
```

### Ingestion

The UMA directory is a 272-page two-column layout. Two problems had to be
solved before any of it was usable:

- **Column separation.** Naive extraction interleaves the columns, splicing one
  company's contact details into another's description. There is no empty
  gutter to find (the entry separator rules span the full page width), so
  columns are detected by clustering item left edges instead.
- **Ligature corruption.** The embedded fonts map `ti`, `fi`, `tt`, `tf`, `ffi`
  and `ff` to Latin Extended-B codepoints, yielding `automaƟon`, `Įelds`,
  `plaƞorm`. Left unrepaired this also corrupts email addresses —
  `info@youthplaƞormafrica.com` would hard-bounce.

Current yield from the real file: **1,735 records, 1,637 with an email
address**, median field confidence 91. Every record keeps its source page and
raw block so each claim can be opened against the original entry.

### Generation

The model receives a compact structured object — never the raw directory — plus
only management-approved property facts. Output must parse against a strict
schema, and then `validateGeneration()` independently verifies what the prompt
asked for: no unsupported superlatives, no implied partnership or tenancy, no
ownership claims, no fabricated evidence ids or property facts, no unsafe HTML,
and a non-generic salutation when a contact name is known. Blocking issues force
`needs_manual_review`; nothing is auto-corrected, because the decision belongs
to a person.

`AI_PROVIDER=stub` runs the whole workflow offline with a deterministic
generator that always flags manual review, so a stub draft can never be mistaken
for a grounded one.

---

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Acceptance tests (spec §16) |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Roles, property facts, prohibited claims, settings |
| `npm run import:directory` | Load the whole UMA directory into the database |
| `npm run export:directory` | Write the categorized dataset to `exports/` |
| `npm run worker` | Process the send queue once |
| `npm run worker -- --loop` | Poll the queue continuously |

`export:directory` writes three files, all gitignored because they carry
around 1,600 business contact addresses:

- `exports/uma-prospects.json` — every entry, grouped by tenant category
- `exports/uma-prospects.csv` — flat sheet for spreadsheets or CRM import
- `exports/uma-agent-context.json` — compact per-company payload for an agent,
  carrying only the fields generation is permitted to use plus the page
  reference behind them

Development probes (not part of the app) live in `scripts/`:
`probe-parse.mts` reports extraction quality over the whole directory,
`probe-spec-examples.mts` checks the ten companies named in spec §12, and
`demo-pipeline.mts` runs import → approve → generate end to end.

---

## Configuration

See `.env.example`. Notable entries:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres. Neon in this deployment. |
| `SESSION_SECRET` | 32+ chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `R2_*` | Cloudflare R2 for source PDFs and brand assets. Bucket stays private. |
| `AI_PROVIDER` | `gemini` \| `stub` (stub generates offline, for tests) |
| `EMAIL_PROVIDER` | `console` (logs only) \| `smtp` |
| `GLOBAL_SEND_ENABLED` | Half of the kill switch. Keep `false` until launch approval. |
| `TEST_SEND_ALLOWLIST` | The only addresses a TEST send may ever reach. |
| `DAILY_SEND_LIMIT` | Hard ceiling the UI cannot raise. |

---

## Before production sending

Delivery stays off until all of the following are done. This mirrors the
specification's §18 and §20 checklists.

- [ ] Management verifies and approves all 12 property facts in **Settings**
- [ ] Approved sender name, email, phone and website confirmed
- [ ] SPF, DKIM and DMARC configured for the sending domain
- [ ] `EMAIL_PROVIDER=smtp` with real credentials, and a monitored reply-to inbox
- [ ] Internal test allow-list populated, and a test send verified
- [ ] Named approvers and senders created, each with MFA enrolled
- [ ] Opt-out and privacy wording reviewed by management/legal for Uganda
      data-protection and electronic-communications compliance
- [ ] Kill switch tested in both directions
- [ ] `GLOBAL_SEND_ENABLED=true` set by a named administrator as the final step

## Known limitations

- **Recipient logos** are modelled and gated on approval, but there is no
  upload UI yet; drafts fall back to the company name in text, which is the
  specified behaviour when no approved logo exists.
- **Reply and bounce webhooks** have handlers in the data model and worker but
  no provider endpoint wired, so replies are recorded manually for now.
- **Company short names** are derived heuristically for subject lines
  (`AUTOXPRESS UGANDA LIMITED` → `Autoxpress`). Camel-cased brands such as
  `AutoXpress` are not recovered; a reviewer can correct the subject, which
  creates a new version as any other edit does.
- **Scheduling** creates jobs that run immediately; a future-dated send window
  is stored but not yet exposed in the UI.
