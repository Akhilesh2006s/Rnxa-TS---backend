import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addDays, today } from "../src/services/dates.js";
import { app, assign, makeProject, makeUser, setPolicy, signIn, superAdmin, thisWeek, yesterdayOrToday } from "./helpers.js";

describe("authentication and CSRF", () => {
  it("rejects unauthenticated API calls", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });

  it("rejects state-changing requests without the custom header", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "x@y.z", password: "nope" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF");
  });

  it("does not let deactivated users sign in", async () => {
    const user = await makeUser("EMPLOYEE");
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    await expect(signIn(user.email)).rejects.toThrow(/401/);
  });
});

describe("employee entries", () => {
  let employee: Awaited<ReturnType<typeof makeUser>>;
  let project: Awaited<ReturnType<typeof makeProject>>;
  let other: Awaited<ReturnType<typeof makeProject>>;

  beforeAll(async () => {
    employee = await makeUser("EMPLOYEE", "Emp One");
    project = await makeProject(["Design", "Build"]);
    other = await makeProject(["Build"]);
    await assign(employee.id, project.id);
  });

  it("lists only assigned projects", async () => {
    const api = await signIn(employee.email);
    const res = await api.get("/api/projects");
    expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual([project.id]);
  });

  it("refuses entries on unassigned projects", async () => {
    const api = await signIn(employee.email);
    const res = await api.post("/api/entries").send({
      workDate: yesterdayOrToday(),
      projectId: other.id,
      phaseId: other.phases[0].id,
      minutes: 60,
      description: "x",
    });
    expect(res.status).toBe(403);
  });

  it("requires a phase that belongs to the project", async () => {
    const api = await signIn(employee.email);
    const base = { workDate: yesterdayOrToday(), projectId: project.id, minutes: 60, description: "x" };
    expect((await api.post("/api/entries").send(base)).status).toBe(400);
    expect((await api.post("/api/entries").send({ ...base, phaseId: other.phases[0].id })).status).toBe(400);
  });

  it("supports multiple entries a day and calculates weekly totals", async () => {
    const user = await makeUser("EMPLOYEE");
    await assign(user.id, project.id);
    const api = await signIn(user.email);
    const date = yesterdayOrToday();
    for (const minutes of [90, 150]) {
      const res = await api.post("/api/entries").send({ workDate: date, projectId: project.id, phaseId: project.phases[0].id, minutes, description: "Work" });
      expect(res.status).toBe(201);
    }
    const week = await api.get(`/api/weeks/${thisWeek()}`);
    expect(week.body.totalMinutes).toBe(240);
    expect(week.body.days.find((d: { date: string }) => d.date === date).minutes).toBe(240);
    expect(week.body.byProjectPhase[0].minutes).toBe(240);
  });

  it("caps a day at 24 hours", async () => {
    const user = await makeUser("EMPLOYEE");
    await assign(user.id, project.id);
    const api = await signIn(user.email);
    const body = { workDate: yesterdayOrToday(), projectId: project.id, phaseId: project.phases[0].id, minutes: 1000, description: "x" };
    expect((await api.post("/api/entries").send(body)).status).toBe(201);
    expect((await api.post("/api/entries").send(body)).status).toBe(400);
  });

  it("flags duplicates and missing descriptions, and blocks submit without a description", async () => {
    const user = await makeUser("EMPLOYEE");
    await assign(user.id, project.id);
    const api = await signIn(user.email);
    const body = { workDate: yesterdayOrToday(), projectId: project.id, phaseId: project.phases[1].id, minutes: 60, description: "" };
    const a = await api.post("/api/entries").send(body);
    await api.post("/api/entries").send(body);
    const week = await api.get(`/api/weeks/${thisWeek()}`);
    expect(week.body.flags[a.body.entry.id]).toEqual(expect.arrayContaining(["DUPLICATE", "MISSING_DESCRIPTION"]));
    const submit = await api.post(`/api/weeks/${thisWeek()}/submit`);
    expect(submit.status).toBe(400);
  });

  it("cannot read or edit another user's entry", async () => {
    const owner = await makeUser("EMPLOYEE");
    const intruder = await makeUser("EMPLOYEE");
    await assign(owner.id, project.id);
    await assign(intruder.id, project.id);
    const ownerApi = await signIn(owner.email);
    const created = await ownerApi.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: project.id, phaseId: project.phases[0].id, minutes: 30, description: "Mine" });
    const intruderApi = await signIn(intruder.email);
    expect((await intruderApi.patch(`/api/entries/${created.body.entry.id}`).send({ minutes: 600 })).status).toBe(404);
    expect((await intruderApi.delete(`/api/entries/${created.body.entry.id}`)).status).toBe(404);
    expect((await intruderApi.get(`/api/entries/${created.body.entry.id}/history`)).status).toBe(403);
    expect((await intruderApi.get("/api/reviews")).status).toBe(403);
    expect((await intruderApi.get("/api/admin/users")).status).toBe(403);
  });

  it("treats malformed ids as not found rather than erroring", async () => {
    const api = await signIn(employee.email);
    expect((await api.patch("/api/entries/not-an-id").send({ minutes: 30 })).status).toBe(404);
    expect((await api.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: "x", minutes: 30 })).status).toBe(400);
  });
});

