// Role-aware home dashboards and the hours report. Hours are reported as hours;
// no utilisation or productivity scores are derived from them.
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { currentUser, type SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { STATUSES, objectId } from "../domain.js";
import { forbidden } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { notifyUsers } from "../services/notifications.js";
import { ISO_DATE, addDays, isoWeekday, today, weekStart } from "../services/dates.js";
import { expectedByUser } from "../services/calendar.js";
import { expectedMinutesBetween, groupMinutes, hoursReport } from "../services/summaries.js";
import { reviewScopeWhere, teamMemberIds, teamUsersWhere } from "../services/scope.js";
import { entryInclude } from "../services/timesheet.js";

export const dashboardRouter = Router();

const sum = (rows: { minutes: number }[]) => rows.reduce((s, r) => s + r.minutes, 0);

async function employeeSummary(user: SessionUser) {
  const now = today();
  const start = weekStart(now);
  const week = await prisma.timesheetEntry.findMany({
    where: { userId: user.id, workDate: { gte: start, lte: addDays(start, 6) }, status: { not: "REJECTED" } },
  });
  const returned = await prisma.timesheetEntry.findMany({
    where: { userId: user.id, status: "CHANGES_REQUESTED" },
    include: entryInclude,
    orderBy: { reviewedAt: "desc" },
    take: 10,
  });
  const counts = (status: string) => week.filter((e) => e.status === status).length;
  return {
    weekStart: start,
    todayMinutes: sum(week.filter((e) => e.workDate === now)),
    weekMinutes: sum(week),
    expectedWeekMinutes: (await expectedByUser([user.id], start, addDays(start, 6))).get(user.id) ?? 0,
    expectedToDateMinutes: (await expectedByUser([user.id], start, now)).get(user.id) ?? 0,
    draftCount: counts("DRAFT"),
    submittedCount: counts("SUBMITTED"),
    approvedCount: counts("APPROVED"),
    returned,
  };
}


async function reviewSummary(user: SessionUser) {
  const scope = await reviewScopeWhere(user);
  const start = weekStart(today());
  const end = addDays(start, 6);
  const notSelf = { userId: { not: user.id } };

  const [pending, changesRequested, oldestPending, weekEntries, members] = await Promise.all([
    prisma.timesheetEntry.count({ where: { ...scope, ...notSelf, status: "SUBMITTED" } }),
    prisma.timesheetEntry.count({ where: { ...scope, ...notSelf, status: "CHANGES_REQUESTED" } }),
    prisma.timesheetEntry.findFirst({ where: { ...scope, ...notSelf, status: "SUBMITTED" }, orderBy: { submittedAt: "asc" }, select: { submittedAt: true } }),
    prisma.timesheetEntry.findMany({
      where: { ...scope, ...notSelf, workDate: { gte: start, lte: end }, status: { not: "REJECTED" } },
      include: entryInclude,
    }),
    prisma.user.findMany({
      where: teamUsersWhere(user),
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const toDate = today() < end ? today() : end;
  const ids = members.map((m) => m.id);
  const [weekByUser, toDateByUser] = await Promise.all([expectedByUser(ids, start, end), expectedByUser(ids, start, toDate)]);
  const expectedToDate = await expectedMinutesBetween(start, toDate);
  const team = members.map((m) => {
    const mine = weekEntries.filter((e) => e.userId === m.id);
    return {
      user: m,
      loggedMinutes: sum(mine),
      submittedMinutes: sum(mine.filter((e) => e.status === "SUBMITTED" || e.status === "APPROVED")),
      verifiedMinutes: sum(mine.filter((e) => e.status === "APPROVED")),
      waitingCount: mine.filter((e) => e.status === "SUBMITTED").length,
      expectedMinutes: weekByUser.get(m.id) ?? 0,
      expectedToDateMinutes: toDateByUser.get(m.id) ?? 0,
    };
  });
  const autoVerifiedMinutes = sum(weekEntries.filter((e) => e.status === "APPROVED" && e.autoVerified));
  const verifiedMinutes = sum(weekEntries.filter((e) => e.status === "APPROVED"));

  return {
    weekStart: start,
    expectedToDateMinutes: expectedToDate,
    teamMinutes: sum(weekEntries),
    verifiedMinutes,
    autoVerifiedMinutes,
    pendingApprovals: pending,
    changesRequested,
    oldestPendingAt: oldestPending?.submittedAt ?? null,
    team,
    byEmployee: groupMinutes(weekEntries, (e) => e.user.name, (e) => e.minutes),
    byProject: groupMinutes(weekEntries, (e) => `${e.project.code} · ${e.project.name}`, (e) => e.minutes),
    byPhase: groupMinutes(weekEntries, (e) => `${e.project.code} · ${e.phase?.name ?? "No phase"}`, (e) => e.minutes),
  };
}

async function orgSummary() {
  const thisWeek = weekStart(today());
  const firstWeek = addDays(thisWeek, -7 * 7);
  const entries = await prisma.timesheetEntry.findMany({
    where: { workDate: { gte: firstWeek, lte: addDays(thisWeek, 6) }, status: { not: "REJECTED" } },
    select: { workDate: true, minutes: true, userId: true, status: true },
  });
  const trend = Array.from({ length: 8 }, (_, i) => {
    const s = addDays(firstWeek, i * 7);
    const e = addDays(s, 6);
    const rows = entries.filter((r) => r.workDate >= s && r.workDate <= e);
    return { weekStart: s, minutes: sum(rows), approvedMinutes: sum(rows.filter((r) => r.status === "APPROVED")) };
  });

  // Missing timesheets: active members whose submitted time last week fell short of policy.
  const lastWeek = addDays(thisWeek, -7);
  const lastWeekEnd = addDays(lastWeek, 6);
  const members = await prisma.user.findMany({
    where: { active: true, assignments: { some: { role: "MEMBER" } } },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
  const expectedLastWeek = await expectedByUser(members.map((m) => m.id), lastWeek, lastWeekEnd);
  const missing = members
    .map((m) => ({
      user: m,
      submittedMinutes: sum(
        entries.filter((e) => e.userId === m.id && e.workDate >= lastWeek && e.workDate <= lastWeekEnd && (e.status === "SUBMITTED" || e.status === "APPROVED")),
      ),
      expectedMinutes: expectedLastWeek.get(m.id) ?? 0,
    }))
    .filter((r) => r.submittedMinutes < r.expectedMinutes);

  const [activeUsers, activeProjects, backlogByProject] = await Promise.all([
    prisma.user.count({ where: { active: true } }),
    prisma.project.count({ where: { active: true } }),
    prisma.timesheetEntry.groupBy({ by: ["projectId"], where: { status: "SUBMITTED" }, _count: { _all: true } }),
  ]);
  const projects = await prisma.project.findMany({ where: { id: { in: backlogByProject.map((b) => b.projectId) } }, select: { id: true, code: true, name: true } });

  return {
    trend,
    lastWeekStart: lastWeek,
    missing,
    activeUsers,
    activeProjects,
    backlog: backlogByProject
      .map((b) => ({ project: projects.find((p) => p.id === b.projectId), count: b._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

dashboardRouter.get("/dashboard", async (req, res) => {
  const user = currentUser(req);
  const [employee, review, org] = await Promise.all([
    employeeSummary(user),
    user.role === "EMPLOYEE" ? null : reviewSummary(user),
    user.role === "ADMIN" ? orgSummary() : null,
  ]);
  res.json({ employee, review, org });
});

const reportSchema = z.object({
  from: z.string().regex(ISO_DATE),
  to: z.string().regex(ISO_DATE),
  projectId: objectId.optional(),
  phaseId: objectId.optional(),
  userId: objectId.optional(),
  status: z.enum(STATUSES).optional(),
  groupBy: z.enum(["employee", "project", "phase", "date", "status"]).default("project"),
});

/** Hours report, scoped: employees see their own time, managers their projects, admins everything. */
dashboardRouter.get("/reports/hours", async (req, res) => {
  const user = currentUser(req);
  const q = reportSchema.parse(req.query);
  res.json(await hoursReport(user, q));
});

/** Filter options for the report screen, limited to what the user may see. */
dashboardRouter.get("/reports/options", async (req, res) => {
  const user = currentUser(req);
  const ids = await teamMemberIds(user);
  const people = ids === null ? null : [...ids, user.id];
  const projectWhere: Prisma.ProjectWhereInput =
    user.role === "EMPLOYEE" ? { assignments: { some: { userId: user.id } } } : people === null ? {} : { assignments: { some: { userId: { in: people } } } };
  const projects = await prisma.project.findMany({
    where: projectWhere,
    select: { id: true, code: true, name: true, phases: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  const users =
    user.role === "EMPLOYEE"
      ? [{ id: user.id, name: user.name }]
      : await prisma.user.findMany({
          where: people === null ? {} : { id: { in: people } },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        });
  res.json({ projects, users });
});

/**
 * One-click reminder from the team dashboard. Only people you verify (anyone,
 * for admins), and at most one manual reminder per person per day.
 */
dashboardRouter.post("/team/remind", async (req, res) => {
  const user = currentUser(req);
  if (user.role === "EMPLOYEE") throw forbidden();
  const { userIds, message } = z.object({ userIds: z.array(objectId).min(1).max(100), message: z.string().trim().max(500).optional() }).parse(req.body);
  const team = await prisma.user.findMany({ where: { ...teamUsersWhere(user), id: { in: userIds } }, select: { id: true } });
  if (team.length !== new Set(userIds).size) throw forbidden("Some of those people aren't in your team.");
  const sent = await notifyUsers(userIds, {
    kind: "REMINDER",
    title: `Reminder from ${user.name}`,
    body: message || "Your timesheet is behind for this week. Please log and submit your time.",
    link: "/",
    createdById: user.id,
    dedupeKey: `manual-remind:${today()}:${user.id}`,
  });
  await recordAudit({ actorId: user.id, action: "REMINDER_SEND", entityType: "Notification", entityId: user.id, changes: { recipients: userIds, sent } });
  res.json({ sent, skipped: userIds.length - sent });
});
