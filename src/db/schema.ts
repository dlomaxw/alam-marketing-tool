/**
 * Data model for the ALAM Business Center lease outreach tool.
 * Mirrors section 9 of the approved development specification.
 *
 * Two invariants are structural here rather than left to application code:
 *  - `email_drafts` rows are immutable once created; an edit inserts a new
 *    version and points the old one at it via `superseded_by_id`.
 *  - `approvals` bind to (draft_id, version, content_hash). A changed hash can
 *    never match an existing approval, so editing silently voids it.
 */
import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, jsonb,
  uniqueIndex, index, primaryKey,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const userStatus = pgEnum("user_status", ["active", "suspended", "invited"]);

export const sourceStatus = pgEnum("source_status", [
  "uploaded", "extracting", "extracted", "failed",
]);

export const prospectStatus = pgEnum("prospect_status", [
  "imported", "needs_data_review", "qualified", "excluded",
]);

/** Section 8 status table. */
export const draftStatus = pgEnum("draft_status", [
  "draft", "needs_review", "rejected", "approved", "queued",
  "sent", "failed", "bounced", "replied",
]);

export const approvalDecision = pgEnum("approval_decision", [
  "approved", "rejected", "changes_requested", "revoked",
]);

export const sendJobStatus = pgEnum("send_job_status", [
  "queued", "processing", "sent", "failed", "cancelled",
]);

export const assetApproval = pgEnum("asset_approval", [
  "pending", "approved", "rejected",
]);

export const tenantSegment = pgEnum("tenant_segment", [
  "vehicle_motorcycle", "appliances_electronics", "supermarket_retail",
  "furniture_interior", "bank_financial", "corporate_hq",
  "wellness_leisure", "unclassified",
]);

export const propertyFloor = pgEnum("property_floor", [
  "ground", "first", "second", "unassigned",
]);

/* ------------------------------------------------------- users and access */

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  /** Flat permission slugs; see src/lib/auth/rbac.ts for the vocabulary. */
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  isSystem: boolean("is_system").notNull().default(false),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  roleId: uuid("role_id").notNull().references(() => roles.id),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaSecret: text("mfa_secret"),
  status: userStatus("status").notNull().default("active"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** Set once the TOTP challenge passes; unelevated sessions cannot mutate. */
  mfaSatisfied: boolean("mfa_satisfied").notNull().default(false),
  ip: text("ip"),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/* ------------------------------------------------------ source ingestion */

export const sourceDocuments = pgTable("source_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  filename: text("filename").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  checksum: text("checksum").notNull(),
  pageCount: integer("page_count"),
  uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
  status: sourceStatus("status").notNull().default("uploaded"),
  error: text("error"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Extracted page text, retained so evidence snippets stay auditable. */
export const sourcePages = pgTable("source_pages", {
  sourceDocumentId: uuid("source_document_id").notNull()
    .references(() => sourceDocuments.id, { onDelete: "cascade" }),
  page: integer("page").notNull(),
  text: text("text").notNull(),
}, (t) => [primaryKey({ columns: [t.sourceDocumentId, t.page] })]);

/* --------------------------------------------------------- property facts */

/**
 * Section 2. Administrator-editable but versioned; generation may only read
 * rows that are approved and not yet superseded.
 */
export const propertyFacts = pgTable("property_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  value: text("value").notNull(),
  version: integer("version").notNull().default(1),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  notes: text("notes"),
}, (t) => [index("property_facts_key_idx").on(t.key)]);

/** Claims generation must never make; output is checked against these. */
export const prohibitedClaims = pgTable("prohibited_claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  pattern: text("pattern").notNull(),
  reason: text("reason").notNull(),
  isRegex: boolean("is_regex").notNull().default(false),
});

/* -------------------------------------------------------------- prospects */

export const prospects = pgTable("prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyName: text("company_name").notNull(),
  sector: text("sector"),
  productsServices: text("products_services"),
  address: text("address"),
  website: text("website"),
  sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id),
  sourcePage: integer("source_page"),
  segment: tenantSegment("segment").notNull().default("unclassified"),
  suggestedFloor: propertyFloor("suggested_floor").notNull().default("unassigned"),
  score: integer("score").notNull().default(0),
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>(),
  rationale: text("rationale"),
  status: prospectStatus("status").notNull().default("imported"),
  ownerId: uuid("owner_id").references(() => users.id),
  exclusionReason: text("exclusion_reason"),
  /** Normalized company name used for duplicate detection. */
  dedupeKey: text("dedupe_key").notNull(),
  duplicateOfId: uuid("duplicate_of_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("prospects_dedupe_idx").on(t.dedupeKey),
  index("prospects_status_idx").on(t.status),
  index("prospects_segment_idx").on(t.segment),
]);

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  prospectId: uuid("prospect_id").notNull()
    .references(() => prospects.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  designation: text("designation"),
  email: text("email"),
  phone: text("phone"),
  preferredSalutation: text("preferred_salutation"),
  /** 0-100. Below the configured threshold the draft cannot leave review. */
  confidence: integer("confidence").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedBy: uuid("verified_by").references(() => users.id),
  sourcePage: integer("source_page"),
}, (t) => [index("contacts_prospect_idx").on(t.prospectId)]);

