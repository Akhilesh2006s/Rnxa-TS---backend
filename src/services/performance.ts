// Team performance from timesheet records: hours against expected (after leave
// and holidays), days with no time, how promptly time is submitted, and how
// often entries are sent back. It measures timesheet discipline, not the
// quality of anyone's work; the reasons are listed so a person can be talked
// to with specifics rather than a number.
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { type DayPlan, dayPlans } from "./calendar.js";
import { addDays, daysBetween, today } from "./dates.js";
import { teamUsersWhere } from "./scope.js";

/** Submitted within this many days of the work date counts as on time. */
export const ON_TIME_DAYS = 2;
/** A draft older than this is overdue. */
export const OVERDUE_DRAFT_DAYS = 7;

export type Rating = "STRONG" | "ON_TRACK" | "NEEDS_ATTENTION" | "NO_DATA";

export interface PersonPerformance {
  user: { id: string; name: string; email: string; role: string };
  verifier: { id: string; name: string } | null;
  expectedMinutes: number;
  loggedMinutes: number;
  verifiedMinutes: number;
  waitingMinutes: number;
  draftMinutes: number;
  utilization: number | null;
  emptyDays: number;
  shortDays: number;
  leaveDays: number;
  entries: number;
  submitted: number;
  onTime: number;
  late: number;
  overdueDrafts: number;
  avgSubmitDelayDays: number | null;
  sentBack: number;
  rejected: number;
  timeliness: number | null;
  quality: number | null;
  score: number | null;
  rating: Rating;
  reasons: string[];
  byProject: { label: string; minutes: number }[];
  days: { date: string; minutes: number; expectedMinutes: number; holiday: string | null; leave: DayPlan["leave"] }[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const hours = (m: number) => `${Math.round((m / 60) * 10) / 10}h`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ratingFor(score: number | null): Rating {
  if (score === null) return "NO_DATA";
  if (score >= 85) return "STRONG";
  if (score >= 70) return "ON_TRACK";
  return "NEEDS_ATTENTION";
}

/**
 * One row per person this user is responsible for (a manager's team; for admins,
 * everyone who logs time) over [from, to]. Only finished days (before today) count.
 */
export async function teamPerformance(user: SessionUser, from: string, to: string, onlyUserId?: string) {
  const now = today();
  // Today is still in progress, so scoring covers finished days only.
  const end = to < now ? to : addDays(now, -1);
  const members = await prisma.user.findMany({
    where: { AND: [teamUsersWhere(user), onlyUserId ? { id: onlyUserId } : {}] },
    select: { id: true, name: true, email: true, role: true, verifier: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  const ids = members.map((m) => m.id);
  const [plans, entries, sentBackActions] = await Promise.all([
    dayPlans(ids, from, to),
    prisma.timesheetEntry.findMany({
      where: { userId: { in: ids }, workDate: { gte: from, lte: to } },
      select: {
        id: true,
        userId: true,
        workDate: true,
        minutes: true,
        status: true,
        submittedAt: true,
        project: { select: { code: true, name: true } },
      },
    }),
    prisma.approvalAction.findMany({
      where: { action: { in: ["REQUEST_CHANGES", "REJECT"] }, entry: { userId: { in: ids }, workDate: { gte: from, lte: to } } },
      select: { entryId: true, action: true },
    }),
  ]);
  const sentBackIds = new Set(sentBackActions.filter((a) => a.action === "REQUEST_CHANGES").map((a) => a.entryId));
  const rejectedIds = new Set(sentBackActions.filter((a) => a.action === "REJECT").map((a) => a.entryId));

  const people: PersonPerformance[] = members.map((m) => {
    const plan = plans.get(m.id) ?? [];
    const mine = entries.filter((e) => e.userId === m.id);
    const counted = mine.filter((e) => e.status !== "REJECTED");
    const pastCounted = counted.filter((e) => e.workDate <= end);
    const sum = (rows: { minutes: number }[]) => rows.reduce((s, r) => s + r.minutes, 0);
    const minutesOn = (date: string) => sum(counted.filter((e) => e.workDate === date));

    const pastPlan = plan.filter((d) => d.date <= end);
    const expected = pastPlan.reduce((s, d) => s + d.expectedMinutes, 0);
    const logged = sum(pastCounted);
    const finished = pastPlan.filter((d) => d.expectedMinutes > 0);
    const emptyDays = finished.filter((d) => minutesOn(d.date) === 0).length;
    const shortDays = finished.filter((d) => {
      const got = minutesOn(d.date);
      return got > 0 && got < d.expectedMinutes;
    }).length;
    const leaveDays = plan.filter((d) => d.leave).reduce((s, d) => s + (d.leave!.halfDay ? 0.5 : 1), 0);

    const submittedRows = mine.filter((e) => e.submittedAt);
    const delays = submittedRows.map((e) => Math.max(0, daysBetween(e.workDate, e.submittedAt!.toISOString().slice(0, 10))));
    const onTime = delays.filter((d) => d <= ON_TIME_DAYS).length;
    const overdueDrafts = mine.filter((e) => (e.status === "DRAFT" || e.status === "CHANGES_REQUESTED") && e.workDate <= addDays(now, -OVERDUE_DRAFT_DAYS)).length;
    const late = submittedRows.length - onTime;
    const timelinessBase = submittedRows.length + overdueDrafts;
    const timeliness = timelinessBase ? onTime / timelinessBase : null;

    const sentBack = mine.filter((e) => sentBackIds.has(e.id)).length;
    const rejected = mine.filter((e) => rejectedIds.has(e.id)).length;
    const reviewed = mine.filter((e) => e.status === "APPROVED" || sentBackIds.has(e.id) || rejectedIds.has(e.id)).length;
    const quality = reviewed ? Math.max(0, 1 - (sentBack + rejected) / reviewed) : null;

    const utilization = expected ? logged / expected : null;
    // Hours count for half; promptness and clean entries a quarter each. Missing parts take a neutral 1.
    const score =
      utilization === null ? null : Math.round(50 * Math.min(utilization, 1) + 25 * (timeliness ?? 1) + 25 * (quality ?? 1));

    const reasons: string[] = [];
    if (utilization !== null && utilization < 0.9) reasons.push(`Logged ${hours(logged)} of ${hours(expected)} expected (${pct(utilization)})`);
    if (utilization !== null && utilization > 1.2) reasons.push(`Logging well above expected hours (${pct(utilization)}). Check workload`);
    if (emptyDays) reasons.push(`${plural(emptyDays, "working day")} with no time logged`);
    if (shortDays >= 3) reasons.push(`${plural(shortDays, "day")} below the daily hours`);
    if (late) reasons.push(`${plural(late, "entry", "entries")} submitted more than ${ON_TIME_DAYS} days late`);
    if (overdueDrafts) reasons.push(`${plural(overdueDrafts, "entry", "entries")} not submitted after ${OVERDUE_DRAFT_DAYS} days`);
    if (sentBack) reasons.push(`${plural(sentBack, "entry", "entries")} sent back for changes`);
    if (rejected) reasons.push(`${plural(rejected, "entry", "entries")} rejected`);

    const byProject = new Map<string, number>();
    for (const e of pastCounted) {
      const key = `${e.project.code} · ${e.project.name}`;
      byProject.set(key, (byProject.get(key) ?? 0) + e.minutes);
    }

    return {
      user: { id: m.id, name: m.name, email: m.email, role: m.role },
      verifier: m.verifier,
      expectedMinutes: expected,
      loggedMinutes: logged,
      verifiedMinutes: sum(pastCounted.filter((e) => e.status === "APPROVED")),
      waitingMinutes: sum(pastCounted.filter((e) => e.status === "SUBMITTED")),
      draftMinutes: sum(pastCounted.filter((e) => e.status === "DRAFT" || e.status === "CHANGES_REQUESTED")),
      utilization,
      emptyDays,
      shortDays,
      leaveDays,
      entries: mine.length,
      submitted: submittedRows.length,
      onTime,
      late,
      overdueDrafts,
      avgSubmitDelayDays: delays.length ? Math.round((delays.reduce((s, d) => s + d, 0) / delays.length) * 10) / 10 : null,
      sentBack,
      rejected,
      timeliness,
      quality,
      score,
      rating: ratingFor(score),
      reasons,
      byProject: [...byProject].map(([label, minutes]) => ({ label, minutes })).sort((a, b) => b.minutes - a.minutes),
      days: plan.map((d) => ({ date: d.date, minutes: minutesOn(d.date), expectedMinutes: d.expectedMinutes, holiday: d.holiday, leave: d.leave })),
    };
  });

  const total = (k: "expectedMinutes" | "loggedMinutes" | "verifiedMinutes") => people.reduce((s, p) => s + p[k], 0);
  const scored = people.filter((p) => p.score !== null);
  return {
    from,
    to,
    countedTo: end,
    summary: {
      people: people.length,
      expectedMinutes: total("expectedMinutes"),
      loggedMinutes: total("loggedMinutes"),
      verifiedMinutes: total("verifiedMinutes"),
      averageScore: scored.length ? Math.round(scored.reduce((s, p) => s + p.score!, 0) / scored.length) : null,
      needsAttention: people.filter((p) => p.rating === "NEEDS_ATTENTION").length,
      emptyDays: people.reduce((s, p) => s + p.emptyDays, 0),
      leaveDays: people.reduce((s, p) => s + p.leaveDays, 0),
      sentBack: people.reduce((s, p) => s + p.sentBack, 0),
    },
    // Lowest score first: the people who need a conversation are at the top.
    people: people.sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.user.name.localeCompare(b.user.name)),
  };
}