describe("submission, verifier scope and locking", () => {
  beforeAll(() => setPolicy({ autoVerify: false }));

  it("runs the full workflow and keeps managers to the people they verify", async () => {
    const manager = await makeUser("MANAGER");
    const outsider = await makeUser("MANAGER");
    const employee = await makeUser("EMPLOYEE", "employee", manager.id);
    await makeUser("EMPLOYEE", "outsider's person", outsider.id);
    const project = await makeProject(["Build"]);
    await assign(employee.id, project.id);

    const emp = await signIn(employee.email);
    const created = await emp.post("/api/entries").send({
      workDate: yesterdayOrToday(),
      projectId: project.id,
      phaseId: project.phases[0].id,
      minutes: 120,
      description: "Built the integration",
    });
    const id = created.body.entry.id;

    expect((await emp.post(`/api/weeks/${thisWeek()}/submit`)).body.submitted).toBe(1);
    // Submitted entries are not editable until recalled.
    expect((await emp.patch(`/api/entries/${id}`).send({ minutes: 60 })).status).toBe(409);

    // A manager who doesn't verify this employee sees nothing and cannot act.
    const out = await signIn(outsider.email);
    expect((await out.get("/api/reviews?status=SUBMITTED")).body.entries).toHaveLength(0);
    expect((await out.post("/api/reviews/actions").send({ ids: [id], action: "APPROVE" })).status).toBe(403);

    const mgr = await signIn(manager.email);
    const queue = await mgr.get("/api/reviews?status=SUBMITTED");
    expect(queue.body.entries.map((e: { id: string }) => e.id)).toContain(id);

    // Requesting changes needs a comment.
    expect((await mgr.post("/api/reviews/actions").send({ ids: [id], action: "REQUEST_CHANGES" })).status).toBe(400);
    expect((await mgr.post("/api/reviews/actions").send({ ids: [id], action: "REQUEST_CHANGES", comment: "Split by phase" })).status).toBe(200);

    // Employee can edit a returned entry and resubmit.
    expect((await emp.patch(`/api/entries/${id}`).send({ minutes: 90 })).status).toBe(200);
    expect((await emp.post(`/api/weeks/${thisWeek()}/submit`)).body.submitted).toBe(1);

    expect((await mgr.post("/api/reviews/actions").send({ ids: [id], action: "APPROVE" })).status).toBe(200);
    // Approved entries are locked.
    expect((await emp.patch(`/api/entries/${id}`).send({ minutes: 30 })).status).toBe(409);
    expect((await emp.delete(`/api/entries/${id}`)).status).toBe(400);

    // Reopening requires a reason and is audited.
    expect((await mgr.post("/api/reviews/actions").send({ ids: [id], action: "REOPEN" })).status).toBe(400);
    expect((await mgr.post("/api/reviews/actions").send({ ids: [id], action: "REOPEN", comment: "Client disputed hours" })).status).toBe(200);

    const history = await emp.get(`/api/entries/${id}/history`);
    expect(history.body.actions.map((a: { action: string }) => a.action)).toEqual(["SUBMIT", "REQUEST_CHANGES", "SUBMIT", "APPROVE", "REOPEN"]);
    const audit = await prisma.auditEvent.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toContain("ENTRY_REOPEN");
    expect(audit.every((a) => !a.changes?.includes("Built the integration"))).toBe(true);
  });

  it("does not let a verifier approve their own time", async () => {
    const manager = await makeUser("MANAGER");
    const project = await makeProject(["Build"]);
    await assign(manager.id, project.id, "MEMBER");
    const api = await signIn(manager.email);
    const created = await api.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: project.id, phaseId: project.phases[0].id, minutes: 60, description: "Own work" });
    await api.post(`/api/weeks/${thisWeek()}/submit`);
    expect((await api.post("/api/reviews/actions").send({ ids: [created.body.entry.id], action: "APPROVE" })).status).toBe(403);
  });

  it("requires a reason to reject, and rejected entries are terminal", async () => {
    const employee = await makeUser("EMPLOYEE");
    const admin = await makeUser("ADMIN");
    const project = await makeProject([]);
    await assign(employee.id, project.id);
    const emp = await signIn(employee.email);
    const created = await emp.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: project.id, minutes: 60, description: "Wrong project" });
    expect(created.status).toBe(201);
    await emp.post(`/api/weeks/${thisWeek()}/submit`);
    const adm = await signIn(admin.email);
    expect((await adm.post("/api/reviews/actions").send({ ids: [created.body.entry.id], action: "REJECT", comment: "  " })).status).toBe(400);
    expect((await adm.post("/api/reviews/actions").send({ ids: [created.body.entry.id], action: "REJECT", comment: "Logged on wrong project" })).status).toBe(200);
    expect((await emp.patch(`/api/entries/${created.body.entry.id}`).send({ minutes: 30 })).status).toBe(409);
  });
});

