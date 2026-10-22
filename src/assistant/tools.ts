// Tools the AI assistant can use. Every tool runs as the signed-in user and
// goes through the same services and scope checks as the regular API.
//
// - "read" tools run immediately and return live data.
// - "write" tools never run on the model's say-so: `prepare` validates and
//   describes the change, the user approves it in the UI, then `execute` runs.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { ASSIGNMENT_ROLES, ROLES, STATUSES, objectId, type Permission, type Role } from "../domain.js";
import { can } from "../services/permissions.js";
import { HttpError, badRequest, forbidden, notFound } from "../errors.js";
import { addPhase, assignUser, createProject, createUser, updateUser } from "../services/admin.js";
import { recordAudit } from "../services/audit.js";
import { ISO_DATE, addDays, isValidDate, today, weekStart } from "../services/dates.js";
import { notifyUsers } from "../services/notifications.js";
import { resolveAudience, sendAlert, type Audience } from "../services/alerts.js";
import { LEAVE_LABEL, LEAVE_TYPES, type LeaveType } from "../services/calendar.js";
import { checkLeave, createLeave, leaveBalances, rangeText } from "../services/leave.js";
import { teamPerformance } from "../services/performance.js";
import { getPolicy } from "../services/policy.js";
import { canReviewEntry, loggableProjects, reviewScopeWhere } from "../services/scope.js";
import { hoursReport, teamStatus, weekSummary } from "../services/summaries.js";
import { reviewEntries, slotMinutes, submitRange, validateEntry } from "../services/timesheet.js";

/** Things a tool asks the user's screen to do, delivered alongside the reply. */
export type Effect =
  | { type: "navigate"; path: string; label: string }
  | { type: "impersonate"; userId: string; name: string }
  | { type: "stop_impersonation" };

export interface ToolContext {
  user: SessionUser;
  effect: (e: Effect) => void;
}

export interface WriteOutcome {
  /** Short confirmation shown on the action card and sent back to the model. */
  message: string;
  /** Values shown to the user once and never stored or sent to the model (e.g. temporary passwords). */
  secrets?: { label: string; value: string }[];
}

interface Base {
  name: string;
  description: string;
  roles: readonly Role[];
  /** When set, the tool is offered to anyone with this permission (instead of by role). */
  permission?: Permission;
  schema: z.ZodTypeAny;
  inputSchema: Record<string, unknown>;
}
export interface ReadTool extends Base {
  kind: "read";
  run(ctx: ToolContext, input: any): Promise<unknown>;
}
export interface WriteTool extends Base {
  kind: "write";
  prepare(ctx: ToolContext, input: any): Promise<{ summary: string; details?: string[] }>;
  execute(ctx: ToolContext, input: any): Promise<WriteOutcome>;
}
export type Tool = ReadTool | WriteTool;

const ALL: readonly Role[] = ["ADMIN", "MANAGER", "EMPLOYEE"];
const REVIEWERS: readonly Role[] = ["ADMIN", "MANAGER"];
const ADMIN: readonly Role[] = ["ADMIN"];

const hours = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
const date = z.string().regex(ISO_DATE, "Use YYYY-MM-DD.").refine(isValidDate, "Not a real date.");
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

// ---- Lookups ---------------------------------------------------------------------

async function projectByCode(code: string) {
  const project = await prisma.project.findUnique({ where: { code: code.trim().toUpperCase() }, include: { phases: true } });
  if (!project) throw notFound(`No project with code ${code.toUpperCase()}. Use list_projects or list_my_projects to see codes.`);
  return project;
}

async function userByEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw notFound(`No user with email ${email}.`);
  return user;
}

/** Users a reviewer may contact: members of their reviewable projects (everyone for admins). */
async function assertInTeam(ctx: ToolContext, userIds: string[]) {
  if (ctx.user.role === "ADMIN") return;
  const team = await teamStatus(ctx.user, today());
  const allowed = new Set(team.people.map((p) => p.user.id));
  if (userIds.some((id) => !allowed.has(id))) throw forbidden("Some of those people are not in your team.");
}

// ---- Read tools ------------------------------------------------------------------

const listMyProjects: ReadTool = {
  kind: "read",
  name: "list_my_projects",
  description: "Projects and phases the current user can log time on. Call before log_time if you are unsure of the project code or phase name.",
  roles: ALL,
  schema: z.object({}),
  inputSchema: obj({}),
  async run(ctx) {
    const projects = await loggableProjects(ctx.user.id);
    return projects.map((p) => ({ code: p.code, name: p.name, client: p.client, phasesRequired: p.phasesEnabled, phases: p.phases.map((ph) => ph.name) }));
  },
};

const getMyWeek: ReadTool = {
  kind: "read",
  name: "get_my_week",
  description: "The current user's own timesheet for one week: entries, daily totals vs expected hours, totals by project/phase, statuses and review flags.",
  roles: ALL,
  schema: z.object({ date: date.optional() }),
  inputSchema: obj({ date: str("Any date in the week (YYYY-MM-DD). Defaults to this week.") }),
  async run(ctx, input: { date?: string }) {
    const w = await weekSummary(ctx.user.id, input.date ?? today());
    return {
      weekStart: w.start,
      totalHours: hours(w.totalMinutes),
      expectedHours: hours(w.expectedMinutes),
      days: w.days.map((d) => ({ date: d.date, hours: hours(d.minutes), expectedHours: hours(d.expectedMinutes), belowExpected: d.missing })),
      byProjectPhase: w.byProjectPhase.map((r) => ({ project: r.project, phase: r.phase, hours: hours(r.minutes) })),
      statusCounts: w.statusCounts,
      entries: w.entries.map((e) => ({
        id: e.id,
        date: e.workDate,
        project: e.project.code,
        phase: e.phase?.name ?? null,
        hours: hours(e.minutes),
        time: e.startTime ? `${e.startTime}–${e.endTime}` : null,
        status: e.status,
        description: e.description.slice(0, 200),
        reviewerComment: e.reviewerComment,
        flags: w.flags[e.id] ?? [],
      })),
    };
  },
};

