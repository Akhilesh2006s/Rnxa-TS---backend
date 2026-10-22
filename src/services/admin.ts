// Administrative operations shared by the admin API and the AI assistant.
// Callers must already have checked that the actor is an ADMIN.
import type { SessionUser } from "../auth.js";
import { hashPassword } from "../auth.js";
import { prisma } from "../db.js";
import type { AssignmentRole, Role } from "../domain.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { diffFields, recordAudit } from "./audit.js";

export const publicUser = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  createdAt: true,
  verifierId: true,
  verifier: { select: { id: true, name: true } },
  permissions: true,
} as const;

/** A verifier must be an active manager or admin, and not the person themselves. */
async function checkVerifier(userId: string | null, verifierId: string | null | undefined) {
  if (!verifierId) return;
  if (verifierId === userId) throw badRequest("People can't verify their own time.");
  const v = await prisma.user.findUnique({ where: { id: verifierId } });
  if (!v || !v.active) throw badRequest("That verifier was not found or is inactive.");
  if (v.role === "EMPLOYEE") throw badRequest(`${v.name} is an employee. Make them a manager first, or pick a manager or admin.`);
}

export async function createUser(
  actor: SessionUser,
  input: { email: string; name: string; role: Role; password: string; verifierId?: string | null },
) {
  if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict("A user with that email already exists.");
  await checkVerifier(null, input.verifierId);
  const user = await prisma.user.create({
    data: { email: input.email, name: input.name, role: input.role, passwordHash: await hashPassword(input.password), verifierId: input.verifierId ?? null },
    select: publicUser,
  });
  await recordAudit({
    actorId: actor.id,
    action: "USER_CREATE",
    entityType: "User",
    entityId: user.id,
    changes: { email: user.email, role: user.role, verifierId: user.verifierId },
  });
  return user;
}

export async function updateUser(
  actor: SessionUser,
  id: string,
  input: { name?: string; role?: Role; active?: boolean; password?: string; verifierId?: string | null },
) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw notFound("User not found.");
  if (existing.id === actor.id && (input.active === false || (input.role && input.role !== "ADMIN"))) {
    throw badRequest("You cannot deactivate or demote your own account.");
  }
  await checkVerifier(existing.id, input.verifierId);
  // Someone who verifies others can't be made an employee until their team has a new verifier.
  if (input.role === "EMPLOYEE" && existing.role !== "EMPLOYEE" && (await prisma.user.count({ where: { verifierId: existing.id } }))) {
    throw badRequest(`${existing.name} verifies other people's time. Give them a new verifier first.`);
  }
  const user = await prisma.user.update({
    where: { id: existing.id },
    data: {
      name: input.name,
      role: input.role,
      active: input.active,
      verifierId: input.verifierId,
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    },
    select: publicUser,
  });
  const changes: Record<string, unknown> = diffFields(existing, { name: input.name, role: input.role, active: input.active, verifierId: input.verifierId });
  if (input.password) changes.password = "reset";
  await recordAudit({ actorId: actor.id, action: "USER_UPDATE", entityType: "User", entityId: user.id, changes });
  return user;
}

export async function createProject(
  actor: SessionUser,
  input: {
    code: string;
    name: string;
    client?: string | null;
    description?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    phasesEnabled: boolean;
    active?: boolean;
    phases?: string[];
  },
) {
  if (await prisma.project.findUnique({ where: { code: input.code } })) throw conflict("A project with that code already exists.");
  const { phases = [], ...data } = input;
  const project = await prisma.project.create({ data: { ...data, active: data.active ?? true } });
  await recordAudit({ actorId: actor.id, action: "PROJECT_CREATE", entityType: "Project", entityId: project.id, changes: data });
  for (const name of phases) await addPhase(actor, project.id, name);
  return project;
}

export interface PhaseDetails {
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: "PLANNED" | "IN_PROGRESS" | "DONE";
}

export async function addPhase(actor: SessionUser, projectId: string, name: string, sortOrder?: number, details: PhaseDetails = {}) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { phases: true } });
  if (!project) throw notFound("Project not found.");
  if (project.phases.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw conflict(`Phase "${name}" already exists.`);
  const phase = await prisma.phase.create({ data: { projectId: project.id, name, sortOrder: sortOrder ?? project.phases.length, ...details } });
  await recordAudit({ actorId: actor.id, action: "PHASE_CREATE", entityType: "Phase", entityId: phase.id, changes: { projectId: project.id, name: phase.name } });
  return phase;
}

export async function assignUser(actor: SessionUser, input: { userId: string; projectId: string; role: AssignmentRole }) {
  const [user, project] = await Promise.all([
    prisma.user.findUnique({ where: { id: input.userId } }),
    prisma.project.findUnique({ where: { id: input.projectId } }),
  ]);
  if (!user || !project) throw notFound("User or project not found.");
  if (input.role === "REVIEWER" && user.role === "EMPLOYEE") {
    throw badRequest("Only managers or admins can be reviewers. Change the user's role first.");
  }
  if (await prisma.projectAssignment.findUnique({ where: { userId_projectId_role: input } })) throw conflict("That assignment already exists.");
  const assignment = await prisma.projectAssignment.create({ data: input });
  await recordAudit({ actorId: actor.id, action: "ASSIGNMENT_CREATE", entityType: "ProjectAssignment", entityId: assignment.id, changes: input });
  return assignment;
}