describe("automation", () => {
  it("auto-verifies routine time and sends unusual time to the verifier", async () => {
    await setPolicy({ autoVerify: true, autoVerifyMaxDailyMinutes: 480 });
    const manager = await makeUser("MANAGER");
    const employee = await makeUser("EMPLOYEE", "auto", manager.id);
    const project = await makeProject(["Build"]);
    await assign(employee.id, project.id);
    const api = await signIn(employee.email);
    const day = today(); // today isn't over, so a verified 4h day stays open for more time
    const routine = await api.post("/api/entries").send({ workDate: day, projectId: project.id, phaseId: project.phases[0]!.id, minutes: 240, description: "Built the export" });
    const res = await api.post(`/api/weeks/${thisWeek()}/submit`);
    expect(res.body).toEqual({ submitted: 1, autoVerified: 1 });
    const verified = await prisma.timesheetEntry.findUniqueOrThrow({ where: { id: routine.body.entry.id } });
    expect(verified).toMatchObject({ status: "APPROVED", autoVerified: true });

    // Pushing the same day over the limit means the new entry waits for a person.
    const extra = await api.post("/api/entries").send({ workDate: day, projectId: project.id, phaseId: project.phases[0]!.id, minutes: 300, description: "Overtime on release" });
    const second = await api.post(`/api/weeks/${thisWeek()}/submit`);
    expect(second.body).toEqual({ submitted: 1, autoVerified: 0 });
    expect((await prisma.timesheetEntry.findUniqueOrThrow({ where: { id: extra.body.entry.id } })).status).toBe("SUBMITTED");
    const mgr = await signIn(manager.email);
    expect((await mgr.get("/api/reviews?status=SUBMITTED")).body.entries.map((e: { id: string }) => e.id)).toEqual([extra.body.entry.id]);
    await setPolicy({ autoVerify: false });
  });

  it("repeats last week as drafts, skipping days that already have time", async () => {
    const employee = await makeUser("EMPLOYEE");
    const project = await makeProject([]);
    await assign(employee.id, project.id);
    // Last week's entries are created directly (older than the API's logging window).
    const lastMonday = addDays(thisWeek(), -7);
    await prisma.timesheetEntry.createMany({
      data: [0, 1, 2].map((i) => ({ userId: employee.id, projectId: project.id, workDate: addDays(lastMonday, i), minutes: 420, description: `Day ${i}`, status: "APPROVED" })),
    });
    const api = await signIn(employee.email);
    // Already has time on Monday this week.
    await prisma.timesheetEntry.create({ data: { userId: employee.id, projectId: project.id, workDate: thisWeek(), minutes: 60, description: "Mon", status: "DRAFT" } });
    const preview = await api.post(`/api/weeks/${thisWeek()}/repeat-previous`).send({ preview: true });
    expect(preview.body.created).toBe(0);
    expect(preview.body.plan.map((p: { workDate: string }) => p.workDate)).toEqual([addDays(thisWeek(), 1), addDays(thisWeek(), 2)]);
    expect(await prisma.timesheetEntry.count({ where: { userId: employee.id, workDate: { gte: thisWeek() } } })).toBe(1);
    const done = await api.post(`/api/weeks/${thisWeek()}/repeat-previous`).send({});
    expect(done.body.created).toBe(2);
    const drafts = await prisma.timesheetEntry.findMany({ where: { userId: employee.id, workDate: { gt: thisWeek() } } });
    expect(drafts.every((d) => d.status === "DRAFT" && d.minutes === 420)).toBe(true);
    // Future days stay drafts when the week is submitted.
    const submit = await api.post(`/api/weeks/${thisWeek()}/submit`);
    const future = drafts.filter((d) => d.workDate > today());
    expect(submit.body.submitted).toBe(1 + drafts.length - future.length);
  });

  it("validates verifiers", async () => {
    const admin = await makeUser("ADMIN");
    const employee = await makeUser("EMPLOYEE");
    const other = await makeUser("EMPLOYEE");
    const api = await signIn(admin.email);
    expect((await api.patch(`/api/admin/users/${employee.id}`).send({ verifierId: other.id })).status).toBe(400);
    expect((await api.patch(`/api/admin/users/${employee.id}`).send({ verifierId: employee.id })).status).toBe(400);
    const manager = await makeUser("MANAGER");
    const ok = await api.patch(`/api/admin/users/${employee.id}`).send({ verifierId: manager.id });
    expect(ok.body.user.verifier).toMatchObject({ id: manager.id });
    // A manager with a team can't be demoted until the team has a new verifier.
    expect((await api.patch(`/api/admin/users/${manager.id}`).send({ role: "EMPLOYEE" })).status).toBe(400);
  });

  it("lets an employee with no projects ask the admins, once a day", async () => {
    const admin = await makeUser("ADMIN");
    const employee = await makeUser("EMPLOYEE", "Lonely");
    const api = await signIn(employee.email);
    const week = await api.get(`/api/weeks/${thisWeek()}`);
    expect(week.body.hasProjects).toBe(false);
    expect((await api.post("/api/me/request-projects")).body.notified).toBe(true);
    expect((await api.post("/api/me/request-projects")).body.notified).toBe(false);
    expect(await prisma.notification.count({ where: { userId: admin.id, title: "Lonely needs a project" } })).toBe(1);
  });
});