const hoursReportTool: ReadTool = {
  kind: "read",
  name: "hours_report",
  description:
    "Live hours analysis grouped by employee, project, phase, date or status for a date range. Scoped automatically: employees see their own time, managers their projects, admins everything. Excludes rejected time unless status is given.",
  roles: ALL,
  schema: z.object({
    from: date,
    to: date,
    group_by: z.enum(["employee", "project", "phase", "date", "status"]),
    project_code: z.string().max(20).optional(),
    employee_email: z.string().email().optional(),
    status: z.enum(STATUSES).optional(),
  }),
  inputSchema: obj(
    {
      from: str("Start date YYYY-MM-DD"),
      to: str("End date YYYY-MM-DD"),
      group_by: { type: "string", enum: ["employee", "project", "phase", "date", "status"] },
      project_code: str("Optional project code filter"),
      employee_email: str("Optional employee email filter"),
      status: { type: "string", enum: [...STATUSES] },
    },
    ["from", "to", "group_by"],
  ),
  async run(ctx, input) {
    if (input.from > input.to) throw badRequest("from must be on or before to.");
    const project = input.project_code ? await projectByCode(input.project_code) : null;
    const employee = input.employee_email ? await userByEmail(input.employee_email) : null;
    const r = await hoursReport(ctx.user, {
      from: input.from,
      to: input.to,
      groupBy: input.group_by,
      projectId: project?.id,
      userId: employee?.id,
      status: input.status,
    });
    return { totalHours: hours(r.totalMinutes), entryCount: r.entryCount, rows: r.rows.map((row) => ({ label: row.label, hours: hours(row.minutes) })) };
  },
};

const teamStatusTool: ReadTool = {
  kind: "read",
  name: "team_status",
  description:
    "Per-person time for one week across the people you verify (everyone, for admins): logged, draft, submitted and verified hours vs expected. Use it to find who has missing or unsubmitted time.",
  roles: REVIEWERS,
  schema: z.object({ date: date.optional() }),
  inputSchema: obj({ date: str("Any date in the week (YYYY-MM-DD). Defaults to this week.") }),
  async run(ctx, input: { date?: string }) {
    const t = await teamStatus(ctx.user, input.date ?? today());
    return {
      weekStart: t.weekStart,
      expectedWeekHours: hours(t.expectedWeekMinutes),
      expectedToDateHours: hours(t.expectedToDateMinutes),
      people: t.people.map((p) => ({
        name: p.user.name,
        email: p.user.email,
        loggedHours: hours(p.loggedMinutes),
        draftHours: hours(p.draftMinutes),
        submittedHours: hours(p.submittedMinutes),
        approvedHours: hours(p.approvedMinutes),
      })),
    };
  },
};

const pendingApprovals: ReadTool = {
  kind: "read",
  name: "pending_approvals",
  description: "Submitted entries waiting for you to verify (people you verify; everyone for admins), with ids to use with review_entries.",
  roles: REVIEWERS,
  schema: z.object({ employee_email: z.string().email().optional(), project_code: z.string().max(20).optional() }),
  inputSchema: obj({ employee_email: str("Optional employee email filter"), project_code: str("Optional project code filter") }),
  async run(ctx, input) {
    const employee = input.employee_email ? await userByEmail(input.employee_email) : null;
    const project = input.project_code ? await projectByCode(input.project_code) : null;
    const entries = await prisma.timesheetEntry.findMany({
      where: {
        AND: [
          await reviewScopeWhere(ctx.user),
          { status: "SUBMITTED", userId: { not: ctx.user.id } },
          employee ? { userId: employee.id } : {},
          project ? { projectId: project.id } : {},
        ],
      },
      include: { user: { select: { name: true, email: true } }, project: { select: { code: true } }, phase: { select: { name: true } } },
      orderBy: [{ submittedAt: "asc" }],
      take: 100,
    });
    return entries.map((e) => ({
      id: e.id,
      employee: e.user.name,
      email: e.user.email,
      date: e.workDate,
      project: e.project.code,
      phase: e.phase?.name ?? null,
      hours: hours(e.minutes),
      description: e.description.slice(0, 160),
    }));
  },
};

const listUsers: ReadTool = {
  kind: "read",
  name: "list_users",
  permission: "MANAGE_USERS",
  description: "All users with role, status, their verifier and the projects they can log time on.",
  roles: ADMIN,
  schema: z.object({}),
  inputSchema: obj({}),
  async run() {
    const users = await prisma.user.findMany({
      select: {
        name: true,
        email: true,
        role: true,
        active: true,
        verifier: { select: { name: true, email: true } },
        assignments: { where: { role: "MEMBER" }, select: { project: { select: { code: true } } } },
      },
      orderBy: { name: "asc" },
    });
    return users.map((u) => ({ ...u, verifier: u.verifier?.email ?? null, projects: u.assignments.map((a) => a.project.code), assignments: undefined }));
  },
};

const listProjects: ReadTool = {
  kind: "read",
  name: "list_projects",
  permission: "MANAGE_PROJECTS",
  description: "All projects with phases and assigned people.",
  roles: ADMIN,
  schema: z.object({}),
  inputSchema: obj({}),
  async run() {
    const projects = await prisma.project.findMany({
      include: { phases: true, assignments: { include: { user: { select: { email: true } } } } },
      orderBy: { code: "asc" },
    });
    return projects.map((p) => ({
      code: p.code,
      name: p.name,
      client: p.client,
      active: p.active,
      phasesRequired: p.phasesEnabled,
      phases: p.phases.filter((ph) => ph.active).map((ph) => ph.name),
      members: p.assignments.filter((a) => a.role === "MEMBER").map((a) => a.user.email),
    }));
  },
};

