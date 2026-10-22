// Shared vocabulary for roles, statuses and the entry workflow.
import { z } from "zod";

export const ROLES = ["ADMIN", "MANAGER", "EMPLOYEE"] as const;
export type Role = (typeof ROLES)[number];

export const ASSIGNMENT_ROLES = ["MEMBER", "REVIEWER"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const STATUSES = ["DRAFT", "SUBMITTED", "CHANGES_REQUESTED", "APPROVED", "REJECTED"] as const;
export type EntryStatus = (typeof STATUSES)[number];

// Owners may edit or delete entries only in these states.
export const EDITABLE_STATUSES: readonly EntryStatus[] = ["DRAFT", "CHANGES_REQUESTED"];

/**
 * Allowed workflow transitions.
 * - REJECTED is terminal: the entry should not have been logged (wrong project,
 *   duplicate, not billable). The employee logs a new entry if needed.
 * - CHANGES_REQUESTED returns the entry to the employee for correction.
 * - REOPEN moves an APPROVED entry back to CHANGES_REQUESTED; it needs a reason
 *   and is audited. This is the only way to correct approved time.
 */
export const TRANSITIONS = {
  SUBMIT: { from: ["DRAFT", "CHANGES_REQUESTED"], to: "SUBMITTED" },
  RECALL: { from: ["SUBMITTED"], to: "DRAFT" },
  APPROVE: { from: ["SUBMITTED"], to: "APPROVED" },
  REQUEST_CHANGES: { from: ["SUBMITTED"], to: "CHANGES_REQUESTED" },
  REJECT: { from: ["SUBMITTED"], to: "REJECTED" },
  REOPEN: { from: ["APPROVED"], to: "CHANGES_REQUESTED" },
} as const satisfies Record<string, { from: readonly EntryStatus[]; to: EntryStatus }>;

export type WorkflowAction = keyof typeof TRANSITIONS;


/** A MongoDB ObjectId in hex form, for request bodies and query strings. */
export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id.");

/**
 * What a person may administer. The super admin always has every permission
 * and decides which roles (or individual people) get the rest.
 */
export const PERMISSIONS = {
  MANAGE_USERS: "Add and edit users, their roles and verifiers",
  MANAGE_PROJECTS: "Create projects and phases, edit their details, add people to projects",
  CLOSE_PHASES: "Close phases: mark them done or stop time being logged on them",
  MANAGE_POLICY: "Change working hours, reminders and auto-verify rules",
  VIEW_AUDIT: "See the audit log",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

/** Used until the super admin changes a role's permissions. Closing phases is super-admin only by default. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: ["MANAGE_USERS", "MANAGE_PROJECTS", "MANAGE_POLICY", "VIEW_AUDIT"],
  MANAGER: [],
  EMPLOYEE: [],
};
