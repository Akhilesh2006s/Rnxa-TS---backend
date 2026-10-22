// Timesheet business rules: entry validation, review flags and workflow
// transitions. Routes stay thin and call into here.
import type { Prisma, TimesheetEntry } from "@prisma/client";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { EDITABLE_STATUSES, TRANSITIONS, type EntryStatus, type WorkflowAction } from "../domain.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { recordAudit } from "./audit.js";
import { addDays, daysBetween, isValidDate, today, weekStart } from "./dates.js";
import { getPolicy, type Policy } from "./policy.js";
import { canLogOn, canReviewEntry } from "./scope.js";

export const MAX_DAY_MINUTES = 24 * 60;

export interface EntryInput {
  workDate: string;
  projectId: string;
  phaseId?: string | null;
  minutes: number;
  description: string;
  /** Optional time slot, "HH:MM". When present, minutes must match the slot. */
  startTime?: string | null;
  endTime?: string | null;
}

export const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Minutes for an entry: from its time slot when it has one, otherwise as given. */
export function slotMinutes(input: { minutes?: number; startTime?: string | null; endTime?: string | null }) {
  if (input.startTime && input.endTime) return toMinutes(input.endTime) - toMinutes(input.startTime);
  return input.minutes ?? 0;
}

export const entryInclude = {
  project: { select: { id: true, code: true, name: true } },
  phase: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true } },
  reviewer: { select: { id: true, name: true } },
  attachments: { select: { id: true, fileName: true, mimeType: true, kind: true, size: true, createdAt: true }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.TimesheetEntryInclude;

/**
 * Days that are verified and therefore locked: the day has time, every entry
 * on it is verified, and the day is either over or already has its full hours.
 * Nothing can be added to or moved onto a locked day; a verifier or admin can
 * reopen an entry if something must change.
 */
export async function lockedDays(userId: string, dates: string[], policy: Policy): Promise<Set<string>> {
  if (!dates.length) return new Set();
  const rows = await prisma.timesheetEntry.findMany({
    where: { userId, workDate: { in: dates }, status: { not: "REJECTED" } },
    select: { workDate: true, status: true, minutes: true },
  });
  const now = today();
  const locked = new Set<string>();
  for (const date of new Set(rows.map((r) => r.workDate))) {
    const day = rows.filter((r) => r.workDate === date);
    const allVerified = day.every((r) => r.status === "APPROVED");
    const full = day.reduce((s, r) => s + r.minutes, 0) >= policy.expectedDailyMinutes;
    if (allVerified && (date < now || full)) locked.add(date);
  }
  return locked;
}

/** Validates an entry for the given owner. Throws a 400/403 with a readable message. */
export async function validateEntry(ownerId: string, input: EntryInput, policy: Policy, ignoreEntryId?: string) {
  if (!isValidDate(input.workDate)) throw badRequest("Work date must be a valid date.");
  const now = today();
  const offset = daysBetween(now, input.workDate);
  // Drafts may be planned up to the end of the current week (e.g. "repeat last week");
  // only days up to today can be submitted.
  const latest = Math.max(policy.maxFutureDays, daysBetween(now, addDays(weekStart(now), 6)));
  if (offset > latest) throw badRequest("You can plan time up to the end of this week.");
  if (-offset > policy.maxPastDays) {
    throw badRequest(`Time can be logged up to ${policy.maxPastDays} days back. Ask an admin to log older time.`);
  }
  if (!!input.startTime !== !!input.endTime) throw badRequest("Give both a start and an end time, or neither.");
  if (input.startTime && input.endTime) {
    if (!TIME.test(input.startTime) || !TIME.test(input.endTime)) throw badRequest("Times must be HH:MM.");
    if (toMinutes(input.endTime) <= toMinutes(input.startTime)) throw badRequest("The end time must be after the start time.");
    if (input.minutes !== slotMinutes(input)) throw badRequest("Duration doesn't match the time slot.");
  }
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) throw badRequest("Duration must be greater than zero.");

  if ((await lockedDays(ownerId, [input.workDate], policy)).has(input.workDate)) {
    throw conflict("This day is verified and locked. Ask your verifier to reopen it if something needs to change.");
  }
  const onLeave = await prisma.leaveRequest.findFirst({
    where: { userId: ownerId, status: "APPROVED", halfDay: false, startDate: { lte: input.workDate }, endDate: { gte: input.workDate } },
    select: { id: true },
  });
  if (onLeave) throw conflict("You're on approved leave this day. Cancel the leave first if you worked.");
  if (!(await canLogOn(ownerId, input.projectId))) {
    throw forbidden("You are not assigned to this project.");
  }
  const project = await prisma.project.findUniqueOrThrow({ where: { id: input.projectId } });
  if (project.phasesEnabled) {
    if (!input.phaseId) throw badRequest("Select a phase for this project.");
    const phase = await prisma.phase.findFirst({
      where: { id: input.phaseId, projectId: project.id, active: true },
    });
    if (!phase) throw badRequest("That phase does not belong to the selected project.");
  } else if (input.phaseId) {
    throw badRequest("This project does not use phases.");
  }

  const sameDayEntries = await prisma.timesheetEntry.findMany({
    where: { userId: ownerId, workDate: input.workDate, status: { not: "REJECTED" }, id: ignoreEntryId ? { not: ignoreEntryId } : undefined },
    select: { minutes: true, startTime: true, endTime: true, project: { select: { code: true } } },
  });
  // Time slots on the same day can't overlap.
  if (input.startTime && input.endTime) {
    const s = toMinutes(input.startTime), e = toMinutes(input.endTime);
    const clash = sameDayEntries.find((o) => o.startTime && o.endTime && s < toMinutes(o.endTime) && toMinutes(o.startTime) < e);
    if (clash) throw badRequest(`That overlaps ${clash.startTime}–${clash.endTime} on ${clash.project.code}.`);
  }
  if (sameDayEntries.reduce((sum, o) => sum + o.minutes, 0) + input.minutes > MAX_DAY_MINUTES) {
    throw badRequest("Total time for one day cannot exceed 24 hours.");
  }
}