// ---- Write tools -----------------------------------------------------------------

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use HH:MM (24-hour).");
const logTimeSchema = z
  .object({
    date,
    project_code: z.string().min(1).max(20),
    phase: z.string().max(80).optional(),
    hours: z.number().positive().max(24).optional(),
    start_time: hhmm.optional(),
    end_time: hhmm.optional(),
    description: z.string().trim().min(1).max(4000),
  })
  .refine((v) => (v.start_time && v.end_time) || v.hours, "Give hours, or a start_time and end_time.");

async function resolveEntry(ctx: ToolContext, input: z.infer<typeof logTimeSchema>) {
  const project = await projectByCode(input.project_code);
  let phaseId: string | null = null;
  if (project.phasesEnabled) {
    if (!input.phase) throw badRequest(`${project.code} needs a phase. Options: ${project.phases.filter((p) => p.active).map((p) => p.name).join(", ")}.`);
    const phase = project.phases.find((p) => p.active && p.name.toLowerCase() === input.phase!.trim().toLowerCase());
    if (!phase) throw badRequest(`No phase "${input.phase}" on ${project.code}. Options: ${project.phases.filter((p) => p.active).map((p) => p.name).join(", ")}.`);
    phaseId = phase.id;
  }
  const startTime = input.start_time ?? null;
  const endTime = input.end_time ?? null;
  const minutes = startTime && endTime ? slotMinutes({ startTime, endTime }) : Math.round((input.hours ?? 0) * 60);
  const entry = { workDate: input.date, projectId: project.id, phaseId, minutes, startTime, endTime, description: input.description };
  await validateEntry(ctx.user.id, entry, await getPolicy());
  return { entry, project, phaseName: project.phases.find((p) => p.id === phaseId)?.name ?? null };
}

const logTime: WriteTool = {
  kind: "write",
  name: "log_time",
  description:
    "Log a draft time entry for the current user. Use hours for a total, or start_time/end_time (24-hour HH:MM) when the user gives times (\"9 to 11\", \"after lunch until 5\"). Log each time slot as its own entry. Write the description as a clear, professional sentence that keeps every fact the user gave; never add work, results or hours they did not mention.",
  roles: ALL,
  schema: logTimeSchema,
  inputSchema: obj(
    {
      date: str("Work date YYYY-MM-DD"),
      project_code: str("Project code, e.g. CPQ-ACME"),
      phase: str("Phase name, required when the project uses phases"),
      hours: { type: "number", description: "Duration in hours, e.g. 1.5 (omit when giving start/end times)" },
      start_time: str("Start time HH:MM, 24-hour"),
      end_time: str("End time HH:MM, 24-hour"),
      description: str("Professional work description"),
    },
    ["date", "project_code", "description"],
  ),
  async prepare(ctx, input) {
    const { project, phaseName, entry } = await resolveEntry(ctx, input);
    const when = entry.startTime ? `${entry.startTime}–${entry.endTime}` : `${hours(entry.minutes)}h`;
    return {
      summary: `Log ${when} on ${project.code}${phaseName ? ` · ${phaseName}` : ""} for ${input.date} as a draft`,
      details: [input.description],
    };
  },
  async execute(ctx, input) {
    const { entry: data } = await resolveEntry(ctx, input);
    const entry = await prisma.timesheetEntry.create({ data: { ...data, userId: ctx.user.id, status: "DRAFT" } });
    await recordAudit({ actorId: ctx.user.id, action: "ENTRY_CREATE", entityType: "TimesheetEntry", entityId: entry.id, changes: { via: "assistant" } });
    return { message: `Draft saved: ${data.startTime ? `${data.startTime}–${data.endTime}` : `${hours(data.minutes)}h`} on ${input.project_code.toUpperCase()} for ${input.date}.` };
  },
};

const submitWeek: WriteTool = {
  kind: "write",
  name: "submit_week",
  description: "Submit all of the current user's draft and returned entries in a week for approval.",
  roles: ALL,
  schema: z.object({ date }),
  inputSchema: obj({ date: str("Any date in the week to submit (YYYY-MM-DD)") }, ["date"]),
  async prepare(ctx, input) {
    const start = weekStart(input.date);
    const end = addDays(start, 6) < today() ? addDays(start, 6) : today();
    const drafts = await prisma.timesheetEntry.findMany({
      where: { userId: ctx.user.id, workDate: { gte: start, lte: end }, status: { in: ["DRAFT", "CHANGES_REQUESTED"] } },
    });
    if (!drafts.length) throw badRequest("There are no draft entries in that week.");
    const missing = drafts.filter((d) => !d.description.trim()).length;
    if (missing) throw badRequest(`${missing} draft entries have no description. Add descriptions before submitting.`);
    const total = drafts.reduce((s, d) => s + d.minutes, 0);
    return { summary: `Submit ${drafts.length} ${drafts.length === 1 ? "entry" : "entries"} (${hours(total)}h) for the week of ${start}` };
  },
  async execute(ctx, input) {
    const start = weekStart(input.date);
    const r = await submitRange(ctx.user, start, addDays(start, 6));
    const waiting = r.submitted - r.autoVerified;
    return {
      message: `Submitted ${r.submitted} ${r.submitted === 1 ? "entry" : "entries"}: ${r.autoVerified} verified automatically${waiting ? `, ${waiting} waiting for the verifier` : ""}.`,
    };
  },
};

const repeatSchema = z.object({ date: date.optional() });