describe("time slots and projects", () => {
  it("logs from-to slots, calculates hours and rejects overlaps", async () => {
    const employee = await makeUser("EMPLOYEE");
    const project = await makeProject([]);
    await assign(employee.id, project.id);
    const api = await signIn(employee.email);
    const day = yesterdayOrToday();
    const a = await api.post("/api/entries").send({ workDate: day, projectId: project.id, startTime: "09:00", endTime: "11:30", description: "Standup and build" });
    expect(a.status).toBe(201);
    expect(a.body.entry).toMatchObject({ minutes: 150, startTime: "09:00", endTime: "11:30" });
    const clash = await api.post("/api/entries").send({ workDate: day, projectId: project.id, startTime: "11:00", endTime: "12:00", description: "x" });
    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toMatch(/overlaps 09:00–11:30/);
    expect((await api.post("/api/entries").send({ workDate: day, projectId: project.id, startTime: "13:00", endTime: "12:00", description: "x" })).status).toBe(400);
    expect((await api.post("/api/entries").send({ workDate: day, projectId: project.id, startTime: "11:30", endTime: "12:30", description: "Back to back is fine" })).status).toBe(201);
    // A total-hours entry needs no times.
    expect((await api.post("/api/entries").send({ workDate: day, projectId: project.id, minutes: 60, description: "Reading" })).status).toBe(201);
    // Switching an entry to total hours clears its slot.
    const patched = await api.patch(`/api/entries/${a.body.entry.id}`).send({ startTime: null, endTime: null, minutes: 120 });
    expect(patched.body.entry).toMatchObject({ minutes: 120, startTime: null, endTime: null });
    const week = await api.get(`/api/weeks/${thisWeek()}`);
    const times = week.body.entries.filter((e: { workDate: string }) => e.workDate === day).map((e: { startTime: string | null }) => e.startTime);
    expect(times[0]).toBe("11:30"); // slots first, in time order
  });

  it("lists my projects with my hours", async () => {
    const employee = await makeUser("EMPLOYEE");
    const project = await makeProject([]);
    await assign(employee.id, project.id);
    const api = await signIn(employee.email);
    await api.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: project.id, minutes: 90, description: "x" });
    const res = await api.get("/api/projects");
    expect(res.body.projects[0]).toMatchObject({ id: project.id, myMinutesThisWeek: 90, myMinutesTotal: 90 });
    const report = await api.get(`/api/me/report?from=${thisWeek()}&to=${addDays(thisWeek(), 6)}`);
    expect(report.body.totals).toMatchObject({ minutes: 90, draftMinutes: 90, entryCount: 1, daysLogged: 1 });
    expect(report.body.projects[0]).toMatchObject({ code: project.code, status: "active", periodMinutes: 90, totalMinutes: 90 });
    // Only their own time.
    const other = await makeUser("EMPLOYEE");
    const otherApi = await signIn(other.email);
    expect((await otherApi.get(`/api/me/report?from=${thisWeek()}&to=${addDays(thisWeek(), 6)}`)).body.totals.minutes).toBe(0);
  });
});

