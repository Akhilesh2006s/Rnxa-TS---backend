// Team performance report and CSV exports, scoped like every other report:
// managers see the people they verify, admins everyone who logs time.
import type { Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { STATUSES, objectId } from "../domain.js";
import { badRequest, forbidden } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { LEAVE_LABEL, type LeaveType } from "../services/calendar.js";
import { ISO_DATE, daysBetween } from "../services/dates.js";
import { teamPerformance } from "../services/performance.js";
import { teamMemberIds } from "../services/scope.js";
import { reportScope } from "../services/summaries.js";

export const reportsRouter = Router();

const rangeSchema = z
  .object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE), userId: objectId.optional() })
  .refine((q) => q.to >= q.from, { message: "The end date must be on or after the start date." });

function parseRange(query: unknown) {
  const q = rangeSchema.parse(query);
  if (daysBetween(q.from, q.to) > 366) throw badRequest("Reports cover up to one year at a time.");
  return q;
}

reportsRouter.get("/reports/team", async (req, res) => {
  const user = currentUser(req);
  if (user.role === "EMPLOYEE") throw forbidden();
  const q = parseRange(req.query);
  res.json(await teamPerformance(user, q.from, q.to, q.userId));
});

// ---- CSV -----------------------------------------------------------------------

/** One CSV cell. Cells that a spreadsheet would run as a formula are prefixed with a quote. */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res: Response, fileName: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${fileName}"`,
  });
  // The byte-order mark makes Excel read the file as UTF-8.
  res.send(`﻿${body}\r\n`);
}

const h = (m: number) => Math.round((m / 60) * 100) / 100;
const percent = (n: number | null) => (n === null ? "" : Math.round(n * 100));
const RATING_LABEL = { STRONG: "Strong", ON_TRACK: "On track", NEEDS_ATTENTION: "Needs attention", NO_DATA: "No data" } as const;

reportsRouter.get("/reports/team.csv", async (req, res) => {
  const user = currentUser(req);
  if (user.role === "EMPLOYEE") throw forbidden();
  const q = parseRange(req.query);
  const report = await teamPerformance(user, q.from, q.to, q.userId);
  await recordAudit({ actorId: user.id, action: "REPORT_EXPORT", entityType: "Report", entityId: "team", changes: { from: q.from, to: q.to, rows: report.people.length } });
  sendCsv(
    res,
    `rnxa-team-performance_${q.from}_to_${q.to}.csv`,
    [
      "Person", "Email", "Role", "Verified by", "Rating", "Score",
      "Expected hours", "Logged hours", "Hours vs expected %", "Verified hours", "Waiting hours", "Draft hours",
      "Days with no time", "Short days", "Leave days",
      "Entries", "Submitted", "On time", "Late", "Overdue drafts", "Avg days to submit", "On time %",
      "Sent back", "Rejected", "Clean entries %", "Top project", "Reasons",
    ],
    report.people.map((p) => [
      p.user.name, p.user.email, p.user.role, p.verifier?.name ?? "Any admin", RATING_LABEL[p.rating], p.score ?? "",
      h(p.expectedMinutes), h(p.loggedMinutes), percent(p.utilization), h(p.verifiedMinutes), h(p.waitingMinutes), h(p.draftMinutes),
      p.emptyDays, p.shortDays, p.leaveDays,
      p.entries, p.submitted, p.onTime, p.late, p.overdueDrafts, p.avgSubmitDelayDays ?? "", percent(p.timeliness),
      p.sentBack, p.rejected, percent(p.quality), p.byProject[0]?.label ?? "", p.reasons.join("; "),
    ]),
  );
});

/** Every entry in the range (with the usual report filters), one row each. */
reportsRouter.get("/reports/entries.csv", async (req, res) => {
  const user = currentUser(req);
  const q = rangeSchema
    .and(z.object({ projectId: objectId.optional(), phaseId: objectId.optional(), status: z.enum(STATUSES).optional() }))
    .parse(req.query);
  if (daysBetween(q.from, q.to) > 366) throw badRequest("Reports cover up to one year at a time.");
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      AND: [
        await reportScope(user),
        { workDate: { gte: q.from, lte: q.to } },
        q.userId ? { userId: q.userId } : {},
        q.projectId ? { projectId: q.projectId } : {},
        q.phaseId ? { phaseId: q.phaseId } : {},
        q.status ? { status: q.status } : {},
      ],
    },
    include: {
      user: { select: { name: true, email: true } },
      project: { select: { code: true, name: true } },
      phase: { select: { name: true } },
      reviewer: { select: { name: true } },
      _count: { select: { attachments: true } },
    },
    orderBy: [{ workDate: "asc" }, { startTime: "asc" }],
    take: 20000,
  });
  await recordAudit({ actorId: user.id, action: "REPORT_EXPORT", entityType: "Report", entityId: "entries", changes: { from: q.from, to: q.to, rows: entries.length } });
  sendCsv(
    res,
    `rnxa-timesheet-entries_${q.from}_to_${q.to}.csv`,
    ["Date", "Person", "Email", "Project", "Project name", "Phase", "From", "To", "Hours", "Status", "Verified by", "Verified automatically", "Submitted at", "Files", "Description"],
    entries.map((e) => [
      e.workDate, e.user.name, e.user.email, e.project.code, e.project.name, e.phase?.name ?? "", e.startTime ?? "", e.endTime ?? "",
      h(e.minutes), e.status, e.status === "APPROVED" ? (e.autoVerified ? "" : (e.reviewer?.name ?? "")) : "", e.autoVerified ? "Yes" : "",
      e.submittedAt?.toISOString() ?? "", e._count.attachments, e.description,
    ]),
  );
});

/** Approved and pending leave in the range, for people in scope. */
reportsRouter.get("/reports/leave.csv", async (req, res) => {
  const user = currentUser(req);
  const q = parseRange(req.query);
  const team = user.role === "EMPLOYEE" ? [] : await teamMemberIds(user);
  const people = team === null ? null : [...team, user.id];
  const leave = await prisma.leaveRequest.findMany({
    where: {
      AND: [
        people === null ? {} : { userId: { in: people } },
        q.userId ? { userId: q.userId } : {},
        { startDate: { lte: q.to }, endDate: { gte: q.from }, status: { in: ["APPROVED", "PENDING"] } },
      ],
    },
    include: { user: { select: { name: true, email: true } }, approver: { select: { name: true } } },
    orderBy: { startDate: "asc" },
  });
  sendCsv(
    res,
    `rnxa-leave_${q.from}_to_${q.to}.csv`,
    ["Person", "Email", "Type", "From", "To", "Half day", "Working days", "Status", "Decided by", "Reason"],
    leave.map((l) => [l.user.name, l.user.email, LEAVE_LABEL[l.type as LeaveType], l.startDate, l.endDate, l.halfDay ? "Yes" : "", l.days, l.status, l.approver?.name ?? "", l.reason]),
  );
});
