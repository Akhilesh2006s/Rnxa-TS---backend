// Automatic reminder sweep. Runs on an interval from index.ts; every reminder is
// deduplicated so repeated sweeps never notify anyone twice for the same gap.
import { prisma } from "../db.js";
import { expectedByUser } from "./calendar.js";
import { addDays, isoWeekday, today, weekStart } from "./dates.js";
import { notifyUsers } from "./notifications.js";
import { getPolicy } from "./policy.js";

export async function runReminderSweep(now = new Date()) {
  const row = await prisma.orgPolicy.findUnique({ where: { id: "org" } });
  if (row && !row.autoReminders) return { sent: 0 };
  const policy = await getPolicy();
  const reminderHour = row?.reminderHour ?? 17;
  const date = today(now);
  const hour = now.getHours();
  let sent = 0;

  const members = await prisma.user.findMany({
    where: { active: true, assignments: { some: { role: "MEMBER", project: { active: true } } } },
    select: { id: true },
  });
  const memberIds = members.map((m) => m.id);

  // 1. End of a working day: remind people below expected hours today.
  if (policy.workDays.includes(isoWeekday(date)) && hour >= reminderHour && memberIds.length) {
    const logged = await prisma.timesheetEntry.groupBy({
      by: ["userId"],
      where: { userId: { in: memberIds }, workDate: date, status: { not: "REJECTED" } },
      _sum: { minutes: true },
    });
    // Leave and holidays lower (or remove) what's expected today.
    const expectedToday = await expectedByUser(memberIds, date, date);
    const short = memberIds.filter((id) => {
      const expected = expectedToday.get(id) ?? 0;
      return expected > 0 && (logged.find((l) => l.userId === id)?._sum.minutes ?? 0) < expected;
    });
    sent += await notifyUsers(short, {
      kind: "REMINDER",
      title: "Log today's time",
      body: "Tell RNXA what you worked on today. It writes up the entries for you to approve.",
      link: "/week?checkin=1",
      dedupeKey: `auto-missing-day:${date}`,
    });
  }

  // 2. Monday from 10:00: remind people who didn't submit last week in full.
  if (isoWeekday(date) === 1 && hour >= 10 && memberIds.length) {
    const lastWeek = addDays(weekStart(date), -7);
    const lastWeekEnd = addDays(lastWeek, 6);
    const expected = await expectedByUser(memberIds, lastWeek, lastWeekEnd);
    const submitted = await prisma.timesheetEntry.groupBy({
      by: ["userId"],
      where: { userId: { in: memberIds }, workDate: { gte: lastWeek, lte: lastWeekEnd }, status: { in: ["SUBMITTED", "APPROVED"] } },
      _sum: { minutes: true },
    });
    const missing = memberIds.filter((id) => (submitted.find((s) => s.userId === id)?._sum.minutes ?? 0) < (expected.get(id) ?? 0));
    sent += await notifyUsers(missing, {
      kind: "REMINDER",
      title: "Submit last week's timesheet",
      body: "Last week's submitted hours are below what's expected. Review and submit your week.",
      link: `/timesheet?week=${lastWeek}`,
      dedupeKey: `auto-missing-week:${lastWeek}`,
    });
  }

  // 3. Reviewers with entries waiting more than two days.
  const stale = await prisma.timesheetEntry.findMany({
    where: { status: "SUBMITTED", submittedAt: { lt: new Date(now.getTime() - 2 * 86_400_000) } },
    select: { user: { select: { verifierId: true } } },
  });
  if (stale.length) {
    const verifierIds = [...new Set(stale.map((s) => s.user.verifierId).filter((v): v is string => !!v))];
    // Entries whose owner has no verifier fall to the admins.
    const admins = stale.some((s) => !s.user.verifierId)
      ? (await prisma.user.findMany({ where: { role: "ADMIN", active: true }, select: { id: true } })).map((a) => a.id)
      : [];
    sent += await notifyUsers(
      [...verifierIds, ...admins],
      {
        kind: "REMINDER",
        title: "Time waiting for you to verify",
        body: "Some submitted time has been waiting more than two days for your verification.",
        link: "/reviews",
        dedupeKey: `auto-stale-approvals:${date}`,
      },
    );
  }
  return { sent };
}

export function startReminderScheduler(intervalMs = 15 * 60_000) {
  const tick = () =>
    runReminderSweep().catch((e) => console.error("[reminders] sweep failed", (e as Error).message));
  setTimeout(tick, 30_000);
  return setInterval(tick, intervalMs);
}