export type FlagCode = "DUPLICATE" | "LONG_DURATION" | "MISSING_DESCRIPTION";

/** Non-blocking warnings shown to the employee before submission. */
export function flagEntries(entries: TimesheetEntry[], policy: Policy): Record<string, FlagCode[]> {
  const flags: Record<string, FlagCode[]> = {};
  const seen = new Map<string, string>();
  for (const e of entries) {
    const list: FlagCode[] = [];
    if (e.status === "REJECTED") continue;
    if (!e.description.trim()) list.push("MISSING_DESCRIPTION");
    if (e.minutes >= policy.longEntryMinutes) list.push("LONG_DURATION");
    const key = [e.workDate, e.projectId, e.phaseId ?? "", e.minutes, e.description.trim().toLowerCase()].join("|");
    const twin = seen.get(key);
    if (twin) {
      list.push("DUPLICATE");
      flags[twin] = [...new Set([...(flags[twin] ?? []), "DUPLICATE" as FlagCode])];
    } else {
      seen.set(key, e.id);
    }
    if (list.length) flags[e.id] = [...new Set([...(flags[e.id] ?? []), ...list])];
  }
  return flags;
}

export async function loadOwnEntry(user: SessionUser, id: string) {
  const entry = await prisma.timesheetEntry.findUnique({ where: { id } });
  // Same response for "missing" and "someone else's" to avoid leaking ids.
  if (!entry || entry.userId !== user.id) throw notFound("Entry not found.");
  return entry;
}

export function assertEditable(entry: TimesheetEntry) {
  if (!EDITABLE_STATUSES.includes(entry.status as EntryStatus)) {
    throw conflict(
      entry.status === "SUBMITTED"
        ? "This entry has been submitted. Recall it before editing."
        : "This entry is locked and cannot be edited.",
    );
  }
}

/**
 * Applies one workflow transition atomically and records both the approval
 * action and an audit event. Authorisation is checked by the caller.
 */
async function transition(
  tx: Prisma.TransactionClient,
  actor: SessionUser,
  entry: TimesheetEntry,
  action: WorkflowAction,
  comment?: string,
) {
  const rule = TRANSITIONS[action];
  if (!(rule.from as readonly string[]).includes(entry.status)) {
    throw conflict(`Cannot ${action.toLowerCase().replace("_", " ")} an entry that is ${entry.status.toLowerCase().replace("_", " ")}.`);
  }
  const now = new Date();
  const isReview = action === "APPROVE" || action === "REQUEST_CHANGES" || action === "REJECT" || action === "REOPEN";
  // Guard against concurrent transitions with a status-conditional update.
  const result = await tx.timesheetEntry.updateMany({
    where: { id: entry.id, status: entry.status },
    data: {
      status: rule.to,
      ...(action === "SUBMIT" ? { submittedAt: now, reviewerComment: null } : {}),
      ...(action === "RECALL" ? { submittedAt: null } : {}),
      ...(isReview ? { reviewedById: actor.id, reviewedAt: now, reviewerComment: comment ?? null } : {}),
    },
  });
  if (result.count !== 1) throw conflict("This entry changed while you were working. Refresh and try again.");

  await tx.approvalAction.create({
    data: { entryId: entry.id, actorId: actor.id, action, fromStatus: entry.status, toStatus: rule.to, comment },
  });
  await recordAudit(
    {
      actorId: actor.id,
      action: `ENTRY_${action}`,
      entityType: "TimesheetEntry",
      entityId: entry.id,
      changes: { status: { from: entry.status, to: rule.to }, ...(comment ? { comment } : {}) },
    },
    tx,
  );
}

