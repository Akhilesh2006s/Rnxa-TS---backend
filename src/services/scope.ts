// Access scopes. Every route that reads or changes data goes through these
// helpers; hiding UI controls is never the security boundary.
//
// Logging time: a user can log on active projects they are a MEMBER of.
// Verifying time: each employee has one verifier (User.verifierId). A manager
// verifies the people who name them as verifier; admins can verify anyone.
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";

/** Active projects the user is assigned to as a member (i.e. can log time on). */
export async function loggableProjects(userId: string) {
  return prisma.project.findMany({
    where: { active: true, assignments: { some: { userId, role: "MEMBER" } } },
    include: { phases: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] } },
    orderBy: { name: "asc" },
  });
}

export async function canLogOn(userId: string, projectId: string): Promise<boolean> {
  const count = await prisma.projectAssignment.count({
    where: { userId, projectId, role: "MEMBER", project: { active: true } },
  });
  return count > 0;
}

/**
 * Ids of the people whose time this user verifies. `null` means everyone
 * (admins). Employees verify nobody.
 */
export async function teamMemberIds(user: SessionUser): Promise<string[] | null> {
  if (user.role === "ADMIN") return null;
  if (user.role !== "MANAGER") return [];
  const rows = await prisma.user.findMany({ where: { verifierId: user.id }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * The people this user is responsible for: a manager's verifiees; for admins,
 * everyone else who logs time (non-admins, plus admins on projects).
 */
export function teamUsersWhere(user: SessionUser): Prisma.UserWhereInput {
  if (user.role === "ADMIN") {
    return { active: true, id: { not: user.id }, OR: [{ role: { not: "ADMIN" } }, { assignments: { some: { role: "MEMBER" } } }] };
  }
  if (user.role === "MANAGER") return { active: true, verifierId: user.id };
  return { id: { in: [] } };
}

/** Prisma `where` fragment restricting entries to the people this user verifies. */
export async function reviewScopeWhere(user: SessionUser): Promise<Prisma.TimesheetEntryWhereInput> {
  const ids = await teamMemberIds(user);
  return ids === null ? {} : { userId: { in: ids } };
}

/** Verifiers act on their team's entries, never on their own time. */
export async function canReviewEntry(user: SessionUser, entry: { userId: string }) {
  if (entry.userId === user.id) return false;
  const ids = await teamMemberIds(user);
  return ids === null || ids.includes(entry.userId);
}
