// Showcase data for demos and the product video: one project lead who verifies
// three employees, two client projects, four weeks of realistic hours (one
// person clearly behind), leave, holidays, an alert, and an entry with a photo
// and a PDF attached. Re-running resets these demo people's data.
// Usage: npm run db:demo   (needs DEMO_PASSWORD in .env; refuses in production)
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to create demo data in production.");
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) throw new Error("Set DEMO_PASSWORD (10+ characters) in .env first.");
  const passwordHash = await bcrypt.hash(password, 12);

  const upsertUser = (email: string, name: string, role: string, verifierId: string | null = null) =>
    prisma.user.upsert({
      where: { email },
      update: { name, role, active: true, passwordHash, verifierId },
      create: { email, name, role, passwordHash, verifierId },
    });

  const lead = await upsertUser("vikram@rnxadigital.com", "Vikram Shah", "MANAGER");
  const priya = await upsertUser("priya@rnxadigital.com", "Priya Nair", "EMPLOYEE", lead.id);
  const arjun = await upsertUser("arjun@rnxadigital.com", "Arjun Mehta", "EMPLOYEE", lead.id);
  const meera = await upsertUser("meera@rnxadigital.com", "Meera Iyer", "EMPLOYEE", lead.id);

  type PhaseSeed = { name: string; description: string; start: string; end: string; status: string };
  const project = async (code: string, name: string, client: string, details: { description: string; startDate: string; endDate: string }, phases: PhaseSeed[]) => {
    const p = await prisma.project.upsert({ where: { code }, update: { active: true, ...details }, create: { code, name, client, phasesEnabled: true, ...details } });
    for (const [i, ph] of phases.entries()) {
      const data = { description: ph.description, startDate: ph.start, endDate: ph.end, status: ph.status, active: ph.status !== "DONE" || ph.name === "Design" };
      await prisma.phase.upsert({ where: { projectId_name: { projectId: p.id, name: ph.name } }, update: { ...data, sortOrder: i }, create: { projectId: p.id, name: ph.name, sortOrder: i, ...data } });
    }
    return prisma.project.findUniqueOrThrow({ where: { id: p.id }, include: { phases: true } });
  };
  const acme = await project(
    "ACME-CPQ",
    "Acme CPQ rollout",
    "Acme Corp",
    {
      description: "Rolling out Salesforce CPQ for Acme's sales team: product catalog, price rules, discount approvals and quote templates, from discovery to go-live.",
      startDate: "2026-09-01",
      endDate: "2026-12-18",
    },
    [
      { name: "Discovery", description: "Workshops with Acme sales and finance to agree scope, pricing rules and approval paths.", start: "2026-09-01", end: "2026-09-19", status: "DONE" },
      { name: "Design", description: "Solution design for the catalog, bundles, discount schedules and quote template.", start: "2026-09-22", end: "2026-10-09", status: "DONE" },
      { name: "Build", description: "Configure CPQ: products, price rules, discount schedules, approvals and the quote PDF.", start: "2026-10-12", end: "2026-11-20", status: "IN_PROGRESS" },
      { name: "UAT", description: "Acme's sales team tests real quotes; we fix what they find.", start: "2026-11-23", end: "2026-12-11", status: "PLANNED" },
    ],
  );
  const nw = await project(
    "NW-DESK",
    "Northwind service desk",
    "Northwind",
    {
      description: "An agentic AI service desk for Northwind: automatic ticket triage, routing and suggested replies, piloted with one support team first.",
      startDate: "2026-09-15",
      endDate: "2026-11-27",
    },
    [
      { name: "Discovery", description: "Map ticket categories, routing rules and the support team's workflow.", start: "2026-09-15", end: "2026-09-30", status: "DONE" },
      { name: "Build", description: "Build the triage agent, routing integration and reply suggestions.", start: "2026-10-01", end: "2026-10-23", status: "IN_PROGRESS" },
      { name: "Pilot", description: "Run live with one Northwind support team, measure accuracy and tune.", start: "2026-10-19", end: "2026-11-27", status: "IN_PROGRESS" },
    ],
  );
  const phase = (p: typeof acme, name: string) => p.phases.find((ph) => ph.name === name)!.id;

  for (const [user, proj] of [
    [priya, acme],
    [arjun, acme],
    [arjun, nw],
    [meera, nw],
    [lead, acme],
    [lead, nw],
  ] as const) {
    const data = { userId: user.id, projectId: proj.id, role: "MEMBER" };
    await prisma.projectAssignment.upsert({ where: { userId_projectId_role: data }, update: {}, create: data });
  }

  // Fresh entries, assistant chats and notifications for the demo people (and the
  // super admin's chats), so every demo starts from the same state.
  const ids = [lead.id, priya.id, arjun.id, meera.id];
  const superAdmin = process.env.SUPERADMIN_EMAIL ? await prisma.user.findUnique({ where: { email: process.env.SUPERADMIN_EMAIL.toLowerCase() } }) : null;
  const chatOwners = superAdmin ? [...ids, superAdmin.id] : ids;
  await prisma.assistantConversation.deleteMany({ where: { OR: [{ userId: { in: chatOwners } }, { actorId: { in: chatOwners } }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: chatOwners } } });
  const oldFiles = await prisma.attachment.findMany({ where: { entry: { userId: { in: ids } } }, select: { id: true, storageKey: true } });
  await prisma.attachment.deleteMany({ where: { id: { in: oldFiles.map((f) => f.id) } } });
  await Promise.all(oldFiles.map((f) => rm(path.resolve(process.env.UPLOAD_DIR || "uploads", f.storageKey), { force: true })));
  await prisma.approvalAction.deleteMany({ where: { entry: { userId: { in: ids } } } });
  await prisma.timesheetEntry.deleteMany({ where: { userId: { in: ids } } });
  await prisma.leaveRequest.deleteMany({ where: { userId: { in: ids } } });
  await prisma.alert.deleteMany({ where: { senderId: { in: chatOwners } } });

  const today = iso(new Date());
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = addDays(today, -dow);
  const lastMonday = addDays(thisMonday, -7);
  const now = new Date();

  // Organisation holidays (fixed dates).
  const holidays = [
    ["2026-10-02", "Gandhi Jayanti"],
    ["2026-12-25", "Christmas"],
    ["2027-01-26", "Republic Day"],
  ];
  for (const [date, name] of holidays) await prisma.holiday.upsert({ where: { date }, update: { name }, create: { date, name } });
  const holidaySet = new Set(holidays.map(([d]) => d));

  // Leave: Priya took two earned days and has a request waiting; Meera was off sick one day.
  const w = (n: number) => addDays(thisMonday, -7 * n); // Monday n weeks ago
  const leave = [
    { user: priya, type: "EARNED", startDate: addDays(w(2), 3), endDate: addDays(w(2), 4), days: 2, status: "APPROVED", reason: "Sister's wedding" },
    { user: meera, type: "SICK", startDate: addDays(w(2), 4), endDate: addDays(w(2), 4), days: 1, status: "APPROVED", reason: "Fever" },
    { user: arjun, type: "CASUAL", startDate: addDays(thisMonday, 11), endDate: addDays(thisMonday, 11), days: 1, status: "APPROVED", reason: "Bank and passport errands" },
    { user: priya, type: "CASUAL", startDate: addDays(thisMonday, 7), endDate: addDays(thisMonday, 8), days: 2, status: "PENDING", reason: "Family function in Kochi" },
  ];
  for (const l of leave) {
    await prisma.leaveRequest.create({
      data: {
        userId: l.user.id,
        type: l.type,
        startDate: l.startDate,
        endDate: l.endDate,
        days: l.days,
        reason: l.reason,
        status: l.status,
        approverId: l.status === "APPROVED" ? lead.id : null,
        decidedAt: l.status === "APPROVED" ? new Date(`${l.startDate}T04:00:00Z`) : null,
      },
    });
  }
  const offDays = new Set(leave.filter((l) => l.status === "APPROVED").flatMap((l) => {
    const out: string[] = [];
    for (let d = l.startDate; d <= l.endDate; d = addDays(d, 1)) out.push(`${l.user.id}|${d}`);
    return out;
  }));

  type Row = {
    user: { id: string };
    proj: typeof acme;
    phase: string;
    date: string;
    h: number;
    text: string;
    status: string;
    auto?: boolean;
    /** Days after the work date it was submitted (0 = same evening). */
    lateDays?: number;
    /** Sent back once for changes before being verified. */
    sentBack?: string;
  };
  const rows: Row[] = [];
  const week = (user: Row["user"], start: string, days: number, plan: [typeof acme, string, number, string][], status: string, extra: Partial<Row> = {}) => {
    for (let d = 0; d < days; d++) {
      const date = addDays(start, d);
      if (holidaySet.has(date) || offDays.has(`${user.id}|${date}`)) continue;
      for (const [proj, ph, h, text] of plan) rows.push({ user, proj, phase: ph, date, h, text, status, auto: true, lateDays: 0, ...extra });
    }
  };

  // Five finished weeks. Priya, Arjun and Vikram are steady; Meera falls behind.
  for (const n of [5, 4, 3, 2, 1]) {
    const designOrBuild = n >= 3 ? "Design" : "Build";
    week(priya, w(n), 5, [[acme, designOrBuild, 5, "Designed the quote template layout and approval rules with the Acme sales team."], [acme, "Build", 3, "Configured price rules for the enterprise bundle."]], "APPROVED");
    week(arjun, w(n), 5, [[acme, "Build", 4, "Built product catalog import for Acme CPQ."], [nw, n >= 3 ? "Discovery" : "Build", 4, "Mapped Northwind's ticket categories and routing rules."]], "APPROVED");
    week(lead, w(n), 5, [[acme, "Discovery", 4, "Ran project governance and weekly client check-ins."], [nw, "Discovery", 4, "Planned the Northwind pilot scope."]], "APPROVED");
  }
  week(meera, w(5), 5, [[nw, "Discovery", 7.5, "Interviewed Northwind support agents about ticket handling."]], "APPROVED", { lateDays: 1 });
  week(meera, w(4), 4, [[nw, "Discovery", 7, "Analysed six months of Northwind tickets by category."]], "APPROVED", { lateDays: 3 });
  // Then a three-day week, submitted a week late; then short days and an entry sent back; then a full week.
  week(meera, w(3), 3, [[nw, "Discovery", 7.5, "Documented triage categories with the Northwind support leads."]], "APPROVED", { lateDays: 6 });
  rows.push({ user: meera, proj: nw, phase: "Discovery", date: addDays(w(3), 3), h: 2, text: "Notes", status: "DRAFT" });
  week(meera, w(2), 4, [[nw, "Build", 6, "Set up the agent triage flow for the Northwind service desk."]], "APPROVED", { lateDays: 4 });
  rows.push({ user: meera, proj: nw, phase: "Build", date: addDays(w(2), 1), h: 3, text: "Fixed routing rules for billing tickets after review.", status: "APPROVED", auto: false, lateDays: 3, sentBack: "Please split this from the 6h above and say which routing rules changed." });
  week(meera, w(1), 5, [[nw, "Build", 7.5, "Built the reply-suggestion step for the Northwind pilot."]], "APPROVED", { lateDays: 2 });

  // This week up to yesterday.
  const daysSoFar = dow; // Monday..yesterday
  week(priya, thisMonday, daysSoFar, [[acme, "Build", 8, "Built CPQ discount schedules and tested them against Acme's price book."]], "APPROVED");
  week(arjun, thisMonday, Math.max(0, daysSoFar - 1), [[acme, "Build", 8, "Integrated the CPQ quote output with Acme's ERP."]], "APPROVED");
  if (daysSoFar >= 1) {
    // A long go-live day with evidence attached: goes to the project lead instead of auto-verifying.
    rows.push({ user: arjun, proj: nw, phase: "Pilot", date: addDays(thisMonday, daysSoFar - 1), h: 10.5, text: "Supported the Northwind pilot go-live cutover and fixed routing issues found on the night.", status: "SUBMITTED" });
  }
  if (daysSoFar >= 1) rows.push({ user: meera, proj: nw, phase: "Build", date: thisMonday, h: 6, text: "Tuned triage prompts for the Northwind pilot.", status: "APPROVED", auto: true });
  week(lead, thisMonday, daysSoFar, [[acme, "UAT", 4, "Coordinated UAT sessions with Acme stakeholders."], [nw, "Pilot", 4, "Reviewed pilot readiness with the Northwind team."]], "APPROVED");

  let goLive: string | null = null;
  for (const r of rows) {
    const approved = r.status === "APPROVED";
    const submittedAt = r.status === "DRAFT" ? null : new Date(`${addDays(r.date, r.lateDays ?? 0)}T12:30:00Z`);
    const reviewedAt = approved ? new Date((submittedAt ?? new Date()).getTime() + (r.sentBack ? 3 : 1) * 3_600_000) : null;
    const e = await prisma.timesheetEntry.create({
      data: {
        userId: r.user.id,
        projectId: r.proj.id,
        phaseId: phase(r.proj, r.phase),
        workDate: r.date,
        minutes: Math.round(r.h * 60),
        description: r.text,
        status: r.status,
        submittedAt,
        reviewedAt,
        autoVerified: approved && !!r.auto && !r.sentBack,
        reviewedById: approved && (!r.auto || r.sentBack) ? lead.id : null,
      },
    });
    if (r.sentBack) {
      await prisma.approvalAction.create({ data: { entryId: e.id, actorId: lead.id, action: "REQUEST_CHANGES", fromStatus: "SUBMITTED", toStatus: "CHANGES_REQUESTED", comment: r.sentBack } });
      await prisma.approvalAction.create({ data: { entryId: e.id, actorId: r.user.id, action: "SUBMIT", fromStatus: "CHANGES_REQUESTED", toStatus: "SUBMITTED" } });
    }
    if (approved) {
      const auto = !!r.auto && !r.sentBack;
      await prisma.approvalAction.create({
        data: { entryId: e.id, actorId: auto ? r.user.id : lead.id, action: auto ? "AUTO_VERIFY" : "APPROVE", fromStatus: "SUBMITTED", toStatus: "APPROVED" },
      });
    }
    if (r.h === 10.5) goLive = e.id;
  }

  // Evidence on the go-live entry: a photo and the cutover checklist. (Arjun adds
  // the screen recording himself in the product video; it's in demo-assets too.)
  if (goLive) {
    const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "demo-assets");
    const dir = path.resolve(process.env.UPLOAD_DIR || "uploads");
    await mkdir(dir, { recursive: true });
    const files: [string, string, string][] = [
      ["routing-dashboard.png", "image/png", "IMAGE"],
      ["cutover-checklist.pdf", "application/pdf", "DOCUMENT"],
    ];
    for (const [name, mimeType, kind] of files) {
      const source = path.join(assets, name);
      const storageKey = `${randomUUID()}${path.extname(name)}`;
      await copyFile(source, path.join(dir, storageKey));
      await prisma.attachment.create({ data: { entryId: goLive, uploaderId: arjun.id, fileName: name, mimeType, kind, size: (await stat(source)).size, storageKey } });
    }
  }

  // An alert already sent by the super admin to everyone, read by some.
  const sendDemoAlert = async (sender: { id: string; name: string }, recipients: { id: string }[], title: string, body: string, priority: string, audience: string, readBy: string[]) => {
    const alert = await prisma.alert.create({ data: { senderId: sender.id, title, body, priority, audience, recipientCount: recipients.length, createdAt: new Date(Date.now() - 26 * 3_600_000) } });
    for (const r of recipients) {
      await prisma.notification.create({
        data: {
          userId: r.id,
          kind: "ALERT",
          title: `${priority === "URGENT" ? "Urgent: " : ""}${title}`,
          body: `${body}\n\nFrom ${sender.name}`,
          createdById: sender.id,
          alertId: alert.id,
          readAt: readBy.includes(r.id) ? new Date() : null,
          createdAt: alert.createdAt,
        },
      });
    }
  };
  if (superAdmin) {
    await sendDemoAlert(superAdmin, [lead, priya, arjun, meera], "Timesheets close Friday 5pm", "Month-end billing runs on Friday evening. Please log and submit all of this week's time by 5pm.", "NORMAL", "Everyone", [lead.id, priya.id]);
  }

  console.log(`Demo data ready: ${rows.length} entries.`);
  console.log("  Project lead  vikram@rnxadigital.com (verifies Priya, Arjun, Meera; Priya's leave waits for him)");
  console.log("  Behind        meera@rnxadigital.com (needs attention in Team reports)");
  console.log("  Employees     priya@, arjun@, meera@rnxadigital.com");
  console.log("  Password      DEMO_PASSWORD from .env");
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