async function repeatPlan(ctx: ToolContext, anyDate: string) {
  const start = weekStart(anyDate);
  const prev = addDays(start, -7);
  const [previous, current, policy] = await Promise.all([
    prisma.timesheetEntry.findMany({
      where: { userId: ctx.user.id, workDate: { gte: prev, lte: addDays(prev, 6) }, status: { not: "REJECTED" } },
      include: { project: { select: { code: true } }, phase: { select: { name: true } } },
    }),
    prisma.timesheetEntry.findMany({ where: { userId: ctx.user.id, workDate: { gte: start, lte: addDays(start, 6) } }, select: { workDate: true } }),
    getPolicy(),
  ]);
  const busy = new Set(current.map((c) => c.workDate));
  const plan = [];
  for (const e of previous) {
    const draft = { workDate: addDays(e.workDate, 7), projectId: e.projectId, phaseId: e.phaseId, minutes: e.minutes, startTime: e.startTime, endTime: e.endTime, description: e.description };
    if (busy.has(draft.workDate)) continue;
    try {
      await validateEntry(ctx.user.id, draft, policy);
      plan.push({ ...draft, label: `${draft.workDate} ${e.project.code}${e.phase ? ` · ${e.phase.name}` : ""} ${hours(e.minutes)}h` });
    } catch {
      // Skip entries that are no longer valid (e.g. project closed).
    }
  }
  return { start, plan };
}

const repeatLastWeek: WriteTool = {
  kind: "write",
  name: "repeat_last_week",
  description: "Copy the current user's entries from last week into the same days of this week as drafts (skipping days that already have time).",
  roles: ALL,
  schema: repeatSchema,
  inputSchema: obj({ date: str("Any date in the week to fill (defaults to this week)") }),
  async prepare(ctx, input: z.infer<typeof repeatSchema>) {
    const { start, plan } = await repeatPlan(ctx, input.date ?? today());
    if (!plan.length) throw badRequest("Nothing to copy: last week had no entries for days that are still empty.");
    const total = plan.reduce((s, p) => s + p.minutes, 0);
    return { summary: `Copy ${plan.length} ${plan.length === 1 ? "entry" : "entries"} (${hours(total)}h) from last week into the week of ${start}`, details: plan.map((p) => p.label) };
  },
  async execute(ctx, input: z.infer<typeof repeatSchema>) {
    const { plan } = await repeatPlan(ctx, input.date ?? today());
    for (const { label: _label, ...data } of plan) {
      const entry = await prisma.timesheetEntry.create({ data: { ...data, userId: ctx.user.id, status: "DRAFT" } });
      await recordAudit({ actorId: ctx.user.id, action: "ENTRY_CREATE", entityType: "TimesheetEntry", entityId: entry.id, changes: { via: "assistant-repeat-week" } });
    }
    return { message: `Added ${plan.length} draft ${plan.length === 1 ? "entry" : "entries"} from last week.` };
  },
};

const reviewSchema = z.object({
  entry_ids: z.array(objectId).min(1).max(200),
  action: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "REOPEN"]),
  comment: z.string().max(1000).optional(),
});

const reviewEntriesTool: WriteTool = {
  kind: "write",
  name: "review_entries",
  description:
    "Verify (APPROVE), request changes on, reject, or reopen entries by id (get ids from pending_approvals). Request changes, reject and reopen need a comment.",
  roles: REVIEWERS,
  schema: reviewSchema,
  inputSchema: obj(
    {
      entry_ids: { type: "array", items: { type: "string" } },
      action: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "REJECT", "REOPEN"] },
      comment: str("Required for REQUEST_CHANGES, REJECT and REOPEN"),
    },
    ["entry_ids", "action"],
  ),
  async prepare(ctx, input: z.infer<typeof reviewSchema>) {
    if (input.action !== "APPROVE" && !input.comment?.trim()) throw badRequest("A comment is required for this action.");
    const entries = await prisma.timesheetEntry.findMany({ where: { id: { in: input.entry_ids } }, include: { user: { select: { name: true } } } });
    if (entries.length !== new Set(input.entry_ids).size) throw notFound("Some entry ids were not found.");
    for (const e of entries) if (!(await canReviewEntry(ctx.user, e))) throw forbidden("Some entries are outside your review scope.");
    const people = [...new Set(entries.map((e) => e.user.name))].join(", ");
    const verb = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes on", REJECT: "Reject", REOPEN: "Reopen" }[input.action];
    return {
      summary: `${verb} ${entries.length} ${entries.length === 1 ? "entry" : "entries"} (${hours(entries.reduce((s, e) => s + e.minutes, 0))}h) from ${people}`,
      details: input.comment ? [`Comment: ${input.comment}`] : undefined,
    };
  },
  async execute(ctx, input: z.infer<typeof reviewSchema>) {
    const n = await reviewEntries(ctx.user, input.entry_ids, input.action, input.comment);
    return { message: `${input.action.replace("_", " ").toLowerCase()}: ${n} ${n === 1 ? "entry" : "entries"}.` };
  },
};

const reminderSchema = z.object({ employee_emails: z.array(z.string().email()).min(1).max(100), message: z.string().trim().min(1).max(500) });

const sendReminder: WriteTool = {
  kind: "write",
  name: "send_reminder",
  description:
    "Send an in-app reminder to people in your team, e.g. to log or submit missing time. Write a short, polite message that states what is missing.",
  roles: REVIEWERS,
  schema: reminderSchema,
  inputSchema: obj(
    { employee_emails: { type: "array", items: { type: "string" } }, message: str("Reminder text shown to each person") },
    ["employee_emails", "message"],
  ),
  async prepare(ctx, input: z.infer<typeof reminderSchema>) {
    const users = await Promise.all(input.employee_emails.map(userByEmail));
    await assertInTeam(ctx, users.map((u) => u.id));
    return { summary: `Send a reminder to ${users.map((u) => u.name).join(", ")}`, details: [input.message] };
  },
  async execute(ctx, input: z.infer<typeof reminderSchema>) {
    const users = await Promise.all(input.employee_emails.map(userByEmail));
    await assertInTeam(ctx, users.map((u) => u.id));
    const sent = await notifyUsers(
      users.map((u) => u.id),
      { kind: "REMINDER", title: `Reminder from ${ctx.user.name}`, body: input.message, link: "/timesheet", createdById: ctx.user.id },
    );
    await recordAudit({ actorId: ctx.user.id, action: "REMINDER_SEND", entityType: "Notification", entityId: ctx.user.id, changes: { recipients: input.employee_emails } });
    return { message: `Reminder sent to ${sent} ${sent === 1 ? "person" : "people"}.` };
  },
};

const createUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(ROLES),
  verifier_email: z.string().email().optional(),
});

const createUserTool: WriteTool = {
  kind: "write",
  name: "create_user",
  permission: "MANAGE_USERS",
  description:
    "Create a user account with a generated temporary password (shown only to the admin, never to you). Give employees a verifier (a manager or admin who verifies their time) when the user names one.",
  roles: ADMIN,
  schema: createUserSchema,
  inputSchema: obj(
    { name: str("Full name"), email: str("Work email"), role: { type: "string", enum: [...ROLES] }, verifier_email: str("Email of the manager/admin who verifies their time") },
    ["name", "email", "role"],
  ),
  async prepare(_ctx, input: z.infer<typeof createUserSchema>) {
    if (await prisma.user.findUnique({ where: { email: input.email } })) throw badRequest("A user with that email already exists.");
    const verifier = input.verifier_email ? await userByEmail(input.verifier_email) : null;
    if (verifier && verifier.role === "EMPLOYEE") throw badRequest(`${verifier.name} is an employee and can't verify time.`);
    return {
      summary: `Create ${input.role.toLowerCase()} account for ${input.name} (${input.email})`,
      details: verifier ? [`Time verified by ${verifier.name}`] : undefined,
    };
  },
  async execute(ctx, input: z.infer<typeof createUserSchema>) {
    const password = `Rnxa-${randomBytes(9).toString("base64url")}`;
    const verifier = input.verifier_email ? await userByEmail(input.verifier_email) : null;
    await createUser(ctx.user, { name: input.name, email: input.email, role: input.role, password, verifierId: verifier?.id ?? null });
    return {
      message: `Created ${input.name} (${input.email}) as ${input.role.toLowerCase()}. The temporary password was shown to the admin.`,
      secrets: [{ label: `Temporary password for ${input.email}`, value: password }],
    };
  },
};

const updateUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  verifier_email: z.string().email().optional(),
});

const updateUserTool: WriteTool = {
  kind: "write",
  name: "update_user",
  permission: "MANAGE_USERS",
  description: "Change a user's role, their verifier (who verifies their time), or activate/deactivate them.",
  roles: ADMIN,
  schema: updateUserSchema,
  inputSchema: obj(
    {
      email: str("User email"),
      role: { type: "string", enum: [...ROLES] },
      active: { type: "boolean" },
      verifier_email: str("Email of their new verifier (a manager or admin)"),
    },
    ["email"],
  ),
  async prepare(ctx, input: z.infer<typeof updateUserSchema>) {
    const u = await userByEmail(input.email);
    if (u.id === ctx.user.id && (input.active === false || (input.role && input.role !== "ADMIN"))) throw badRequest("You cannot deactivate or demote yourself.");
    const verifier = input.verifier_email ? await userByEmail(input.verifier_email) : null;
    if (verifier && verifier.role === "EMPLOYEE") throw badRequest(`${verifier.name} is an employee and can't verify time.`);
    const parts = [
      input.role ? `role → ${input.role.toLowerCase()}` : null,
      verifier ? `verified by ${verifier.name}` : null,
      input.active === undefined ? null : input.active ? "activate" : "deactivate",
    ].filter(Boolean);
    if (!parts.length) throw badRequest("Nothing to change.");
    return { summary: `Update ${u.name}: ${parts.join(", ")}` };
  },
  async execute(ctx, input: z.infer<typeof updateUserSchema>) {
    const u = await userByEmail(input.email);
    const verifier = input.verifier_email ? await userByEmail(input.verifier_email) : null;
    await updateUser(ctx.user, u.id, { role: input.role, active: input.active, verifierId: verifier?.id });
    return { message: `Updated ${u.name}.` };
  },
};

const createProjectSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(20).regex(/^[A-Z0-9-]+$/, "Use letters, numbers and dashes."),
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().max(120).optional(),
  phases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});

const createProjectTool: WriteTool = {
  kind: "write",
  name: "create_project",
  permission: "MANAGE_PROJECTS",
  description: "Create a project, optionally with phases. If phases is empty the project logs time without phases.",
  roles: ADMIN,
  schema: createProjectSchema,
  inputSchema: obj(
    {
      code: str("Short unique code, letters/numbers/dashes, e.g. CPQ-ACME"),
      name: str("Project name"),
      client: str("Client name, optional"),
      phases: { type: "array", items: { type: "string" }, description: "Phase names in order" },
    },
    ["code", "name"],
  ),
  async prepare(_ctx, input: z.infer<typeof createProjectSchema>) {
    if (await prisma.project.findUnique({ where: { code: input.code } })) throw badRequest(`Project ${input.code} already exists.`);
    return {
      summary: `Create project ${input.code} · ${input.name}${input.client ? ` for ${input.client}` : ""}`,
      details: [input.phases.length ? `Phases: ${input.phases.join(", ")}` : "No phases"],
    };
  },
  async execute(ctx, input: z.infer<typeof createProjectSchema>) {
    await createProject(ctx.user, { code: input.code, name: input.name, client: input.client ?? null, phasesEnabled: input.phases.length > 0, phases: input.phases });
    return { message: `Created project ${input.code}${input.phases.length ? ` with ${input.phases.length} phases` : ""}.` };
  },
};

const addPhasesSchema = z.object({ project_code: z.string().min(1).max(20), phases: z.array(z.string().trim().min(1).max(80)).min(1).max(20) });

