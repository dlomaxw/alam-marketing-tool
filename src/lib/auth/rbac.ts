/**
 * Role and permission vocabulary, section 3 of the specification.
 *
 * `draft:approve` and `email:send` are deliberately separate. A role may hold
 * one without the other, and the send path checks both independently.
 */

export const PERMISSIONS = [
  "user:manage",
  "role:manage",
  "settings:manage",
  "property_facts:manage",
  "template:manage",
  "integration:manage",

  "source:upload",
  "source:extract",

  "prospect:read",
  "prospect:write",
  "prospect:assign",
  "prospect:export",

  "campaign:read",
  "campaign:write",

  "draft:read",
  "draft:write",
  "draft:submit",
  "draft:approve",
  "draft:reject",

  "email:send",
  "email:test_send",
  "email:schedule",
  "email:cancel",

  "suppression:manage",
  "audit:read",
  "dashboard:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_NAMES = [
  "Administrator",
  "Campaign Manager",
  "Reviewer",
  "Sales Agent",
  "Viewer",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * Default grants. Note what is absent as much as what is present:
 *  - Campaign Manager can generate and submit but cannot approve by default.
 *    Section 3 says "can approve if granted", so it is granted per user.
 *  - Reviewer can approve but has no `email:send`; sending is granted separately.
 *  - Sales Agent can draft and never approve or send.
 */
export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  Administrator: [...PERMISSIONS],

  "Campaign Manager": [
    "source:upload", "source:extract",
    "prospect:read", "prospect:write", "prospect:assign",
    "campaign:read", "campaign:write",
    "draft:read", "draft:write", "draft:submit",
    "email:test_send",
    "suppression:manage",
    "dashboard:read",
  ],

  Reviewer: [
    "prospect:read",
    "campaign:read",
    "draft:read", "draft:approve", "draft:reject",
    "dashboard:read",
    "audit:read",
  ],

  "Sales Agent": [
    "prospect:read", "prospect:write",
    "campaign:read",
    "draft:read", "draft:write", "draft:submit",
    "dashboard:read",
  ],

  Viewer: [
    "prospect:read",
    "campaign:read",
    "draft:read",
    "dashboard:read",
  ],
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  Administrator: "Manages users, property facts, templates, integrations and policies. Can approve and send.",
  "Campaign Manager": "Imports prospects, segments, generates, edits and schedules campaigns. Approval granted per user.",
  Reviewer: "Reviews evidence, previews emails, approves or rejects versions. Sending granted separately.",
  "Sales Agent": "Adds notes, creates drafts, tracks calls and visits. Cannot approve or send.",
  Viewer: "Reads dashboards and records. Cannot edit or send.",
};

/** Permissions that require a session with the MFA challenge satisfied. */
export const MFA_REQUIRED_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "user:manage", "role:manage", "settings:manage", "property_facts:manage",
  "draft:approve", "email:send", "email:schedule",
]);

export function hasPermission(granted: string[], needed: Permission): boolean {
  return granted.includes(needed);
}

export function hasAll(granted: string[], needed: Permission[]): boolean {
  return needed.every((p) => granted.includes(p));
}
