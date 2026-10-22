import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setModelCall, type ModelCall } from "../src/assistant/agent.js";
import { prisma } from "../src/db.js";
import { runReminderSweep } from "../src/services/reminders.js";
import { today } from "../src/services/dates.js";
import { assign, makeProject, makeUser, setPolicy, signIn, yesterdayOrToday } from "./helpers.js";

type Block = Record<string, unknown>;
let seen: Parameters<ModelCall>[0][] = [];

/** Plays back scripted model turns and records what the agent sent. */
function script(...turns: { content: Block[]; stop: string }[]) {
  seen = [];
  const queue = [...turns];
  setModelCall(async (params) => {
    seen.push(JSON.parse(JSON.stringify(params)));
    const t = queue.shift() ?? { content: [{ type: "text", text: "ok" }], stop: "end_turn" };
    return {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "test",
      content: t.content,
      stop_reason: t.stop,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as never;
  });
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const lastToolResults = () => {
  const msgs = seen[seen.length - 1]!.messages;
  return msgs[msgs.length - 1]!.content as { type: string; tool_use_id: string; content: string; is_error?: boolean }[];
};

afterEach(() => setModelCall(null));

describe("assistant agent", () => {
  beforeAll(() => setPolicy({ autoVerify: false }));
  it("proposes log_time for approval and only writes after approval", async () => {
    const employee = await makeUser("EMPLOYEE", "Agent Emp");
    const project = await makeProject(["Build"]);
    await assign(employee.id, project.id);
    const api = await signIn(employee.email);
    const date = yesterdayOrToday();

    script(
      {
        content: [{ type: "text", text: "Here's the entry." }, toolUse("tu1", "log_time", { date, project_code: project.code, phase: "build", hours: 2.5, description: "Fixed the bundle discount rule." })],
        stop: "tool_use",
      },
      { content: [{ type: "text", text: "Logged it as a draft." }], stop: "end_turn" },
    );
    const first = await api.post("/api/assistant/message").send({ text: "2.5h on build fixing discount rule" });
    expect(first.status).toBe(200);
    expect(first.body.hasPending).toBe(true);
    expect(seen[0]!.model).toBe("claude-sonnet-5-5"); // typed chat uses the default model
    const card = first.body.ui.find((u: { role: string }) => u.role === "action");
    expect(card.action.summary).toContain(`Log 2.5h on ${project.code} · Build`);
    // Nothing written yet.
    expect(await prisma.timesheetEntry.count({ where: { userId: employee.id } })).toBe(0);

    const second = await api.post(`/api/assistant/${first.body.conversationId}/decide`).send({ decisions: { tu1: "approve" } });
    expect(second.status).toBe(200);
    expect(second.body.hasPending).toBe(false);
    const entries = await prisma.timesheetEntry.findMany({ where: { userId: employee.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ minutes: 150, status: "DRAFT", description: "Fixed the bundle discount rule." });
    expect(lastToolResults()[0]).toMatchObject({ tool_use_id: "tu1" });
    expect(second.body.ui.at(-1).text).toBe("Logged it as a draft.");
  });

  it("declines pending actions when the user moves on", async () => {
    const employee = await makeUser("EMPLOYEE");
    const project = await makeProject([]);
    await assign(employee.id, project.id);
    const api = await signIn(employee.email);
    script(
      { content: [toolUse("tu1", "log_time", { date: yesterdayOrToday(), project_code: project.code, hours: 1, description: "Call" })], stop: "tool_use" },
      { content: [{ type: "text", text: "Sure." }], stop: "end_turn" },
    );
    const first = await api.post("/api/assistant/message").send({ text: "log 1h" });
    await api.post("/api/assistant/message").send({ conversationId: first.body.conversationId, text: "actually never mind" });
    // Last message is the per-turn context note; the user's turn is just before it.
    expect(seen[1]!.messages.at(-1)!.role).toBe("system");
    const content = seen[1]!.messages.at(-2)!.content as { type: string; tool_use_id?: string; content?: string }[];
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1" });
    expect(content[0]!.content).toMatch(/did not approve/);
    expect(content[1]).toMatchObject({ type: "text", text: "actually never mind" });
    expect(await prisma.timesheetEntry.count({ where: { userId: employee.id } })).toBe(0);
  });

  it("only offers tools the user's role allows", async () => {
    const employee = await makeUser("EMPLOYEE");
    const api = await signIn(employee.email);
    script(
      { content: [toolUse("tu1", "create_project", { code: "HACK-1", name: "Nope" })], stop: "tool_use" },
      { content: [{ type: "text", text: "I can't do that." }], stop: "end_turn" },
    );
    const res = await api.post("/api/assistant/message").send({ text: "create a project" });
    const names = seen[0]!.tools.map((t) => t.name);
    expect(names).toContain("log_time");
    expect(names).not.toContain("create_project");
    expect(names).not.toContain("send_reminder");
    expect(res.body.hasPending).toBe(false);
    expect(lastToolResults()[0]).toMatchObject({ is_error: true });
    expect(await prisma.project.findUnique({ where: { code: "HACK-1" } })).toBeNull();
  });

  it("returns live, scoped data from read tools", async () => {
    const manager = await makeUser("MANAGER");
    const member = await makeUser("EMPLOYEE", "Team Member", manager.id);
    const outsider = await makeUser("EMPLOYEE", "Outsider");
    const mine = await makeProject(["Build"]);
    const other = await makeProject(["Build"]);
    await assign(member.id, mine.id);
    await assign(outsider.id, other.id);
    const api = await signIn(manager.email);
    script({ content: [toolUse("tu1", "team_status", {})], stop: "tool_use" }, { content: [{ type: "text", text: "Done." }], stop: "end_turn" });
    await api.post("/api/assistant/message").send({ text: "who is missing time?" });
    const data = JSON.parse(lastToolResults()[0]!.content);
    const emails = data.people.map((p: { email: string }) => p.email);
    expect(emails).toContain(member.email);
    expect(emails).not.toContain(outsider.email);
  });

  it("lets managers remind only their own team, after approval", async () => {
    const manager = await makeUser("MANAGER");
    const member = await makeUser("EMPLOYEE", "member", manager.id);
    const outsider = await makeUser("EMPLOYEE");
    const project = await makeProject(["Build"]);
    await assign(member.id, project.id);
    const api = await signIn(manager.email);

    script({ content: [toolUse("tu1", "send_reminder", { employee_emails: [outsider.email], message: "Please log time" })], stop: "tool_use" });
    const blocked = await api.post("/api/assistant/message").send({ text: "remind them" });
    expect(blocked.body.hasPending).toBe(false);
    expect(lastToolResults()[0]).toMatchObject({ is_error: true });

    script(
      { content: [toolUse("tu2", "send_reminder", { employee_emails: [member.email], message: "Please log Monday's time" })], stop: "tool_use" },
      { content: [{ type: "text", text: "Sent." }], stop: "end_turn" },
    );
    const ok = await api.post("/api/assistant/message").send({ text: "remind my team member" });
    expect(ok.body.hasPending).toBe(true);
    expect(await prisma.notification.count({ where: { userId: member.id } })).toBe(0);
    await api.post(`/api/assistant/${ok.body.conversationId}/decide`).send({ decisions: { tu2: "approve" } });
    const notes = await prisma.notification.findMany({ where: { userId: member.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Please log Monday's time");
    expect(await prisma.notification.count({ where: { userId: outsider.id } })).toBe(0);
  });

  it("keeps generated passwords out of the model and the stored conversation", async () => {
    const admin = await makeUser("ADMIN");
    const api = await signIn(admin.email);
    const email = `new-${Date.now()}@test.local`;
    script(
      { content: [toolUse("tu1", "create_user", { name: "New Person", email, role: "EMPLOYEE" })], stop: "tool_use" },
      { content: [{ type: "text", text: "Created." }], stop: "end_turn" },
    );
    const first = await api.post("/api/assistant/message").send({ text: "add New Person" });
    const done = await api.post(`/api/assistant/${first.body.conversationId}/decide`).send({ decisions: { tu1: "approve" } });
    const secret = done.body.secrets?.[0]?.value as string;
    expect(secret).toMatch(/^Rnxa-/);
    expect(JSON.stringify(seen)).not.toContain(secret);
    const stored = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: first.body.conversationId } });
    expect(stored.messages + stored.ui).not.toContain(secret);
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  it("does not let users read someone else's conversation", async () => {
    const a = await makeUser("EMPLOYEE");
    const b = await makeUser("EMPLOYEE");
    script({ content: [{ type: "text", text: "hi" }], stop: "end_turn" });
    const apiA = await signIn(a.email);
    const res = await apiA.post("/api/assistant/message").send({ text: "hello" });
    const apiB = await signIn(b.email);
    expect((await apiB.post(`/api/assistant/${res.body.conversationId}/decide`).send({ decisions: {} })).status).toBe(404);
    expect((await apiB.post("/api/assistant/message").send({ conversationId: res.body.conversationId, text: "hi" })).status).toBe(404);
  });
});

describe("automatic reminders", () => {
  it("reminds members below expected hours once per day", async () => {
    const member = await makeUser("EMPLOYEE");
    const project = await makeProject(["Build"]);
    await assign(member.id, project.id);
    await prisma.orgPolicy.upsert({ where: { id: "org" }, update: { autoReminders: true, reminderHour: 0, workDays: "1,2,3,4,5,6,7" }, create: { id: "org", reminderHour: 0, workDays: "1,2,3,4,5,6,7" } });
    const at = new Date(`${today()}T18:00:00`);
    await runReminderSweep(at);
    await runReminderSweep(at);
    const notes = await prisma.notification.findMany({ where: { userId: member.id, title: "Log today's time" } });
    expect(notes).toHaveLength(1);
  });
});

describe("screen control and impersonation", () => {
  it("open_page drives the screen with resolved filters and respects role", async () => {
    const manager = await makeUser("MANAGER");
    const member = await makeUser("EMPLOYEE", "member", manager.id);
    const project = await makeProject(["Build"]);
    await assign(member.id, project.id);
    const api = await signIn(manager.email);
    script(
      { content: [toolUse("tu1", "open_page", { page: "approvals", employee_email: member.email }), toolUse("tu2", "open_page", { page: "users" })], stop: "tool_use" },
      { content: [{ type: "text", text: "Here they are." }], stop: "end_turn" },
    );
    const res = await api.post("/api/assistant/message").send({ text: "show me what's waiting", mode: "voice", page: "/" });
    expect(res.body.effects).toEqual([{ type: "navigate", path: `/reviews?status=SUBMITTED&userId=${member.id}`, label: "approvals" }]);
    const results = lastToolResults();
    expect(results[1]).toMatchObject({ tool_use_id: "tu2", is_error: true });
    expect(seen[0]!.model).toBe("claude-haiku-5-5"); // voice favours the fastest model
    // Voice mode and current page reach the model as a per-turn context note.
    const note = seen[0]!.messages.at(-1)!;
    expect(note.role).toBe("system");
    expect(String(note.content)).toMatch(/read aloud/);
    expect(String(note.content)).toContain("showing /");
  });

  it("streams text and effects as server-sent events", async () => {
    const employee = await makeUser("EMPLOYEE");
    const api = await signIn(employee.email);
    setModelCall(async ({ onText }) => {
      onText?.("Hello ");
      onText?.("there.");
      return { id: "m", type: "message", role: "assistant", model: "t", content: [{ type: "text", text: "Hello there." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
    });
    const res = await api.post("/api/assistant/message").set("Accept", "text/event-stream").send({ text: "hi" });
    const events = res.text.split(/\n\n/).filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("Hello there.");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(events.at(-1).result.ui.at(-1).text).toBe("Hello there.");
  });

  it("lets only the super admin view as another user, audited under the super admin", async () => {
    const startedAt = new Date();
    const superAdmin = await prisma.user.upsert({
      where: { email: "superadmin@test.local" },
      update: {},
      create: { email: "superadmin@test.local", name: "Super Admin", role: "ADMIN", passwordHash: (await makeUser("ADMIN")).passwordHash },
    });
    const otherAdmin = await makeUser("ADMIN");
    const employee = await makeUser("EMPLOYEE", "Viewed Person");
    const project = await makeProject([]);
    await assign(employee.id, project.id);

    const plainAdmin = await signIn(otherAdmin.email);
    expect((await plainAdmin.post("/api/auth/impersonate").send({ userId: employee.id })).status).toBe(403);

    const api = await signIn(superAdmin.email);
    expect((await api.get("/api/auth/me")).body.user.isSuperAdmin).toBe(true);
    const start = await api.post("/api/auth/impersonate").send({ userId: employee.id });
    expect(start.status).toBe(200);
    const me = (await api.get("/api/auth/me")).body.user;
    expect(me).toMatchObject({ id: employee.id, role: "EMPLOYEE", impersonator: { id: superAdmin.id } });
    // Acting with the employee's permissions: admin pages are closed.
    expect((await api.get("/api/admin/users")).status).toBe(403);

    // Work done while viewing is audited with the super admin's id.
    const entry = await api.post("/api/entries").send({ workDate: yesterdayOrToday(), projectId: project.id, minutes: 30, description: "Helped fix entry" });
    expect(entry.status).toBe(201);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: entry.body.entry.id, action: "ENTRY_CREATE" } });
    expect(JSON.parse(audit.changes!).impersonatedBy).toBe(superAdmin.id);

    // The assistant keeps the super admin's conversation separate from the employee's own.
    script({ content: [{ type: "text", text: "Viewing." }], stop: "end_turn" });
    const convo = await api.post("/api/assistant/message").send({ text: "what's on this dashboard?" });
    expect(seen[0]!.tools.map((t) => t.name)).toContain("stop_viewing_as");
    expect(seen[0]!.system).toContain("viewing the app as Viewed Person");
    const own = await signIn(employee.email);
    expect((await own.get("/api/assistant/conversation")).body.conversationId).not.toBe(convo.body.conversationId);

    expect((await api.post("/api/auth/impersonate/stop")).status).toBe(200);
    expect((await api.get("/api/auth/me")).body.user).toMatchObject({ id: superAdmin.id, isSuperAdmin: true });
    expect(await prisma.auditEvent.count({ where: { action: { in: ["IMPERSONATE_START", "IMPERSONATE_STOP"] }, actorId: superAdmin.id, createdAt: { gte: startedAt } } })).toBe(2);
  });
});