const addPhasesTool: WriteTool = {
  kind: "write",
  name: "add_phases",
  permission: "MANAGE_PROJECTS",
  description: "Add phases to an existing project.",
  roles: ADMIN,
  schema: addPhasesSchema,
  inputSchema: obj({ project_code: str("Project code"), phases: { type: "array", items: { type: "string" } } }, ["project_code", "phases"]),
  async prepare(_ctx, input: z.infer<typeof addPhasesSchema>) {
    const project = await projectByCode(input.project_code);
    const existing = input.phases.filter((n) => project.phases.some((p) => p.name.toLowerCase() === n.toLowerCase()));
    if (existing.length) throw badRequest(`Already exists: ${existing.join(", ")}.`);
    return { summary: `Add phases to ${project.code}: ${input.phases.join(", ")}` };
  },
  async execute(ctx, input: z.infer<typeof addPhasesSchema>) {
    const project = await projectByCode(input.project_code);
    if (!project.phasesEnabled) await prisma.project.update({ where: { id: project.id }, data: { phasesEnabled: true } });
    for (const name of input.phases) await addPhase(ctx.user, project.id, name);
    return { message: `Added ${input.phases.length} phases to ${project.code}.` };
  },
};

const assignSchema = z.object({
  employee_email: z.string().email(),
  project_code: z.string().min(1).max(20),
});

const assignTool: WriteTool = {
  kind: "write",
  name: "assign_to_project",
  permission: "MANAGE_PROJECTS",
  description: "Add a person to a project so they can log time on it. (Who verifies their time is set per person with update_user.)",
  roles: ADMIN,
  schema: assignSchema,
  inputSchema: obj({ employee_email: str("Person's email"), project_code: str("Project code") }, ["employee_email", "project_code"]),
  async prepare(_ctx, input: z.infer<typeof assignSchema>) {
    const [u, p] = await Promise.all([userByEmail(input.employee_email), projectByCode(input.project_code)]);
    return { summary: `Add ${u.name} to ${p.code} · ${p.name}` };
  },
  async execute(ctx, input: z.infer<typeof assignSchema>) {
    const [u, p] = await Promise.all([userByEmail(input.employee_email), projectByCode(input.project_code)]);
    await assignUser(ctx.user, { userId: u.id, projectId: p.id, role: ASSIGNMENT_ROLES[0] });
    return { message: `${u.name} can now log time on ${p.code}.` };
  },
};

// ---- Performance, alerts and leave ---------------------------------------------------

const performanceSchema = z.object({ from: date.optional(), to: date.optional(), employee_email: z.string().email().optional() });

const teamPerformanceTool: ReadTool = {
  kind: "read",
  name: "team_performance",
  description:
    "Timesheet performance for the people you verify (everyone, for admins) over a period: a 0-100 score and rating (Strong, On track, Needs attention), hours vs expected after leave and holidays, days with no time, on-time submission, entries sent back, and the reasons behind a low score. Use it when asked who is performing poorly, who needs attention, or for a team review. It measures timesheet discipline, not the quality of anyone's work: say so if asked to judge people.",
  roles: REVIEWERS,
  schema: performanceSchema,
  inputSchema: obj({
    from: str("Start date YYYY-MM-DD. Defaults to 30 days ago."),
    to: str("End date YYYY-MM-DD. Defaults to today."),
    employee_email: str("Only this person"),
  }),
  async run(ctx, input: z.infer<typeof performanceSchema>) {
    const to = input.to ?? today();
    const from = input.from ?? addDays(to, -29);
    const only = input.employee_email ? (await userByEmail(input.employee_email)).id : undefined;
    const r = await teamPerformance(ctx.user, from, to, only);
    const pct = (n: number | null) => (n === null ? null : Math.round(n * 100));
    return {
      from: r.from,
      countedTo: r.countedTo,
      summary: { ...r.summary, expectedHours: hours(r.summary.expectedMinutes), loggedHours: hours(r.summary.loggedMinutes), verifiedHours: hours(r.summary.verifiedMinutes) },
      people: r.people.map((p) => ({
        name: p.user.name,
        email: p.user.email,
        rating: p.rating,
        score: p.score,
        loggedHours: hours(p.loggedMinutes),
        expectedHours: hours(p.expectedMinutes),
        hoursVsExpectedPct: pct(p.utilization),
        daysWithNoTime: p.emptyDays,
        onTimePct: pct(p.timeliness),
        sentBack: p.sentBack + p.rejected,
        leaveDays: p.leaveDays,
        reasons: p.reasons,
      })),
    };
  },
};

const alertToolSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(2000),
  urgent: z.boolean().default(false),
  audience: z.enum(["my_team", "everyone", "all_managers", "all_employees", "people"]),
  employee_emails: z.array(z.string().email()).max(200).optional(),
});

async function toAudience(input: z.infer<typeof alertToolSchema>): Promise<Audience> {
  switch (input.audience) {
    case "my_team":
      return { type: "team" };
    case "everyone":
      return { type: "everyone" };
    case "all_managers":
      return { type: "role", role: "MANAGER" };
    case "all_employees":
      return { type: "role", role: "EMPLOYEE" };
    case "people": {
      if (!input.employee_emails?.length) throw badRequest("Name the people to alert (employee_emails).");
      const users = await Promise.all(input.employee_emails.map(userByEmail));
      return { type: "people", userIds: users.map((u) => u.id) };
    }
  }
}

