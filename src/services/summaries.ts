// Read models shared by the API screens and the AI assistant. All functions
// apply the caller's access scope.
import type { Prisma } from "@prisma/client";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import type { EntryStatus } from "../domain.js";
import { addDays, isoWeekday, today, weekDates, weekStart } from "./dates.js";
import { dayPlans, expectedByUser } from "./calendar.js";
import { getPolicy } from "./policy.js";
import { teamMemberIds, teamUsersWhere } from "./scope.js";
import { entryInclude, flagEntries, lockedDays } from "./timesheet.js";

const sum = (rows: { minutes: number }[]) => rows.reduce((s, r) => s + r.minutes, 0);

/** Expected minutes on the organisation calendar (work days minus holidays), before anyone's leave. */
export async function expectedMinutesBetween(from: string, to: string) {
  if (from > to) return 0;
  const policy = await getPolicy();
  const holidays = await prisma.holiday.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true } });
  const off = new Set(holidays.map((h) => h.date));
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (policy.workDays.includes(isoWeekday(d)) && !off.has(d)) total += policy.expectedDailyMinutes;
  }
  return total;
}

/** One user's week: entries, daily totals vs policy, totals by project/phase and review flags. */
export async function weekSummary(userId: string, anyDateInWeek: string) {
  const start = weekStart(anyDateInWeek);
  const end = addDays(start, 6);
  const policy = await getPolicy();
  const entries = await prisma.timesheetEntry.findMany({
    where: { userId, workDate: { gte: start, lte: end } },
    include: entryInclude,
    orderBy: [{ workDate: "asc" }, { createdAt: "asc" }],
  });
  // Within a day, time slots in order; entries without a time keep their creation order after them.
  entries.sort((a, b) => a.workDate.localeCompare(b.workDate) || (a.startTime ?? "99").localeCompare(b.startTime ?? "99"));
  const counted = entries.filter((e) => e.status !== "REJECTED");
  const now = today();
  const plan = (await dayPlans([userId], start, end)).get(userId)!;
  const days = plan.map((p) => {
    const minutes = counted.filter((e) => e.workDate === p.date).reduce((s, e) => s + e.minutes, 0);
    return {
      date: p.date,
      minutes,
      expectedMinutes: p.expectedMinutes,
      missing: p.expectedMinutes > 0 && p.date <= now && minutes < p.expectedMinutes,
      holiday: p.holiday,
      leave: p.leave,
    };
  });
  const byProject = new Map<string, { project: string; phase: string | null; minutes: number }>();
  for (const e of counted) {
    const key = `${e.projectId}|${e.phaseId ?? ""}`;
    const row = byProject.get(key) ?? { project: `${e.project.code} · ${e.project.name}`, phase: e.phase?.name ?? null, minutes: 0 };
    row.minutes += e.minutes;
    byProject.set(key, row);
  }
  const statusCounts: Record<string, number> = {};
  for (const e of entries) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
  const locked = await lockedDays(userId, weekDates(start), policy);

  return {
    start,
    end,
    entries,
    days,
    totalMinutes: sum(counted),
    expectedMinutes: days.reduce((s, d) => s + d.expectedMinutes, 0),
    byProjectPhase: [...byProject.values()].sort((a, b) => b.minutes - a.minutes),
    statusCounts,
    flags: flagEntries(entries, policy),
    lockedDays: [...locked],
    policy: { expectedDailyMinutes: policy.expectedDailyMinutes, workDays: policy.workDays, longEntryMinutes: policy.longEntryMinutes },
  };
}

export type GroupBy = "employee" | "project" | "phase" | "date" | "status";

export interface ReportQuery {
  from: string;
  to: string;
  projectId?: string;
  phaseId?: string;
  userId?: string;
  status?: EntryStatus;
  groupBy: GroupBy;
}

/** Entry filter for reporting: employees see their own time, managers their team plus own time, admins everything. */
export async function reportScope(user: SessionUser): Promise<Prisma.TimesheetEntryWhereInput> {
  if (user.role === "EMPLOYEE") return { userId: user.id };
  const ids = await teamMemberIds(user);
  return ids === null ? {} : { userId: { in: [...ids, user.id] } };
}

export function groupMinutes<T>(rows: T[], key: (r: T) => string, minutes: (r: T) => number) {
  const map = new Map<string, number>();
  for (const r of rows) map.set(key(r), (map.get(key(r)) ?? 0) + minutes(r));
  return [...map.entries()].map(([label, m]) => ({ label, minutes: m })).sort((a, b) => b.minutes - a.minutes);
}

export async function hoursReport(user: SessionUser, q: ReportQuery) {
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      AND: [
        await reportScope(user),
        { workDate: { gte: q.from, lte: q.to } },
        q.projectId ? { projectId: q.projectId } : {},
        q.phaseId ? { phaseId: q.phaseId } : {},
        q.userId ? { userId: q.userId } : {},
        q.status ? { status: q.status } : { status: { not: "REJECTED" } },
      ],
    },
    include: entryInclude,
  });
  type E = (typeof entries)[number];
  const key: Record<GroupBy, (e: E) => string> = {
    employee: (e) => e.user.name,
    project: (e) => `${e.project.code} · ${e.project.name}`,
    phase: (e) => `${e.project.code} · ${e.phase?.name ?? "No phase"}`,
    date: (e) => e.workDate,
    status: (e) => e.status,
  };
  const rows = groupMinutes(entries, key[q.groupBy], (e) => e.minutes);
  if (q.groupBy === "date") rows.sort((a, b) => a.label.localeCompare(b.label));
  return { rows, totalMinutes: sum(entries), entryCount: entries.length };
}

/**
 * Per-person logged and submitted time for one week, for the people this user
 * is responsible for (their verifiees; everyone for admins).
 */
export async function teamStatus(user: SessionUser, anyDateInWeek: string) {
  const start = weekStart(anyDateInWeek);
  const end = addDays(start, 6);
  const members = await prisma.user.findMany({
    where: teamUsersWhere(user),
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
  const entries = await prisma.timesheetEntry.findMany({
    where: { userId: { in: members.map((m) => m.id) }, workDate: { gte: start, lte: end }, status: { not: "REJECTED" } },
    select: { userId: true, minutes: true, status: true, workDate: true },
  });
  const now = today();
  const expectedWeek = await expectedMinutesBetween(start, end);
  const expectedToDate = await expectedMinutesBetween(start, now < end ? now : end);
  const ids = members.map((m) => m.id);
  const [personWeek, personToDate] = await Promise.all([expectedByUser(ids, start, end), expectedByUser(ids, start, now < end ? now : end)]);
  return {
    weekStart: start,
    expectedWeekMinutes: expectedWeek,
    expectedToDateMinutes: expectedToDate,
    people: members.map((m) => {
      const mine = entries.filter((e) => e.userId === m.id);
      return {
        user: m,
        loggedMinutes: sum(mine),
        draftMinutes: sum(mine.filter((e) => e.status === "DRAFT" || e.status === "CHANGES_REQUESTED")),
        submittedMinutes: sum(mine.filter((e) => e.status === "SUBMITTED" || e.status === "APPROVED")),
        approvedMinutes: sum(mine.filter((e) => e.status === "APPROVED")),
        // After this person's approved leave.
        expectedWeekMinutes: personWeek.get(m.id) ?? 0,
        expectedToDateMinutes: personToDate.get(m.id) ?? 0,
      };
    }),
  };
}