describe("locked days and project details", () => {
  it("locks a verified day: nothing can be added or moved onto it", async () => {
    await setPolicy({ autoVerify: true, autoVerifyMaxDailyMinutes: 480 });
    const employee = await makeUser("EMPLOYEE");
    const project = await makeProject([]);
    await assign(employee.id, project.id);
    const api = await signIn(employee.email);
    const day = today();
    await api.post("/api/entries").send({ workDate: day, projectId: project.id, minutes: 480, description: "Full day" });
    await api.post(`/api/weeks/${thisWeek()}/submit`);
    const week = await api.get(`/api/weeks/${thisWeek()}`);
    expect(week.body.lockedDays).toContain(day);
    const more = await api.post("/api/entries").send({ workDate: day, projectId: project.id, minutes: 30, description: "Extra" });
    expect(more.status).toBe(409);
    expect(more.body.error.message).toMatch(/locked/);
    await setPolicy({ autoVerify: false });
  });

  it("shows project and phase details by scope", async () => {
    const admin = await superAdmin(); // marking a phase done needs the super admin by default
    const manager = await makeUser("MANAGER");
    const employee = await makeUser("EMPLOYEE", "member", manager.id);
    const adminApi = await signIn(admin.email);
    const created = await adminApi.post("/api/admin/projects").send({ code: `D-${Date.now().toString(36)}`, name: "Detailed", description: "Rollout for the client", startDate: "2026-10-01", endDate: "2026-12-31", phasesEnabled: true });
    expect(created.status).toBe(201);
    const pid = created.body.project.id;
    const phase = await adminApi.post(`/api/admin/projects/${pid}/phases`).send({ name: "Discovery", description: "Workshops", startDate: "2026-10-01", endDate: "2026-10-15", status: "DONE" });
    expect(phase.body.phase).toMatchObject({ status: "DONE", description: "Workshops" });
    await assign(employee.id, pid);
    const hidden = await makeProject(["Build"]);

    const emp = await signIn(employee.email);
    const mine = await emp.get("/api/project-details");
    expect(mine.body.scope).toBe("mine");
    expect(mine.body.projects.map((p: { id: string }) => p.id)).toEqual([pid]);
    expect(mine.body.projects[0]).toMatchObject({ description: "Rollout for the client", endDate: "2026-12-31", people: [] });
    expect(mine.body.projects[0].phases[0]).toMatchObject({ name: "Discovery", status: "DONE", startDate: "2026-10-01" });

    const mgr = await signIn(manager.email);
    const team = await mgr.get("/api/project-details");
    expect(team.body.scope).toBe("team");
    expect(team.body.projects.map((p: { id: string }) => p.id)).toContain(pid);
    expect(team.body.projects.map((p: { id: string }) => p.id)).not.toContain(hidden.id);
    expect(team.body.projects.find((p: { id: string }) => p.id === pid).people.map((u: { id: string }) => u.id)).toContain(employee.id);
  });
});