const sendAlertTool: WriteTool = {
  kind: "write",
  name: "send_alert",
  description:
    "Send an alert down the hierarchy: managers to the people they verify; admins and the super admin to everyone, all managers, all employees, or chosen people. Urgent alerts stay on the recipient's screen until they acknowledge them. Use for announcements, deadlines, or telling someone their timesheet needs attention. Write a clear, respectful message.",
  roles: REVIEWERS,
  schema: alertToolSchema,
  inputSchema: obj(
    {
      title: str("Short headline"),
      message: str("The message"),
      urgent: { type: "boolean", description: "Pin it on their screen until acknowledged" },
      audience: { type: "string", enum: ["my_team", "everyone", "all_managers", "all_employees", "people"] },
      employee_emails: { type: "array", items: { type: "string" }, description: "audience=people: who to alert" },
    },
    ["title", "message", "audience"],
  ),
  async prepare(ctx, input: z.infer<typeof alertToolSchema>) {
    const { recipients, label } = await resolveAudience(ctx.user, await toAudience(input));
    if (!recipients.length) throw badRequest("Nobody matches that audience.");
    return {
      summary: `Send ${input.urgent ? "an urgent" : "an"} alert to ${label} (${recipients.length} ${recipients.length === 1 ? "person" : "people"})`,
      details: [input.title, input.message],
    };
  },
  async execute(ctx, input: z.infer<typeof alertToolSchema>) {
    const alert = await sendAlert(ctx.user, { title: input.title, body: input.message, priority: input.urgent ? "URGENT" : "NORMAL", audience: await toAudience(input) });
    return { message: `Alert sent to ${alert.recipientCount} ${alert.recipientCount === 1 ? "person" : "people"}.` };
  },
};

const leaveOverview: ReadTool = {
  kind: "read",
  name: "leave_overview",
  description:
    "Leave: your balances (casual, sick, earned left this year), your requests, and, for managers and admins, team leave requests waiting for approval and who is off in the next six weeks.",
  roles: ALL,
  schema: z.object({}),
  inputSchema: obj({}),
  async run(ctx) {
    const year = Number(today().slice(0, 4));
    const mine = await prisma.leaveRequest.findMany({ where: { userId: ctx.user.id, status: { in: ["PENDING", "APPROVED"] }, endDate: { gte: `${year}-01-01` } }, orderBy: { startDate: "asc" } });
    const result: Record<string, unknown> = {
      balances: (await leaveBalances(ctx.user.id, year)).map((b) => ({ type: b.label, remainingDays: b.remaining, usedDays: b.used, pendingDays: b.pending })),
      myLeave: mine.map((l) => ({ type: LEAVE_LABEL[l.type as LeaveType], when: rangeText(l), days: l.days, status: l.status })),
    };
    if (ctx.user.role !== "EMPLOYEE") {
      const team = await teamStatus(ctx.user, today());
      const ids = team.people.map((p) => p.user.id);
      const [pending, off] = await Promise.all([
        prisma.leaveRequest.findMany({ where: { userId: { in: ids }, status: "PENDING" }, include: { user: { select: { name: true } } }, orderBy: { startDate: "asc" } }),
        prisma.leaveRequest.findMany({
          where: { userId: { in: ids }, status: "APPROVED", endDate: { gte: today() }, startDate: { lte: addDays(today(), 42) } },
          include: { user: { select: { name: true } } },
          orderBy: { startDate: "asc" },
        }),
      ]);
      result.waitingForApproval = pending.map((l) => ({ name: l.user.name, type: LEAVE_LABEL[l.type as LeaveType], when: rangeText(l), days: l.days, reason: l.reason }));
      result.teamOffSoon = off.map((l) => ({ name: l.user.name, type: LEAVE_LABEL[l.type as LeaveType], when: rangeText(l) }));
    }
    return result;
  },
};

const requestLeaveSchema = z.object({
  type: z.enum(LEAVE_TYPES),
  start_date: date,
  end_date: date,
  half_day: z.boolean().default(false),
  reason: z.string().trim().max(1000).default(""),
});

const toLeaveInput = (i: z.infer<typeof requestLeaveSchema>) => ({ type: i.type, startDate: i.start_date, endDate: i.half_day ? i.start_date : i.end_date, halfDay: i.half_day, reason: i.reason });

const requestLeaveTool: WriteTool = {
  kind: "write",
  name: "request_leave",
  description: "Request leave for the user. Their verifier (or an admin) approves it. Weekends and holidays don't count against the balance.",
  roles: ALL,
  schema: requestLeaveSchema,
  inputSchema: obj(
    {
      type: { type: "string", enum: [...LEAVE_TYPES] },
      start_date: str("First day YYYY-MM-DD"),
      end_date: str("Last day YYYY-MM-DD (same as start for one day)"),
      half_day: { type: "boolean" },
      reason: str("Optional reason shown to the approver"),
    },
    ["type", "start_date", "end_date"],
  ),
  async prepare(ctx, input: z.infer<typeof requestLeaveSchema>) {
    const leave = toLeaveInput(input);
    const days = await checkLeave(ctx.user, leave);
    return { summary: `Request ${LEAVE_LABEL[input.type].toLowerCase()}, ${rangeText(leave)} (${days} ${days === 1 ? "day" : "days"})`, details: input.reason ? [input.reason] : undefined };
  },
  async execute(ctx, input: z.infer<typeof requestLeaveSchema>) {
    const leave = await createLeave(ctx.user, toLeaveInput(input));
    ctx.effect({ type: "navigate", path: "/leave", label: "leave" });
    return { message: `Leave requested (${leave.days} ${leave.days === 1 ? "day" : "days"}). Your approver has been notified.` };
  },
};

// ---- Screen tools -------------------------------------------------------------------

const PAGES = ["home", "timesheet", "my_reports", "approvals", "reports", "team_performance", "leave", "alerts", "users", "projects", "policy", "audit"] as const;

const openPageSchema = z.object({
  page: z.enum(PAGES),
  date: date.optional(),
  from: date.optional(),
  to: date.optional(),
  group_by: z.enum(["employee", "project", "phase", "date", "status"]).optional(),
  status: z.enum(STATUSES).optional(),
  employee_email: z.string().email().optional(),
  project_code: z.string().max(20).optional(),
});

