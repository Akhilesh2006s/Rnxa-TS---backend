import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addDays, today, weekStart } from "../src/services/dates.js";
import { assign, makeProject, makeUser, setPolicy, signIn, superAdmin, thisWeek } from "./helpers.js";

type U = Awaited<ReturnType<typeof makeUser>>;

describe("leave management", () => {
  let lead: U;
  let emp: U;
  let other: U;
  const monday = addDays(weekStart(today()), 14);

  beforeAll(async () => {
    await setPolicy({ autoVerify: false, workDays: "1,2,3,4,5", expectedDailyMinutes: 480 });
    await prisma.orgPolicy.update({ where: { id: "org" }, data: { casualLeaveDays: 3 } });
    await prisma.holiday.deleteMany({ where: { date: { gte: monday, lte: addDays(monday, 13) } } });
    lead = await makeUser("MANAGER", "Leave Lead");
    emp = await makeUser("EMPLOYEE", "Leave Emp", lead.id);
    other = await makeUser("EMPLOYEE", "Leave Other");
  });

  it("counts working days, notifies the verifier, and lets only them approve", async () => {
    const api = await signIn(emp.email);
    // Monday to the following Monday: 6 working days, more than the 3 casual days allowed.
    const tooMany = await api.post("/api/leave").send({ type: "CASUAL", startDate: monday, endDate: addDays(monday, 7) });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.message).toMatch(/Not enough casual leave/);

    // Wed to Mon spans a weekend: 4 working days of sick leave.
    const res = await api.post("/api/leave").send({ type: "SICK", startDate: addDays(monday, 2), endDate: addDays(monday, 7), reason: "Flu" });
    expect(res.status).toBe(201);
    expect(res.body.leave.days).toBe(4);
    expect(await prisma.notification.count({ where: { userId: lead.id, title: { contains: "requested leave" } } })).toBe(1);

    const overlap = await api.post("/api/leave").send({ type: "CASUAL", startDate: addDays(monday, 3), endDate: addDays(monday, 3) });
    expect(overlap.status).toBe(409);

    expect((await (await signIn(other.email)).post(`/api/leave/${res.body.leave.id}/decide`).send({ decision: "APPROVE" })).status).toBe(404);
    expect((await api.post(`/api/leave/${res.body.leave.id}/decide`).send({ decision: "APPROVE" })).status).toBe(404);
    const lapi = await signIn(lead.email);
    expect((await lapi.post(`/api/leave/${res.body.leave.id}/decide`).send({ decision: "REJECT" })).status).toBe(400);
    const ok = await lapi.post(`/api/leave/${res.body.leave.id}/decide`).send({ decision: "APPROVE" });
    expect(ok.status).toBe(200);
    expect(ok.body.leave.status).toBe("APPROVED");

    const me = await api.get("/api/leave/me");
    expect(me.body.balances.find((b: { type: string }) => b.type === "SICK")).toMatchObject({ used: 4 });
    const team = await lapi.get(`/api/leave/team?from=${monday}&to=${addDays(monday, 13)}`);
    expect(team.body.upcoming).toHaveLength(1);
  });

  it("lowers expected hours on leave days and holidays", async () => {
    const api = await signIn(emp.email);
    const week = await api.get(`/api/weeks/${monday}`);
    const wed = week.body.days.find((d: { date: string }) => d.date === addDays(monday, 2));
    expect(wed).toMatchObject({ expectedMinutes: 0, leave: { type: "SICK", halfDay: false } });
    expect(week.body.expectedMinutes).toBe(2 * 480);

    const admin = await signIn((await superAdmin()).email);
    const hol = await admin.post("/api/holidays").send({ date: monday, name: "Founders Day" });
    expect(hol.status).toBe(201);
    const after = await api.get(`/api/weeks/${monday}`);
    expect(after.body.days[0]).toMatchObject({ expectedMinutes: 0, holiday: "Founders Day" });
    expect((await api.post("/api/holidays").send({ date: addDays(monday, 1), name: "Nope" })).status).toBe(403);
    await admin.delete(`/api/holidays/${hol.body.holiday.id}`);
  });

  it("only cancels leave that hasn't started", async () => {
    const api = await signIn(emp.email);
    const res = await api.post("/api/leave").send({ type: "CASUAL", startDate: addDays(monday, 9), endDate: addDays(monday, 9), halfDay: true });
    expect(res.body.leave.days).toBe(0.5);
    expect((await api.post(`/api/leave/${res.body.leave.id}/cancel`)).status).toBe(200);
    expect((await api.post(`/api/leave/${res.body.leave.id}/cancel`)).status).toBe(409);
  });
});

