// Organisation administration: users, projects, phases, assignments, policy, audit log.
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { ASSIGNMENT_ROLES, ROLES, objectId } from "../domain.js";
import { ISO_DATE } from "../services/dates.js";
import { badRequest, conflict, forbidden, idParam, notFound } from "../errors.js";
import { can, requirePermission } from "../services/permissions.js";
import { addPhase, assignUser, createProject, createUser, publicUser, updateUser } from "../services/admin.js";
import { diffFields, recordAudit } from "../services/audit.js";

// Each route needs a specific permission; the super admin decides who has which.
export const adminRouter = Router();
const users = requirePermission("MANAGE_USERS");
const projects = requirePermission("MANAGE_PROJECTS");
const projectsOrPhases = requirePermission("MANAGE_PROJECTS", "CLOSE_PHASES");

// ---- Users -----------------------------------------------------------------

adminRouter.get("/users", requirePermission("MANAGE_USERS", "MANAGE_PROJECTS"), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      ...publicUser,
      assignments: { where: { role: "MEMBER" }, select: { id: true, role: true, project: { select: { id: true, code: true, name: true } } } },
    },
    orderBy: { name: "asc" },
  });
  res.json({ users });
});

const passwordSchema = z.string().min(10, "Password must be at least 10 characters.").max(200);

adminRouter.post("/users", users, async (req, res) => {
  const actor = currentUser(req);
  const input = z
    .object({
      email: z.string().trim().toLowerCase().email().max(200),
      name: z.string().trim().min(1).max(120),
      role: z.enum(ROLES),
      password: passwordSchema,
      verifierId: objectId.nullable().optional(),
    })
    .parse(req.body);
  const user = await createUser(actor, input);
  res.status(201).json({ user });
});

adminRouter.patch("/users/:id", users, async (req, res) => {
  const actor = currentUser(req);
  const input = z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      role: z.enum(ROLES).optional(),
      active: z.boolean().optional(),
      password: passwordSchema.optional(),
      verifierId: objectId.nullable().optional(),
    })
    .parse(req.body);
  const user = await updateUser(actor, idParam(req.params.id), input);
  res.json({ user });
});

// ---- Projects & phases -----------------------------------------------------

adminRouter.get("/projects", projectsOrPhases, async (_req, res) => {
  const projects = await prisma.project.findMany({
    include: {
      phases: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
      assignments: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
    },
    orderBy: { name: "asc" },
  });
  res.json({ projects });
});

const day = z.string().regex(ISO_DATE, "Use YYYY-MM-DD.").nullable().optional();
const PHASE_STATUSES = ["PLANNED", "IN_PROGRESS", "DONE"] as const;
const projectSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(20).regex(/^[A-Z0-9-]+$/, "Use letters, numbers and dashes."),
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  startDate: day,
  endDate: day,
  phasesEnabled: z.boolean().default(true),
  active: z.boolean().default(true),
});

adminRouter.post("/projects", projects, async (req, res) => {
  const actor = currentUser(req);
  const input = projectSchema.parse(req.body);
  const project = await createProject(actor, input);
  res.status(201).json({ project });
});

adminRouter.patch("/projects/:id", projects, async (req, res) => {
  const actor = currentUser(req);
  const input = projectSchema.partial().omit({ code: true }).parse(req.body);
  const existing = await prisma.project.findUnique({ where: { id: idParam(req.params.id) } });
  if (!existing) throw notFound("Project not found.");
  const project = await prisma.project.update({ where: { id: existing.id }, data: input });
  await recordAudit({ actorId: actor.id, action: "PROJECT_UPDATE", entityType: "Project", entityId: project.id, changes: diffFields(existing, input) });
  res.json({ project });
});

adminRouter.post("/projects/:id/phases", projects, async (req, res) => {
  const actor = currentUser(req);
  const input = z
    .object({
      name: z.string().trim().min(1).max(80),
      sortOrder: z.number().int().min(0).max(999).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      startDate: day,
      endDate: day,
      status: z.enum(PHASE_STATUSES).optional(),
    })
    .parse(req.body);
  if (input.status === "DONE" && !can(actor, "CLOSE_PHASES")) throw forbidden("Only the super admin, or someone they allow, can mark a phase as done.");
  const { name, sortOrder, ...details } = input;
  const phase = await addPhase(actor, idParam(req.params.id), name, sortOrder, details);
  res.status(201).json({ phase });
});