const openPage: ReadTool = {
  kind: "read",
  name: "open_page",
  description:
    "Show a page on the user's screen, with filters applied, so they can see what you are talking about. Use it whenever you discuss data that has a screen: their week (timesheet), their own report of work done and project status (my_reports), the verify-time queue (approvals), the hours report (reports), the team performance scorecard (team_performance), leave, alerts, users, projects, policy or the audit log. The user watches the page change while you talk.",
  roles: ALL,
  schema: openPageSchema,
  inputSchema: obj(
    {
      page: { type: "string", enum: [...PAGES] },
      date: str("timesheet: any date in the week to show"),
      from: str("reports: start date YYYY-MM-DD"),
      to: str("reports: end date YYYY-MM-DD"),
      group_by: { type: "string", enum: ["employee", "project", "phase", "date", "status"], description: "reports: grouping" },
      status: { type: "string", enum: [...STATUSES], description: "approvals or reports: status filter" },
      employee_email: str("approvals or reports: filter to one person"),
      project_code: str("approvals, reports or projects: filter to one project"),
    },
    ["page"],
  ),
  async run(ctx, input: z.infer<typeof openPageSchema>) {
    const role = ctx.user.role;
    if (["approvals", "reports", "team_performance", "alerts"].includes(input.page) && role === "EMPLOYEE") throw forbidden("That page is for managers and admins.");
    if (["users", "projects", "policy", "audit"].includes(input.page) && role !== "ADMIN") throw forbidden("That page is for admins.");
    const project = input.project_code ? await projectByCode(input.project_code) : null;
    const employee = input.employee_email ? await userByEmail(input.employee_email) : null;
    const q = new URLSearchParams();
    const set = (k: string, v?: string | null) => v && q.set(k, v);
    let path = "/";
    switch (input.page) {
      case "timesheet":
        // The one-page week view: employees' home, "My week" for everyone else.
        path = role === "EMPLOYEE" ? "/" : "/week";
        set("week", input.date && weekStart(input.date) !== weekStart(today()) ? weekStart(input.date) : undefined);
        break;
      case "my_reports":
        // The person's own report: work done, project status, verification.
        path = "/my-reports";
        set("from", input.from);
        set("to", input.to);
        break;
      case "approvals":
        path = "/reviews";
        set("status", input.status ?? "SUBMITTED");
        set("userId", employee?.id);
        set("projectId", project?.id);
        break;
      case "team_performance":
        path = "/reports";
        set("view", "performance");
        set("from", input.from);
        set("to", input.to);
        break;
      case "leave":
        path = "/leave";
        set("tab", role === "EMPLOYEE" ? undefined : "team");
        break;
      case "alerts":
        path = "/alerts";
        break;
      case "reports":
        path = "/reports";
        set("view", "hours");
        set("from", input.from);
        set("to", input.to);
        set("groupBy", input.group_by);
        set("status", input.status);
        set("userId", role === "EMPLOYEE" ? undefined : employee?.id);
        set("projectId", project?.id);
        break;
      case "users":
      case "policy":
      case "audit":
        path = `/admin/${input.page}`;
        break;
      case "projects":
        path = "/admin/projects";
        set("project", project?.id);
        break;
    }
    const full = q.size ? `${path}?${q}` : path;
    ctx.effect({ type: "navigate", path: full, label: input.page });
    return { shown: input.page, path: full };
  },
};

const viewAsSchema = z.object({ employee_email: z.string().email() });

const viewAs: ReadTool = {
  kind: "read",
  name: "view_as",
  description:
    "Super admin only: switch the screen to another user's view (their dashboards, timesheet and permissions) to see or help with their work. Everything done while viewing is audited under the super admin. After switching, this conversation ends and a new one continues as that user.",
  roles: ADMIN,
  schema: viewAsSchema,
  inputSchema: obj({ employee_email: str("Email of the person whose view to open") }, ["employee_email"]),
  async run(ctx, input: z.infer<typeof viewAsSchema>) {
    if (!ctx.user.isSuperAdmin) throw forbidden("Only the super admin can view as other users.");
    const target = await userByEmail(input.employee_email);
    if (target.id === ctx.user.id) throw badRequest("That's your own account.");
    if (!target.active) throw badRequest(`${target.name} is deactivated.`);
    ctx.effect({ type: "impersonate", userId: target.id, name: target.name });
    return { switching_to: target.name, role: target.role };
  },
};

const stopViewingAs: ReadTool = {
  kind: "read",
  name: "stop_viewing_as",
  description: "Return from viewing as this user back to the super admin's own view.",
  roles: ALL,
  schema: z.object({}),
  inputSchema: obj({}),
  async run(ctx) {
    if (!ctx.user.impersonator) throw badRequest("Not viewing as anyone.");
    ctx.effect({ type: "stop_impersonation" });
    return { returning_to: ctx.user.impersonator.name };
  },
};

export const TOOLS: Tool[] = [
  openPage,
  viewAs,
  stopViewingAs,
  listMyProjects,
  getMyWeek,
  hoursReportTool,
  teamStatusTool,
  teamPerformanceTool,
  leaveOverview,
  pendingApprovals,
  listUsers,
  listProjects,
  logTime,
  repeatLastWeek,
  submitWeek,
  reviewEntriesTool,
  sendReminder,
  sendAlertTool,
  requestLeaveTool,
  createUserTool,
  updateUserTool,
  createProjectTool,
  addPhasesTool,
  assignTool,
];

/** Tools offered to this user. Fixed for the life of a conversation (role and view mode don't change within one). */
export function toolsFor(user: SessionUser) {
  return TOOLS.filter((t) => {
    if (t.name === "view_as") return !!user.isSuperAdmin;
    if (t.name === "stop_viewing_as") return !!user.impersonator;
    if (t.permission) return can(user, t.permission);
    return t.roles.includes(user.role);
  });
}

/** Converts thrown errors into a short message the model can act on. */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof z.ZodError) return `Invalid input: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  console.error("[assistant] tool error", error);
  return "The tool failed unexpectedly.";
}