export const brandAssets = pgTable("brand_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerType: text("owner_type").notNull(), // 'alam' | 'prospect'
  ownerId: uuid("owner_id"),
  fileKey: text("file_key").notNull(),
  mimeType: text("mime_type").notNull(),
  checksum: text("checksum").notNull(),
  source: text("source").notNull(), // upload | brand_kit | directory
  sourceUrl: text("source_url"),
  approvalStatus: assetApproval("approval_status").notNull().default("pending"),
  approvedBy: uuid("approved_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------- campaigns */

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  objective: text("objective").notNull(),
  segment: tenantSegment("segment").notNull().default("unclassified"),
  targetFloor: propertyFloor("target_floor").notNull().default("unassigned"),
  ctaLabel: text("cta_label").notNull(),
  ctaUrl: text("cta_url").notNull(),
  tone: text("tone").notNull().default("respectful Ugandan business tone"),
  wordLimit: integer("word_limit").notNull().default(180),
  dailyLimit: integer("daily_limit").notNull().default(25),
  senderName: text("sender_name").notNull(),
  senderEmail: text("sender_email").notNull(),
  senderPhone: text("sender_phone"),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------------------------------------- draft chain */

export const emailDrafts = pgTable("email_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id),
  prospectId: uuid("prospect_id").notNull().references(() => prospects.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  version: integer("version").notNull().default(1),
  /** Chain root; version 1 references itself. Lets history query by one id. */
  threadId: uuid("thread_id").notNull(),
  subject: text("subject").notNull(),
  previewText: text("preview_text"),
  salutation: text("salutation"),
  bodyHtml: text("body_html").notNull(),
  bodyText: text("body_text").notNull(),
  ctaLabel: text("cta_label").notNull(),
  ctaUrl: text("cta_url").notNull(),
  recipientEmail: text("recipient_email"),
  recipientLogoAssetId: uuid("recipient_logo_asset_id").references(() => brandAssets.id),
  /** SHA-256 over the exact deliverable payload. Approval binds to this. */
  contentHash: text("content_hash").notNull(),
  status: draftStatus("status").notNull().default("draft"),
  needsManualReview: boolean("needs_manual_review").notNull().default(false),
  manualReviewReason: text("manual_review_reason"),
  riskFlags: jsonb("risk_flags").$type<string[]>().notNull().default([]),
  factsUsed: jsonb("facts_used").$type<string[]>().notNull().default([]),
  model: text("model"),
  promptVersion: text("prompt_version"),
  generationMeta: jsonb("generation_meta").$type<Record<string, unknown>>(),
  createdBy: uuid("created_by").references(() => users.id),
  supersededById: uuid("superseded_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("drafts_thread_version_idx").on(t.threadId, t.version),
  index("drafts_status_idx").on(t.status),
  index("drafts_prospect_idx").on(t.prospectId),
]);

export const draftEvidence = pgTable("draft_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull()
    .references(() => emailDrafts.id, { onDelete: "cascade" }),
  claim: text("claim").notNull(),
  sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id),
  page: integer("page"),
  snippet: text("snippet"),
  propertyFactId: uuid("property_fact_id").references(() => propertyFacts.id),
  confidence: integer("confidence").notNull().default(0),
}, (t) => [index("evidence_draft_idx").on(t.draftId)]);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull().references(() => emailDrafts.id),
  draftVersion: integer("draft_version").notNull(),
  /** Must equal the draft hash at send time or delivery is refused. */
  contentHash: text("content_hash").notNull(),
  approverId: uuid("approver_id").notNull().references(() => users.id),
  decision: approvalDecision("decision").notNull(),
  reason: text("reason"),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("approvals_draft_idx").on(t.draftId)]);

export const sendJobs = pgTable("send_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull().references(() => emailDrafts.id),
  approvalId: uuid("approval_id").references(() => approvals.id),
  contentHash: text("content_hash").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  isTest: boolean("is_test").notNull().default(false),
  /** Unique: a duplicated click or retried worker cannot double-send. */
  idempotencyKey: text("idempotency_key").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
  status: sendJobStatus("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  providerMessageId: text("provider_message_id"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("send_jobs_idempotency_idx").on(t.idempotencyKey),
  index("send_jobs_status_idx").on(t.status),
]);

/* ------------------------------------------------- engagement and control */

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  prospectId: uuid("prospect_id").references(() => prospects.id, { onDelete: "cascade" }),
  draftId: uuid("draft_id").references(() => emailDrafts.id),
  sendJobId: uuid("send_job_id").references(() => sendJobs.id),
  type: text("type").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("events_prospect_idx").on(t.prospectId)]);

export const suppressions = pgTable("suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Exactly one of email/domain is set; both are stored lowercased. */
  email: text("email"),
  domain: text("domain"),
  reason: text("reason").notNull(),
  source: text("source").notNull(), // bounce | complaint | opt_out | manual
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("suppressions_email_idx").on(t.email),
  uniqueIndex("suppressions_domain_idx").on(t.domain),
]);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => users.id),
  /** 'system:worker' when the action is unattended. */
  actorLabel: text("actor_label").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  beforeHash: text("before_hash"),
  afterHash: text("after_hash"),
  reason: text("reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ip: text("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("audit_entity_idx").on(t.entity, t.entityId),
  index("audit_created_idx").on(t.createdAt),
]);

/** Runtime-editable configuration, including the global send kill switch. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
