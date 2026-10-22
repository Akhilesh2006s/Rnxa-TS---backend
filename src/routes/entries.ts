// Employee-owned time entries and weekly submission.
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { objectId } from "../domain.js";
import { badRequest, forbidden, idParam } from "../errors.js";
import { recordAudit, diffFields } from "../services/audit.js";
import { ISO_DATE, addDays, isValidDate, isoWeekday, today, weekDates, weekStart } from "../services/dates.js";
import { deleteAttachmentsFor } from "../services/attachments.js";
import { notifyUsers } from "../services/notifications.js";
import { getPolicy } from "../services/policy.js";
import { weekSummary } from "../services/summaries.js";
import { canReviewEntry, loggableProjects } from "../services/scope.js";
import {
  TIME,
  slotMinutes,
  assertEditable,
  entryInclude,
  flagEntries,
  loadOwnEntry,
  recallEntry,
  submitRange,
  validateEntry,
} from "../services/timesheet.js";

export const entriesRouter = Router();

const time = z.string().regex(TIME, "Use HH:MM.");
const entrySchema = z.object({
  workDate: z.string().regex(ISO_DATE),
  projectId: objectId,
  phaseId: objectId.nullable().optional(),
  // Either a duration, or a start and end time (duration is then calculated).
  minutes: z.number().int().min(1).max(24 * 60).optional(),
  startTime: time.nullable().optional(),
  endTime: time.nullable().optional(),
  description: z.string().max(4000).default(""),
});

const rangeSchema = z.object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) });

entriesRouter.get("/projects", async (req, res) => {
  const user = currentUser(req);
  const start = weekStart(today());
  const [projects, allTime, thisWeek] = await Promise.all([
    loggableProjects(user.id),
    prisma.timesheetEntry.groupBy({ by: ["projectId"], where: { userId: user.id, status: { not: "REJECTED" } }, _sum: { minutes: true } }),
    prisma.timesheetEntry.groupBy({
      by: ["projectId"],
      where: { userId: user.id, status: { not: "REJECTED" }, workDate: { gte: start, lte: addDays(start, 6) } },
      _sum: { minutes: true },
    }),
  ]);
  const sumFor = (rows: { projectId: string; _sum: { minutes: number | null } }[], id: string) => rows.find((r) => r.projectId === id)?._sum.minutes ?? 0;
  res.json({
    projects: projects.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      client: p.client,
      phasesEnabled: p.phasesEnabled,
      phases: p.phases.map((ph) => ({ id: ph.id, name: ph.name })),
      myMinutesThisWeek: sumFor(thisWeek, p.id),
      myMinutesTotal: sumFor(allTime, p.id),
    })),
  });
});

