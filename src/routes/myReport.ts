// An employee's own report: what they did in a period, how it's split across
// projects and phases, how much is verified, and where each project stands.
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { expectedByUser } from "../services/calendar.js";
import { badRequest } from "../errors.js";
import { ISO_DATE, addDays, isoWeekday, today } from "../services/dates.js";
import { getPolicy } from "../services/policy.js";
import { entryInclude } from "../services/timesheet.js";

export const myReportRouter = Router();

const sum = (rows: { minutes: number }[]) => rows.reduce((s, r) => s + r.minutes, 0);

myReportRouter.get("/me/report", async (req, res) => {
  const user = currentUser(req);
  const q = z.object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) }).parse(req.query);
  if (q.from > q.to) throw badRequest("The start date must be before the end date.");

  const [entries, allTime, policy] = await Promise.all([
    prisma.timesheetEntry.findMany({
      where: { userId: user.id, workDate: { gte: q.from, lte: q.to }, status: { not: "REJECTED" } },
      include: entryInclude,
    }),
    // Project status looks at all of the person's time, not just the period.
    prisma.timesheetEntry.findMany({
      where: { userId: user.id, status: { not: "REJECTED" } },
      select: { projectId: true, minutes: true, workDate: true, status: true, phase: { select: { name: true } } },
    }),
    getPolicy(),
  ]);
  entries.sort((a, b) => b.workDate.localeCompare(a.workDate) || (a.startTime ?? "99").localeCompare(b.startTime ?? "99"));

  // Expected hours in the period, up to today.
  const last = q.to < today() ? q.to : today();
  const expected = (await expectedByUser([user.id], q.from, last)).get(user.id) ?? 0;

  const byStatus = (status: string) => sum(entries.filter((e) => e.status === status));
  const days = new Map<string, number>();
  for (const e of entries) days.set(e.workDate, (days.get(e.workDate) ?? 0) + e.minutes);

  const projects = await prisma.project.findMany({
    where: { OR: [{ id: { in: [...new Set(allTime.map((e) => e.projectId))] } }, { assignments: { some: { userId: user.id, role: "MEMBER" } } }] },
    select: { id: true, code: true, name: true, client: true, active: true, assignments: { where: { userId: user.id, role: "MEMBER" }, select: { id: true } } },
    orderBy: { name: "asc" },
  });
  const thisWeekStart = addDays(today(), 1 - isoWeekday(today()));

  res.json({
    from: q.from,
    to: q.to,
    totals: {
      minutes: sum(entries),
      expectedMinutes: expected,
      verifiedMinutes: byStatus("APPROVED"),
      waitingMinutes: byStatus("SUBMITTED"),
      draftMinutes: byStatus("DRAFT"),
      changesMinutes: byStatus("CHANGES_REQUESTED"),
      daysLogged: days.size,
      entryCount: entries.length,
    },
    byDay: [...days.entries()].map(([date, minutes]) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date)),
    projects: projects
      .map((p) => {
        const inPeriod = entries.filter((e) => e.projectId === p.id);
        const ever = allTime.filter((e) => e.projectId === p.id);
        const phases = new Map<string, number>();
        for (const e of inPeriod) phases.set(e.phase?.name ?? "No phase", (phases.get(e.phase?.name ?? "No phase") ?? 0) + e.minutes);
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          client: p.client,
          // Where this project stands for the person.
          status: !p.active ? "closed" : p.assignments.length === 0 ? "removed" : ever.length === 0 ? "not started" : "active",
          periodMinutes: sum(inPeriod),
          verifiedMinutes: sum(inPeriod.filter((e) => e.status === "APPROVED")),
          waitingMinutes: sum(inPeriod.filter((e) => e.status === "SUBMITTED")),
          thisWeekMinutes: sum(ever.filter((e) => e.workDate >= thisWeekStart)),
          totalMinutes: sum(ever),
          lastWorked: ever.map((e) => e.workDate).sort().at(-1) ?? null,
          phases: [...phases.entries()].map(([name, minutes]) => ({ name, minutes })).sort((a, b) => b.minutes - a.minutes),
        };
      })
      .sort((a, b) => b.periodMinutes - a.periodMinutes || b.totalMinutes - a.totalMinutes),
    entries: entries.map((e) => ({
      id: e.id,
      workDate: e.workDate,
      startTime: e.startTime,
      endTime: e.endTime,
      minutes: e.minutes,
      description: e.description,
      status: e.status,
      autoVerified: e.autoVerified,
      project: e.project,
      phase: e.phase,
      reviewer: e.reviewer,
    })),
  });
});
