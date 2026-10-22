// Leave management: people request leave; their verifier (or an admin)
// approves it. Approved leave lowers expected hours and blocks logging time
// on full days off. Holidays are set by anyone who can change policy.
import { Router } from "express";
import { z } from "zod";
import { currentUser, type SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { conflict, forbidden, idParam, notFound } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { LEAVE_LABEL, holidaysBetween, type LeaveType } from "../services/calendar.js";
import { createLeave, include, leaveBalances, leaveRequestSchema, rangeText } from "../services/leave.js";
import { ISO_DATE, addDays, isValidDate, today } from "../services/dates.js";
import { notifyUsers } from "../services/notifications.js";
import { can } from "../services/permissions.js";
import { teamMemberIds } from "../services/scope.js";

export const leaveRouter = Router();

/** Approvers can act on the leave of people they verify (anyone else, for admins); never their own. */
async function canDecide(user: SessionUser, ownerId: string) {
  if (ownerId === user.id) return false;
  const ids = await teamMemberIds(user);
  return ids === null || ids.includes(ownerId);
}

/** My balances, requests and this year's holidays. */
leaveRouter.get("/leave/me", async (req, res) => {
  const user = currentUser(req);
  const year = z.coerce.number().int().min(2000).max(2100).default(Number(today().slice(0, 4))).parse(req.query.year);
  const [balances, requests, holidays] = await Promise.all([
    leaveBalances(user.id, year),
    prisma.leaveRequest.findMany({ where: { userId: user.id }, include, orderBy: { startDate: "desc" }, take: 100 }),
    holidaysBetween(`${year}-01-01`, `${year}-12-31`),
  ]);
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { verifier: { select: { id: true, name: true } } } });
  res.json({
    year,
    balances,
    requests,
    holidays: [...holidays].map(([date, name]) => ({ date, name })),
    approver: me?.verifier ?? null,
  });
});

leaveRouter.post("/leave", async (req, res) => {
  const user = currentUser(req);
  const leave = await createLeave(user, leaveRequestSchema.parse(req.body));
  res.status(201).json({ leave });
});

/** The owner cancels a pending request, or approved leave that hasn't started yet. */
leaveRouter.post("/leave/:id/cancel", async (req, res) => {
  const user = currentUser(req);
  const leave = await prisma.leaveRequest.findUnique({ where: { id: idParam(req.params.id, "Leave not found.") } });
  if (!leave || leave.userId !== user.id) throw notFound("Leave not found.");
  if (leave.status === "APPROVED" ? leave.startDate <= today() : leave.status !== "PENDING") {
    throw conflict(leave.status === "APPROVED" ? "This leave has started. Ask your approver to change it." : "This request is already closed.");
  }
  await prisma.leaveRequest.update({ where: { id: leave.id }, data: { status: "CANCELLED" } });
  await recordAudit({ actorId: user.id, action: "LEAVE_CANCEL", entityType: "LeaveRequest", entityId: leave.id });
  if (leave.status === "APPROVED" && leave.approverId) {
    await notifyUsers([leave.approverId], { kind: "INFO", title: `${user.name} cancelled leave`, body: `${LEAVE_LABEL[leave.type as LeaveType]}, ${rangeText(leave)}.`, link: "/leave?tab=team", createdById: user.id });
  }
  res.json({ ok: true });
});

/**
 * Team view for approvers: requests from the people they verify (everyone for
 * admins), and who is off in the given range.
 */
leaveRouter.get("/leave/team", async (req, res) => {
  const user = currentUser(req);
  if (user.role === "EMPLOYEE") throw forbidden();
  const q = z.object({ from: z.string().regex(ISO_DATE).optional(), to: z.string().regex(ISO_DATE).optional() }).parse(req.query);
  const from = q.from ?? today();
  const to = q.to ?? addDays(from, 41);
  const ids = await teamMemberIds(user);
  const scope = ids === null ? { userId: { not: user.id } } : { userId: { in: ids } };
  const [pending, upcoming, recent] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { ...scope, status: "PENDING" }, include, orderBy: { startDate: "asc" } }),
    prisma.leaveRequest.findMany({ where: { ...scope, status: "APPROVED", startDate: { lte: to }, endDate: { gte: from } }, include, orderBy: { startDate: "asc" } }),
    prisma.leaveRequest.findMany({ where: { ...scope, status: { in: ["APPROVED", "REJECTED"] }, decidedAt: { not: null } }, include, orderBy: { decidedAt: "desc" }, take: 20 }),
  ]);
  const holidays = await holidaysBetween(from, to);
  res.json({ from, to, pending, upcoming, recent, holidays: [...holidays].map(([date, name]) => ({ date, name })) });
});

