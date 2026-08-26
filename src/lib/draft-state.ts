/**
 * Draft state machine, section 8 of the specification.
 *
 * Pure and dependency-free so the approval rules can be unit tested without a
 * database. The transition table is the single source of truth: API routes ask
 * this module, they do not re-implement the rules.
 */
import type { Permission } from "./auth/rbac";

export type DraftStatus =
  | "draft" | "needs_review" | "rejected" | "approved"
  | "queued" | "sent" | "failed" | "bounced" | "replied";

export type DraftAction =
  | "edit" | "submit" | "approve" | "reject" | "request_changes"
  | "revoke_approval" | "queue" | "cancel" | "mark_sent"
  | "mark_failed" | "mark_bounced" | "mark_replied";

interface Transition {
  to: DraftStatus;
  permission: Permission;
  /** True when the action must be performed by the system, not a person. */
  systemOnly?: boolean;
  note: string;
}

const TABLE: Record<DraftStatus, Partial<Record<DraftAction, Transition>>> = {
  draft: {
    edit: { to: "draft", permission: "draft:write", note: "Creates a new version." },
    submit: { to: "needs_review", permission: "draft:submit", note: "Ready for an authorized reviewer." },
  },

  needs_review: {
    edit: { to: "draft", permission: "draft:write", note: "Editing withdraws it from the queue as a new version." },
    approve: { to: "approved", permission: "draft:approve", note: "Binds approval to this exact content hash." },
    reject: { to: "rejected", permission: "draft:reject", note: "Reviewer declined this version." },
    request_changes: { to: "draft", permission: "draft:reject", note: "Returned to the author." },
  },

  rejected: {
    edit: { to: "draft", permission: "draft:write", note: "Edit into a new version or archive." },
  },

  approved: {
    // Editing an approved draft is the case the spec calls out explicitly:
    // it does not mutate the approved row, it supersedes it with an
    // unapproved version, so the standing approval no longer applies.
    edit: { to: "draft", permission: "draft:write", note: "Voids the approval; the new version needs review." },
    revoke_approval: { to: "needs_review", permission: "draft:approve", note: "Approver withdrew the decision." },
    queue: { to: "queued", permission: "email:send", note: "Creates one idempotent send job." },
  },

  queued: {
    cancel: { to: "approved", permission: "email:cancel", note: "Cancel before the worker picks it up." },
    mark_sent: { to: "sent", permission: "email:send", systemOnly: true, note: "Provider accepted the message." },
    mark_failed: { to: "failed", permission: "email:send", systemOnly: true, note: "Delivery problem; never auto-resend." },
  },

  sent: {
    mark_bounced: { to: "bounced", permission: "email:send", systemOnly: true, note: "Provider reported a bounce." },
    mark_replied: { to: "replied", permission: "email:send", systemOnly: true, note: "Inbound reply detected." },
  },

  // Terminal for automation. Section 13: never auto-resend after a failure or
  // bounce; a human must correct the record and start a new draft version.
  failed: {},
  bounced: {},
  replied: {},
};

export interface TransitionCheck {
  allowed: boolean;
  to?: DraftStatus;
  permission?: Permission;
  reason?: string;
}

export function canTransition(
  from: DraftStatus,
  action: DraftAction,
  actor: { permissions: string[]; isSystem?: boolean },
): TransitionCheck {
  const t = TABLE[from]?.[action];
  if (!t) {
    return { allowed: false, reason: `"${action}" is not permitted from status "${from}".` };
  }
  if (t.systemOnly && !actor.isSystem) {
    return { allowed: false, reason: `"${action}" is recorded by the system, not by a user.` };
  }
  if (!t.systemOnly && !actor.permissions.includes(t.permission)) {
    return { allowed: false, permission: t.permission, reason: `Missing permission "${t.permission}".` };
  }
  return { allowed: true, to: t.to, permission: t.permission };
}

export function availableActions(
  from: DraftStatus,
  actor: { permissions: string[] },
): DraftAction[] {
  return (Object.keys(TABLE[from] ?? {}) as DraftAction[])
    .filter((a) => canTransition(from, a, actor).allowed);
}

/** A draft in any of these states must never be handed to a send provider. */
export const NON_SENDABLE: ReadonlySet<DraftStatus> = new Set<DraftStatus>([
  "draft", "needs_review", "rejected", "sent", "failed", "bounced", "replied",
]);

export const STATUS_LABELS: Record<DraftStatus, string> = {
  draft: "Draft",
  needs_review: "Needs Review",
  rejected: "Rejected",
  approved: "Approved",
  queued: "Queued",
  sent: "Sent",
  failed: "Failed",
  bounced: "Bounced",
  replied: "Replied",
};
