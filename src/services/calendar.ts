// The working calendar: which days each person is expected to log time on,
// after weekends (policy work days), organisation holidays and approved leave.
import { prisma } from "../db.js";
import { addDays, isoWeekday } from "./dates.js";
import { getPolicy } from "./policy.js";

export const LEAVE_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_LABEL: Record<LeaveType, string> = { CASUAL: "Casual leave", SICK: "Sick leave", EARNED: "Earned leave", UNPAID: "Unpaid leave" };

export interface DayPlan {
  date: string;
  expectedMinutes: number;
  holiday: string | null;
  leave: { type: LeaveType; halfDay: boolean } | null;
}

export async function holidaysBetween(from: string, to: string) {
  const rows = await prisma.holiday.findMany({ where: { date: { gte: from, lte: to } }, orderBy: { date: "asc" } });
  return new Map(rows.map((h) => [h.date, h.name]));
}

/** Approved leave overlapping the range, for the given people. */
export function approvedLeave(userIds: string[], from: string, to: string) {
  return prisma.leaveRequest.findMany({
    where: { userId: { in: userIds }, status: "APPROVED", startDate: { lte: to }, endDate: { gte: from } },
    orderBy: { startDate: "asc" },
  });
}

/** Working days a leave request would use: work days that aren't holidays; 0.5 for a half day. */
export async function leaveDaysFor(startDate: string, endDate: string, halfDay: boolean) {
  const policy = await getPolicy();
  const holidays = await holidaysBetween(startDate, endDate);
  let days = 0;
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    if (policy.workDays.includes(isoWeekday(d)) && !holidays.has(d)) days++;
  }
  return halfDay ? Math.min(days, 0.5) : days;
}

/**
 * Each person's day-by-day plan for the range. Leave that covers a day sets
 * it to 0 expected minutes (half for a half day); holidays and non-work days are 0.
 */
export async function dayPlans(userIds: string[], from: string, to: string): Promise<Map<string, DayPlan[]>> {
  const [policy, holidays, leave] = await Promise.all([getPolicy(), holidaysBetween(from, to), approvedLeave(userIds, from, to)]);
  const plans = new Map<string, DayPlan[]>();
  for (const userId of userIds) {
    const mine = leave.filter((l) => l.userId === userId);
    const days: DayPlan[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const holiday = holidays.get(d) ?? null;
      const work = policy.workDays.includes(isoWeekday(d)) && !holiday;
      const l = mine.find((x) => x.startDate <= d && x.endDate >= d);
      let expected = work ? policy.expectedDailyMinutes : 0;
      if (work && l) expected = l.halfDay ? Math.round(expected / 2) : 0;
      days.push({ date: d, expectedMinutes: expected, holiday, leave: work && l ? { type: l.type as LeaveType, halfDay: l.halfDay } : null });
    }
    plans.set(userId, days);
  }
  return plans;
}

/** Expected minutes per person for the range (from > to gives 0). */
export async function expectedByUser(userIds: string[], from: string, to: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (from > to) {
    for (const id of userIds) out.set(id, 0);
    return out;
  }
  const plans = await dayPlans(userIds, from, to);
  for (const [id, days] of plans) out.set(id, days.reduce((s, d) => s + d.expectedMinutes, 0));
  return out;
}