describe("permissions", () => {
  afterAll(() => prisma.rolePermissions.deleteMany({}));

  it("lets only the super admin close phases until they grant it", async () => {
    await prisma.rolePermissions.deleteMany({});
    const sa = await superAdmin();
    const admin = await makeUser("ADMIN");
    const project = await makeProject(["Build"]);
    const phaseId = project.phases[0]!.id;
    const adminApi = await signIn(admin.email);
    expect((await adminApi.get("/api/auth/me")).body.user.permissions).not.toContain("CLOSE_PHASES");
    // Admins can edit details but not close.
    expect((await adminApi.patch(`/api/admin/phases/${phaseId}`).send({ description: "Configure everything" })).status).toBe(200);
    expect((await adminApi.patch(`/api/admin/phases/${phaseId}`).send({ status: "DONE" })).status).toBe(403);
    expect((await adminApi.patch(`/api/admin/phases/${phaseId}`).send({ active: false })).status).toBe(403);
    expect((await adminApi.get("/api/access")).status).toBe(403);

    const saApi = await signIn(sa.email);
    expect((await saApi.patch(`/api/admin/phases/${phaseId}`).send({ status: "DONE" })).status).toBe(200);
    // Grant closing to the admin role.
    const grant = await saApi.put("/api/access/roles/ADMIN").send({ permissions: ["MANAGE_USERS", "MANAGE_PROJECTS", "CLOSE_PHASES"] });
    expect(grant.status).toBe(200);
    expect((await adminApi.patch(`/api/admin/phases/${phaseId}`).send({ active: false })).status).toBe(200);
    // ...which also took policy and audit away from admins.
    expect((await adminApi.get("/api/admin/policy")).status).toBe(403);
  });

  it("can grant one person a permission their role doesn't have", async () => {
    await prisma.rolePermissions.deleteMany({});
    const sa = await superAdmin();
    const manager = await makeUser("MANAGER");
    const mgrApi = await signIn(manager.email);
    const code = `G-${Date.now().toString(36)}`.toUpperCase();
    expect((await mgrApi.post("/api/admin/projects").send({ code, name: "Granted", phasesEnabled: false })).status).toBe(403);
    const saApi = await signIn(sa.email);
    expect((await saApi.put(`/api/access/users/${manager.id}`).send({ permissions: ["MANAGE_PROJECTS"] })).status).toBe(200);
    expect((await mgrApi.post("/api/admin/projects").send({ code, name: "Granted", phasesEnabled: false })).status).toBe(201);
    expect((await mgrApi.get("/api/admin/audit")).status).toBe(403);
    const access = await saApi.get("/api/access");
    expect(access.body.people.map((p: { id: string }) => p.id)).toContain(manager.id);
  });
});

describe("team dashboard", () => {
  it("reminds only your own team, once a day", async () => {
    const manager = await makeUser("MANAGER");
    const member = await makeUser("EMPLOYEE", "behind", manager.id);
    const outsider = await makeUser("EMPLOYEE");
    const api = await signIn(manager.email);
    expect((await api.post("/api/team/remind").send({ userIds: [outsider.id] })).status).toBe(403);
    expect((await api.post("/api/team/remind").send({ userIds: [member.id] })).body).toEqual({ sent: 1, skipped: 0 });
    expect((await api.post("/api/team/remind").send({ userIds: [member.id] })).body).toEqual({ sent: 0, skipped: 1 });
    const dash = await api.get("/api/dashboard");
    expect(dash.body.review.team.map((t: { user: { id: string } }) => t.user.id)).toEqual([member.id]);
    expect(dash.body.review).toHaveProperty("expectedToDateMinutes");
  });
});
