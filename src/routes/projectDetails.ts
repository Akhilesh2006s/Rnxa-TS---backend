// Project and phase details for everyone, scoped:
// employees see their own projects and their own hours; managers see the
// projects their team works on with team hours; admins see everything.
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { addDays, isoWeekday, today } from "../services/dates.js";
import { teamMemberIds } from "../services/scope.js";

export const projectDetailsRouter = Router();

projectDetailsRouter.get("/project-details", async (req, res) => {
  const user = currentUser(req);
  const team = await teamMemberIds(user); // null = everyone (admin)
  const people = user.role === "EMPLOYEE" ? [user.id] : team === null ? null : [...team, user.id];

  const projectWhere: Prisma.ProjectWhereInput =
    people === null ? {} : { assignments: { some: { role: "MEMBER", userId: { in: people } } } };
  const projects = await prisma.project.findMany({
    where: projectWhere,
    include: {
      phases: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
      assignments: { where: { role: "MEMBER", ...(people === null ? {} : { userId: { in: people } }) }, include: { user: { select: { id: true, name: true } } } },
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });

  const entries = await prisma.timesheetEntry.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, status: { not: "REJECTED" }, ...(people === null ? {} : { userId: { in: people } }) },
    select: { projectId: true, phaseId: true, userId: true, minutes: true, workDate: true, status: true },
  });
  const weekStart = addDays(today(), 1 - isoWeekday(today()));
  const sum = (rows: { minutes: number }[]) => rows.reduce((s, r) => s + r.minutes, 0);

  res.json({
    scope: user.role === "EMPLOYEE" ? "mine" : team === null ? "all" : "team",
    projects: projects.map((p) => {
      const mine = entries.filter((e) => e.projectId === p.id);
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        client: p.client,
        description: p.description,
        startDate: p.startDate,
        endDate: p.endDate,
        active: p.active,
        phasesEnabled: p.phasesEnabled,
        totalMinutes: sum(mine),
        thisWeekMinutes: sum(mine.filter((e) => e.workDate >= weekStart)),
        verifiedMinutes: sum(mine.filter((e) => e.status === "APPROVED")),
        lastActivity: mine.map((e) => e.workDate).sort().at(-1) ?? null,
        people: user.role === "EMPLOYEE" ? [] : p.assignments.map((a) => a.user),
        phases: p.phases.map((ph) => ({
          id: ph.id,
          name: ph.name,
          description: ph.description,
          startDate: ph.startDate,
          endDate: ph.endDate,
          status: ph.status,
          active: ph.active,
          minutes: sum(mine.filter((e) => e.phaseId === ph.id)),
        })),
      };
    }),
  });
});