leaveRouter.post("/leave/:id/decide", async (req, res) => {
  const user = currentUser(req);
  const { decision, comment } = z
    .object({ decision: z.enum(["APPROVE", "REJECT"]), comment: z.string().trim().max(1000).optional() })
    .refine((v) => v.decision === "APPROVE" || !!v.comment, { message: "Say why the leave is declined." })
    .parse(req.body);
  const leave = await prisma.leaveRequest.findUnique({ where: { id: idParam(req.params.id, "Leave not found.") }, include });
  if (!leave || !(await canDecide(user, leave.userId))) throw notFound("Leave not found.");
  if (leave.status !== "PENDING") throw conflict("This request has already been decided.");
  const status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  // Time already logged on those days stays; the approver is told so.
  let note: string | null = null;
  if (status === "APPROVED" && !leave.halfDay) {
    const logged = await prisma.timesheetEntry.count({
      where: { userId: leave.userId, workDate: { gte: leave.startDate, lte: leave.endDate }, status: { not: "REJECTED" } },
    });
    if (logged) note = `${leave.user.name} has time logged on some of these days. It stays as it is.`;
  }
  const updated = await prisma.leaveRequest.update({
    where: { id: leave.id },
    data: { status, approverId: user.id, decidedAt: new Date(), decisionComment: comment ?? null },
    include,
  });
  await recordAudit({ actorId: user.id, action: `LEAVE_${decision}`, entityType: "LeaveRequest", entityId: leave.id, changes: { comment: comment ?? null } });
  await notifyUsers([leave.userId], {
    kind: "INFO",
    title: status === "APPROVED" ? "Leave approved" : "Leave declined",
    body: `${LEAVE_LABEL[leave.type as LeaveType]}, ${rangeText(leave)}: ${status === "APPROVED" ? "approved" : "declined"} by ${user.name}.${comment ? ` ${comment}` : ""}`,
    link: "/leave",
    createdById: user.id,
  });
  res.json({ leave: updated, note });
});

// ---- Holidays ------------------------------------------------------------------

leaveRouter.get("/holidays", async (req, res) => {
  const year = z.coerce.number().int().min(2000).max(2100).default(Number(today().slice(0, 4))).parse(req.query.year);
  const rows = await prisma.holiday.findMany({ where: { date: { gte: `${year}-01-01`, lte: `${year}-12-31` } }, orderBy: { date: "asc" } });
  res.json({ holidays: rows });
});

leaveRouter.post("/holidays", async (req, res) => {
  const user = currentUser(req);
  if (!can(user, "MANAGE_POLICY")) throw forbidden();
  const input = z.object({ date: z.string().regex(ISO_DATE).refine(isValidDate, "Invalid date."), name: z.string().trim().min(1).max(80) }).parse(req.body);
  if (await prisma.holiday.findUnique({ where: { date: input.date } })) throw conflict("There's already a holiday on that date.");
  const holiday = await prisma.holiday.create({ data: input });
  await recordAudit({ actorId: user.id, action: "HOLIDAY_ADD", entityType: "Holiday", entityId: holiday.id, changes: input });
  res.status(201).json({ holiday });
});

leaveRouter.delete("/holidays/:id", async (req, res) => {
  const user = currentUser(req);
  if (!can(user, "MANAGE_POLICY")) throw forbidden();
  const holiday = await prisma.holiday.findUnique({ where: { id: idParam(req.params.id, "Holiday not found.") } });
  if (!holiday) throw notFound("Holiday not found.");
  await prisma.holiday.delete({ where: { id: holiday.id } });
  await recordAudit({ actorId: user.id, action: "HOLIDAY_REMOVE", entityType: "Holiday", entityId: holiday.id, changes: { date: holiday.date, name: holiday.name } });
  res.json({ ok: true });
});