describe("team performance and exports", () => {
  let lead: U;
  let good: U;
  let weak: U;

  beforeAll(async () => {
    await setPolicy({ autoVerify: false, workDays: "1,2,3,4,5", expectedDailyMinutes: 480 });
    lead = await makeUser("MANAGER", "Perf Lead");
    good = await makeUser("EMPLOYEE", "Perf Good", lead.id);
    weak = await makeUser("EMPLOYEE", "Perf Weak", lead.id);
    const project = await makeProject(["Build"]);
    await assign(good.id, project.id);
    await assign(weak.id, project.id);
    // Last week: Good logs full days and submits same day; Weak logs one short day and leaves it in draft.
    const last = addDays(thisWeek(), -7);
    for (let i = 0; i < 5; i++) {
      await prisma.timesheetEntry.create({
        data: { userId: good.id, projectId: project.id, phaseId: project.phases[0].id, workDate: addDays(last, i), minutes: 480, description: "Build", status: "APPROVED", submittedAt: new Date(`${addDays(last, i)}T18:00:00Z`) },
      });
    }
    await prisma.timesheetEntry.create({
      data: { userId: weak.id, projectId: project.id, phaseId: project.phases[0].id, workDate: last, minutes: 120, description: "=HYPERLINK(\"x\")", status: "DRAFT" },
    });
  });

  it("scores people, lists reasons, and is scoped to the manager's team", async () => {
    const last = addDays(thisWeek(), -7);
    const api = await signIn(lead.email);
    const res = await api.get(`/api/reports/team?from=${last}&to=${addDays(last, 6)}`);
    expect(res.status).toBe(200);
    expect(res.body.people.map((p: { user: { name: string } }) => p.user.name)).toEqual(["Perf Weak", "Perf Good"]);
    const [weakRow, goodRow] = res.body.people;
    expect(goodRow).toMatchObject({ rating: "STRONG", score: 100, emptyDays: 0, onTime: 5 });
    expect(weakRow.rating).toBe("NEEDS_ATTENTION");
    expect(weakRow.emptyDays).toBe(4);
    expect(weakRow.reasons.join(" ")).toMatch(/Logged 2h of 40h/);
    expect(weakRow.reasons.join(" ")).toMatch(/not submitted/);

    expect((await (await signIn(good.email)).get(`/api/reports/team?from=${last}&to=${last}`)).status).toBe(403);
  });

  it("exports CSV with formula cells neutralised", async () => {
    const last = addDays(thisWeek(), -7);
    const api = await signIn(lead.email);
    const team = await api.get(`/api/reports/team.csv?from=${last}&to=${addDays(last, 6)}`);
    expect(team.status).toBe(200);
    expect(team.headers["content-type"]).toMatch(/text\/csv/);
    expect(team.text).toContain("Perf Weak");
    const entries = await api.get(`/api/reports/entries.csv?from=${last}&to=${addDays(last, 6)}`);
    expect(entries.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(entries.text).not.toContain(",=HYPERLINK");
  });
});

describe("alerts", () => {
  let lead: U;
  let mine: U;
  let notMine: U;

  beforeAll(async () => {
    lead = await makeUser("MANAGER", "Alert Lead");
    mine = await makeUser("EMPLOYEE", "Alert Mine", lead.id);
    notMine = await makeUser("EMPLOYEE", "Alert Other");
  });

  it("lets managers alert only their team, with read receipts", async () => {
    const api = await signIn(lead.email);
    expect((await api.post("/api/alerts").send({ title: "Hi", body: "All", audience: { type: "everyone" } })).status).toBe(403);
    expect((await api.post("/api/alerts").send({ title: "Hi", body: "You", audience: { type: "people", userIds: [notMine.id] } })).status).toBe(403);
    const sent = await api.post("/api/alerts").send({ title: "Submit by Friday", body: "Client invoice run.", priority: "URGENT", audience: { type: "team" } });
    expect(sent.status).toBe(201);
    expect(sent.body.alert).toMatchObject({ recipientCount: 1, audience: "My team" });

    const emp = await signIn(mine.email);
    const inbox = await emp.get("/api/alerts/inbox");
    expect(inbox.body.urgent).toHaveLength(1);
    await emp.post(`/api/notifications/${inbox.body.urgent[0].notificationId}/read`);
    expect((await emp.get("/api/alerts/inbox")).body.urgent).toHaveLength(0);

    const list = await api.get("/api/alerts/sent");
    expect(list.body.alerts[0].readCount).toBe(1);
    const receipts = await api.get(`/api/alerts/${sent.body.alert.id}/receipts`);
    expect(receipts.body.receipts[0].user.name).toBe("Alert Mine");
    expect((await emp.post("/api/alerts").send({ title: "x", body: "y", audience: { type: "team" } })).status).toBe(403);
  });

  it("lets the super admin alert a whole role", async () => {
    const admin = await signIn((await superAdmin()).email);
    const res = await admin.post("/api/alerts").send({ title: "Policy update", body: "New leave policy.", audience: { type: "role", role: "MANAGER" } });
    expect(res.status).toBe(201);
    expect(res.body.alert.audience).toBe("All managers");
    expect(await prisma.notification.count({ where: { alertId: res.body.alert.id, userId: lead.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { alertId: res.body.alert.id, userId: mine.id } })).toBe(0);
  });
});