adminRouter.patch("/phases/:id", projectsOrPhases, async (req, res) => {
  const actor = currentUser(req);
  const input = z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(999).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      startDate: day,
      endDate: day,
      status: z.enum(PHASE_STATUSES).optional(),
    })
    .parse(req.body);
  const existing = await prisma.phase.findUnique({ where: { id: idParam(req.params.id) } });
  if (!existing) throw notFound("Phase not found.");
  // Closing or reopening a phase (logging on/off, or moving into or out of "Done").
  const closing =
    (input.active !== undefined && input.active !== existing.active) ||
    (input.status !== undefined && input.status !== existing.status && (input.status === "DONE" || existing.status === "DONE"));
  const editing = input.name !== undefined || input.description !== undefined || input.startDate !== undefined || input.endDate !== undefined || input.sortOrder !== undefined || (input.status !== undefined && !closing);
  if (closing && !can(actor, "CLOSE_PHASES")) throw forbidden("Only the super admin, or someone they allow, can close or reopen phases.");
  if (editing && !can(actor, "MANAGE_PROJECTS")) throw forbidden("You can close phases but not edit their details.");
  const phase = await prisma.phase.update({ where: { id: existing.id }, data: input });
  await recordAudit({ actorId: actor.id, action: "PHASE_UPDATE", entityType: "Phase", entityId: phase.id, changes: diffFields(existing, input) });
  res.json({ phase });
});

// ---- Assignments -----------------------------------------------------------

adminRouter.post("/assignments", projects, async (req, res) => {
  const actor = currentUser(req);
  const input = z.object({ userId: objectId, projectId: objectId, role: z.enum(ASSIGNMENT_ROLES) }).parse(req.body);
  const assignment = await assignUser(actor, input);
  res.status(201).json({ assignment });
});

adminRouter.delete("/assignments/:id", projects, async (req, res) => {
  const actor = currentUser(req);
  const existing = await prisma.projectAssignment.findUnique({ where: { id: idParam(req.params.id) } });
  if (!existing) throw notFound("Assignment not found.");
  await prisma.projectAssignment.delete({ where: { id: existing.id } });
  await recordAudit({
    actorId: actor.id,
    action: "ASSIGNMENT_DELETE",
    entityType: "ProjectAssignment",
    entityId: existing.id,
    changes: { userId: existing.userId, projectId: existing.projectId, role: existing.role },
  });
  res.json({ ok: true });
});

// ---- Policy ----------------------------------------------------------------

adminRouter.get("/policy", requirePermission("MANAGE_POLICY"), async (_req, res) => {
  const policy = await prisma.orgPolicy.upsert({ where: { id: "org" }, update: {}, create: { id: "org" } });
  res.json({ policy });
});

adminRouter.patch("/policy", requirePermission("MANAGE_POLICY"), async (req, res) => {
  const actor = currentUser(req);
  const input = z
    .object({
      expectedDailyMinutes: z.number().int().min(0).max(1440).optional(),
      workDays: z.string().regex(/^[1-7](,[1-7])*$/).optional(),
      maxPastDays: z.number().int().min(0).max(366).optional(),
      maxFutureDays: z.number().int().min(0).max(31).optional(),
      longEntryMinutes: z.number().int().min(60).max(1440).optional(),
      autoReminders: z.boolean().optional(),
      reminderHour: z.number().int().min(0).max(23).optional(),
      autoVerify: z.boolean().optional(),
      autoVerifyMaxDailyMinutes: z.number().int().min(60).max(1440).optional(),
      casualLeaveDays: z.number().int().min(0).max(366).optional(),
      sickLeaveDays: z.number().int().min(0).max(366).optional(),
      earnedLeaveDays: z.number().int().min(0).max(366).optional(),
    })
    .parse(req.body);
  const existing = await prisma.orgPolicy.upsert({ where: { id: "org" }, update: {}, create: { id: "org" } });
  const policy = await prisma.orgPolicy.update({ where: { id: "org" }, data: input });
  await recordAudit({ actorId: actor.id, action: "POLICY_UPDATE", entityType: "OrgPolicy", entityId: "org", changes: diffFields(existing, input) });
  res.json({ policy });
});

// ---- Audit log ---------------------------------------------------------------

adminRouter.get("/audit", requirePermission("VIEW_AUDIT"), async (req, res) => {
  const q = z
    .object({ entityType: z.string().max(40).optional(), entityId: z.string().max(64).optional(), take: z.coerce.number().int().min(1).max(500).default(200) })
    .parse(req.query);
  const events = await prisma.auditEvent.findMany({
    where: { entityType: q.entityType, entityId: q.entityId },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: q.take,
  });
  res.json({ events: events.map((e) => ({ ...e, changes: e.changes ? JSON.parse(e.changes) : null })) });
});