/**
 * Submits every draft / returned entry the user owns in the date range, up to
 * today. Routine entries are then verified automatically when the org's
 * auto-verify rules allow it; anything unusual waits for the verifier.
 */
export async function submitRange(user: SessionUser, from: string, to: string) {
  const policy = await getPolicy();
  const last = to < today() ? to : today();
  const entries = await prisma.timesheetEntry.findMany({
    where: { userId: user.id, workDate: { gte: from, lte: last }, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } },
  });
  if (!entries.length) throw badRequest("There's nothing to submit up to today.");
  const missing = entries.filter((e) => !e.description.trim());
  if (missing.length) {
    throw badRequest("Add a work description to every entry before submitting.", {
      entryIds: missing.map((e) => e.id),
    });
  }
  for (const e of entries) {
    // Re-validate: assignments or phases may have changed since the draft was saved.
    await validateEntry(user.id, { ...e, phaseId: e.phaseId }, { ...policy, maxPastDays: Number.MAX_SAFE_INTEGER }, e.id);
  }
  await prisma.$transaction(async (tx) => {
    for (const e of entries) await transition(tx, user, e, "SUBMIT");
  });
  const autoVerified = policy.autoVerify ? await autoVerify(user, entries, policy) : 0;
  return { submitted: entries.length, autoVerified };
}

/**
 * Auto-verify rules: a first-time submission (not a correction) with a
 * description, no review flags (duplicate, unusually long), on a day whose
 * total stays within the policy limit, and not older than 14 days.
 */
async function autoVerify(user: SessionUser, submitted: TimesheetEntry[], policy: Policy) {
  const dates = [...new Set(submitted.map((e) => e.workDate))];
  const sameDays = await prisma.timesheetEntry.findMany({ where: { userId: user.id, workDate: { in: dates }, status: { not: "REJECTED" } } });
  const flags = flagEntries(sameDays, policy);
  const dayTotal = (d: string) => sameDays.filter((e) => e.workDate === d).reduce((s, e) => s + e.minutes, 0);
  const oldest = addDays(today(), -14);
  const eligible = submitted.filter(
    (e) =>
      e.status === "DRAFT" &&
      e.description.trim() &&
      !(flags[e.id]?.length) &&
      e.workDate >= oldest &&
      dayTotal(e.workDate) <= policy.autoVerifyMaxDailyMinutes,
  );
  if (!eligible.length) return 0;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const e of eligible) {
      const r = await tx.timesheetEntry.updateMany({
        where: { id: e.id, status: "SUBMITTED" },
        data: { status: "APPROVED", autoVerified: true, reviewedAt: now, reviewedById: null, reviewerComment: null },
      });
      if (r.count !== 1) continue;
      await tx.approvalAction.create({
        data: { entryId: e.id, actorId: user.id, action: "AUTO_VERIFY", fromStatus: "SUBMITTED", toStatus: "APPROVED", comment: "Matched auto-verify rules" },
      });
      await recordAudit({ actorId: null, action: "ENTRY_AUTO_VERIFY", entityType: "TimesheetEntry", entityId: e.id }, tx);
    }
  });
  return eligible.length;
}

export async function recallEntry(user: SessionUser, id: string) {
  const entry = await loadOwnEntry(user, id);
  await prisma.$transaction((tx) => transition(tx, user, entry, "RECALL"));
}

export type ReviewAction = "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "REOPEN";

/** Reviews a batch of entries. All entries must be in the reviewer's scope. */
export async function reviewEntries(user: SessionUser, ids: string[], action: ReviewAction, comment?: string) {
  const trimmed = comment?.trim() || undefined;
  if (action !== "APPROVE" && !trimmed) {
    throw badRequest(
      action === "REJECT" ? "A reason is required to reject." : action === "REOPEN" ? "A reason is required to reopen an approved entry." : "Add a comment explaining what needs to change.",
    );
  }
  const entries = await prisma.timesheetEntry.findMany({ where: { id: { in: ids } } });
  if (entries.length !== new Set(ids).size) throw notFound("One or more entries were not found.");
  for (const e of entries) {
    if (!(await canReviewEntry(user, e))) throw forbidden("One or more entries are outside your review scope.");
  }
  await prisma.$transaction(async (tx) => {
    for (const e of entries) await transition(tx, user, e, action, trimmed);
  });
  return entries.length;
}
