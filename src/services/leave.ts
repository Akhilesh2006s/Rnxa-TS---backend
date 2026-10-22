// Leave requests, balances and approvers, shared by the API and the AI assistant.
import { z } from "zod";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { badRequest, conflict } from "../errors.js";
import { recordAudit } from "./audit.js";
import { LEAVE_LABEL, LEAVE_TYPES, leaveDaysFor } from "./calendar.js";
import { ISO_DATE, addDays, isValidDate, today } from "./dates.js";
import { notifyUsers } from "./notifications.js";
import { getPolicy } from "./policy.js";

export const include = {
  user: { select: { id: true, name: true, email: true } },
  approver: { select: { id: true, name: true } },
} as const;

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const rangeText = (l: { startDate: string; endDate: string; halfDay: boolean }) =>
  l.halfDay ? `${fmt(l.startDate)} (half day)` : l.startDate === l.endDate ? fmt(l.startDate) : `${fmt(l.startDate)} – ${fmt(l.endDate)}`;
export const daysText = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** Who is asked to approve: the person's verifier, or every active admin when they have none. */
export async function approversFor(userId: string) {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { verifierId: true } });
  if (me?.verifierId) return [me.verifierId];
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", active: true, id: { not: userId } }, select: { id: true } });
  return admins.map((a) => a.id);
}

export async function leaveBalances(userId: string, year: number) {
  const policy = await getPolicy();
  const rows = await prisma.leaveRequest.findMany({
    where: { userId, status: { in: ["APPROVED", "PENDING"] }, startDate: { gte: `${year}-01-01`, lte: `${year}-12-31` } },
    select: { type: true, status: true, days: true },
  });
  return LEAVE_TYPES.map((type) => {
    const used = rows.filter((r) => r.type === type && r.status === "APPROVED").reduce((s, r) => s + r.days, 0);
    const pending = rows.filter((r) => r.type === type && r.status === "PENDING").reduce((s, r) => s + r.days, 0);
    const allowance = type === "UNPAID" ? null : policy.leaveAllowance[type];
    return { type, label: LEAVE_LABEL[type], allowance, used, pending, remaining: allowance === null ? null : allowance - used - pending };
  });
}

export const leaveRequestSchema = z
  .object({
    type: z.enum(LEAVE_TYPES),
    startDate: z.string().regex(ISO_DATE),
    endDate: z.string().regex(ISO_DATE),
    halfDay: z.boolean().default(false),
    reason: z.string().trim().max(1000).default(""),
  })
  .refine((v) => isValidDate(v.startDate) && isValidDate(v.endDate) && v.endDate >= v.startDate, { message: "The end date must be on or after the start date." })
  .refine((v) => !v.halfDay || v.startDate === v.endDate, { message: "A half day is a single date." });

export type LeaveRequestInput = z.infer<typeof leaveRequestSchema>;

/** Checks a request against dates, overlaps and balance; returns the working days it uses. */
export async function checkLeave(user: SessionUser, input: LeaveRequestInput) {
  if (input.startDate < addDays(today(), -60)) throw badRequest("Leave can be recorded up to 60 days back.");
  if (input.endDate > addDays(today(), 366)) throw badRequest("Leave can be requested up to a year ahead.");
  if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) throw badRequest("Split leave that crosses into a new year into two requests.");

  const days = await leaveDaysFor(input.startDate, input.endDate, input.halfDay);
  if (days === 0) throw badRequest("Those dates are all weekends or holidays, so no leave is needed.");
  const overlap = await prisma.leaveRequest.findFirst({
    where: { userId: user.id, status: { in: ["PENDING", "APPROVED"] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate } },
  });
  if (overlap) throw conflict(`You already have leave on ${rangeText(overlap)}.`);
  if (input.type !== "UNPAID") {
    const balance = (await leaveBalances(user.id, Number(input.startDate.slice(0, 4)))).find((b) => b.type === input.type)!;
    if (balance.remaining !== null && days > balance.remaining) {
      throw conflict(`Not enough ${LEAVE_LABEL[input.type].toLowerCase()}: ${daysText(balance.remaining)} left, ${daysText(days)} requested. Choose unpaid leave for the rest.`);
    }
  }
  return days;
}

export async function createLeave(user: SessionUser, input: LeaveRequestInput) {
  const days = await checkLeave(user, input);
  const leave = await prisma.leaveRequest.create({ data: { ...input, userId: user.id, days }, include });
  await recordAudit({ actorId: user.id, action: "LEAVE_REQUEST", entityType: "LeaveRequest", entityId: leave.id, changes: { type: input.type, startDate: input.startDate, endDate: input.endDate, days } });
  await notifyUsers(await approversFor(user.id), {
    kind: "INFO",
    title: `${user.name} requested leave`,
    body: `${LEAVE_LABEL[input.type]}, ${rangeText(leave)} (${daysText(days)}).${input.reason ? ` Reason: ${input.reason}` : ""}`,
    link: "/leave?tab=team",
    createdById: user.id,
  });
  return leave;
}