/** Most recent distinct project/phase pairs, for "reuse last project and phase". */
entriesRouter.get("/entries/recent", async (req, res) => {
  const user = currentUser(req);
  const rows = await prisma.timesheetEntry.findMany({
    where: { userId: user.id },
    orderBy: [{ workDate: "desc" }, { createdAt: "desc" }],
    take: 50,
    include: entryInclude,
  });
  const seen = new Set<string>();
  const recent = [];
  for (const r of rows) {
    const key = `${r.projectId}|${r.phaseId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recent.push({ project: r.project, phase: r.phase, lastDescription: r.description });
    if (recent.length === 5) break;
  }
  res.json({ recent });
});

entriesRouter.get("/entries", async (req, res) => {
  const user = currentUser(req);
  const { from, to } = rangeSchema.parse(req.query);
  const entries = await prisma.timesheetEntry.findMany({
    where: { userId: user.id, workDate: { gte: from, lte: to } },
    include: entryInclude,
    orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
  });
  res.json({ entries });
});

entriesRouter.post("/entries", async (req, res) => {
  const user = currentUser(req);
  const parsed = entrySchema.parse(req.body);
  const input = { ...parsed, startTime: parsed.startTime ?? null, endTime: parsed.endTime ?? null, minutes: slotMinutes(parsed) };
  const policy = await getPolicy();
  await validateEntry(user.id, input, policy);
  const entry = await prisma.timesheetEntry.create({
    data: { ...input, phaseId: input.phaseId ?? null, userId: user.id, status: "DRAFT" },
    include: entryInclude,
  });
  await recordAudit({ actorId: user.id, action: "ENTRY_CREATE", entityType: "TimesheetEntry", entityId: entry.id });
  res.status(201).json({ entry });
});

entriesRouter.patch("/entries/:id", async (req, res) => {
  const user = currentUser(req);
  const existing = await loadOwnEntry(user, idParam(req.params.id, "Entry not found."));
  assertEditable(existing);
  const patch = entrySchema.partial().parse(req.body);
  const merged = {
    ...existing,
    ...patch,
    phaseId: patch.phaseId === undefined ? existing.phaseId : patch.phaseId,
    startTime: patch.startTime === undefined ? existing.startTime : patch.startTime,
    endTime: patch.endTime === undefined ? existing.endTime : patch.endTime,
  };
  merged.minutes = slotMinutes(merged);
  const policy = await getPolicy();
  await validateEntry(user.id, merged, policy, existing.id);
  const entry = await prisma.timesheetEntry.update({
    where: { id: existing.id },
    data: {
      workDate: merged.workDate,
      projectId: merged.projectId,
      phaseId: merged.phaseId ?? null,
      minutes: merged.minutes,
      startTime: merged.startTime,
      endTime: merged.endTime,
      description: merged.description,
    },
    include: entryInclude,
  });
  const changes = diffFields(existing, {
    workDate: entry.workDate,
    projectId: entry.projectId,
    phaseId: entry.phaseId,
    minutes: entry.minutes,
    startTime: entry.startTime,
    endTime: entry.endTime,
  });
  // Record that the description changed without copying its text into the log.
  if (existing.description !== entry.description) changes.description = { from: "(edited)", to: "(edited)" };
  if (Object.keys(changes).length) {
    await recordAudit({ actorId: user.id, action: "ENTRY_UPDATE", entityType: "TimesheetEntry", entityId: entry.id, changes });
  }
  res.json({ entry });
});

entriesRouter.delete("/entries/:id", async (req, res) => {
  const user = currentUser(req);
  const existing = await loadOwnEntry(user, idParam(req.params.id, "Entry not found."));
  if (existing.status !== "DRAFT") throw badRequest("Only draft entries can be deleted.");
  await deleteAttachmentsFor([existing.id]);
  await prisma.$transaction([
    prisma.approvalAction.deleteMany({ where: { entryId: existing.id } }),
    prisma.timesheetEntry.delete({ where: { id: existing.id } }),
  ]);
  await recordAudit({
    actorId: user.id,
    action: "ENTRY_DELETE",
    entityType: "TimesheetEntry",
    entityId: existing.id,
    changes: { workDate: existing.workDate, projectId: existing.projectId, minutes: existing.minutes },
  });
  res.json({ ok: true });
});

entriesRouter.post("/entries/:id/recall", async (req, res) => {
  const user = currentUser(req);
  await recallEntry(user, idParam(req.params.id, "Entry not found."));
  res.json({ ok: true });
});

/** Approval history for one entry: visible to its owner and to in-scope reviewers. */
entriesRouter.get("/entries/:id/history", async (req, res) => {
  const user = currentUser(req);
  const entry = await prisma.timesheetEntry.findUnique({ where: { id: idParam(req.params.id, "Entry not found.") } });
  if (!entry || (entry.userId !== user.id && !(await canReviewEntry(user, entry)))) throw forbidden();
  const actions = await prisma.approvalAction.findMany({
    where: { entryId: entry.id },
    include: { actor: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ actions });
});

/** Weekly review: entries, daily totals, totals by project/phase, expected hours and flags. */
entriesRouter.get("/weeks/:start", async (req, res) => {
  const user = currentUser(req);
  const requested = String(req.params.start);
  if (!isValidDate(requested)) throw badRequest("Invalid week.");
  const [summary, me, projects] = await Promise.all([
    weekSummary(user.id, requested),
    prisma.user.findUnique({ where: { id: user.id }, select: { verifier: { select: { id: true, name: true } } } }),
    prisma.projectAssignment.count({ where: { userId: user.id, role: "MEMBER", project: { active: true } } }),
  ]);
  const policy = await getPolicy();
  res.json({
    ...summary,
    verifier: me?.verifier ?? null,
    hasProjects: projects > 0,
    checkin: { reminderHour: policy.reminderHour, enabled: policy.autoReminders },
  });
});

/**
 * "Repeat last week": copies last week's entries (project, phase, hours,
 * description) into the same weekdays of this week as drafts. Days that
 * already have entries are skipped. `preview: true` lists what would be
 * created without creating anything.
 */
entriesRouter.post("/weeks/:start/repeat-previous", async (req, res) => {
  const user = currentUser(req);
  const requested = String(req.params.start);
  if (!isValidDate(requested)) throw badRequest("Invalid week.");
  const { preview } = z.object({ preview: z.boolean().default(false) }).parse(req.body ?? {});
  const start = weekStart(requested);
  const prevStart = addDays(start, -7);
  const [previous, current] = await Promise.all([
    prisma.timesheetEntry.findMany({
      where: { userId: user.id, workDate: { gte: prevStart, lte: addDays(prevStart, 6) }, status: { not: "REJECTED" } },
      include: entryInclude,
      orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
    }),
    prisma.timesheetEntry.findMany({ where: { userId: user.id, workDate: { gte: start, lte: addDays(start, 6) } }, select: { workDate: true } }),
  ]);
  const busyDays = new Set(current.map((c) => c.workDate));
  const policy = await getPolicy();
  const plan: { workDate: string; projectId: string; phaseId: string | null; minutes: number; startTime: string | null; endTime: string | null; description: string; label: string }[] = [];
  const skipped: string[] = [];
  for (const e of previous) {
    const workDate = addDays(e.workDate, 7);
    if (busyDays.has(workDate)) continue;
    const draft = { workDate, projectId: e.projectId, phaseId: e.phaseId, minutes: e.minutes, startTime: e.startTime, endTime: e.endTime, description: e.description };
    try {
      await validateEntry(user.id, draft, policy);
      plan.push({ ...draft, label: `${e.startTime ? `${e.startTime}–${e.endTime} ` : ""}${e.project.code}${e.phase ? ` · ${e.phase.name}` : ""}` });
    } catch (err) {
      skipped.push(`${workDate} ${e.project.code}: ${(err as Error).message}`);
    }
  }
  if (!preview && plan.length) {
    const created = await prisma.$transaction(plan.map(({ label: _label, ...data }) => prisma.timesheetEntry.create({ data: { ...data, userId: user.id, status: "DRAFT" } })));
    for (const c of created) await recordAudit({ actorId: user.id, action: "ENTRY_CREATE", entityType: "TimesheetEntry", entityId: c.id, changes: { via: "repeat-last-week" } });
  }
  res.json({ created: preview ? 0 : plan.length, plan: plan.map(({ workDate, label, minutes, description }) => ({ workDate, label, minutes, description })), skipped });
});

/** An employee with no projects asks the admins to add them. At most once a day. */
entriesRouter.post("/me/request-projects", async (req, res) => {
  const user = currentUser(req);
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", active: true, id: { not: user.id } }, select: { id: true } });
  const sent = await notifyUsers(
    admins.map((a) => a.id),
    {
      kind: "INFO",
      title: `${user.name} needs a project`,
      body: `${user.name} (${user.email}) isn't on any project yet, so they can't log time. Add them under Projects & phases.`,
      link: "/admin/projects",
      createdById: user.id,
      dedupeKey: `request-projects:${user.id}:${today()}`,
    },
  );
  res.json({ ok: true, notified: sent > 0 });
});

entriesRouter.post("/weeks/:start/submit", async (req, res) => {
  const user = currentUser(req);
  const requested = String(req.params.start);
  if (!isValidDate(requested)) throw badRequest("Invalid week.");
  const start = weekStart(requested);
  res.json(await submitRange(user, start, addDays(start, 6)));
});
