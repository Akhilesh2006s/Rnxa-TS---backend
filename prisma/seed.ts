// Local development seed.
// Always: org policy and the super admin (from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD).
// Only with SEED_DEMO=true: demo users, projects, phases, assignments and entries.
// Never run against production.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Password for every seeded demo account, from SEED_PASSWORD (never stored in source).
const PASSWORD = process.env.SEED_PASSWORD ?? "";

function isoDate(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed in production.");
  await prisma.orgPolicy.upsert({ where: { id: "org" }, update: {}, create: { id: "org" } });

  // Super admin: full organisation access (ADMIN role), credentials from the
  // environment so the password never lives in source. Re-running the seed resets it.
  const superEmail = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  const superPassword = process.env.SUPERADMIN_PASSWORD;
  if (superEmail && superPassword) {
    if (superPassword.length < 12) throw new Error("SUPERADMIN_PASSWORD must be at least 12 characters.");
    const hash = await bcrypt.hash(superPassword, 12);
    await prisma.user.upsert({
      where: { email: superEmail },
      update: { role: "ADMIN", active: true, passwordHash: hash },
      create: { email: superEmail, name: "Super Admin", role: "ADMIN", passwordHash: hash },
    });
    console.log(`  ADMIN    ${superEmail} (super admin, password from SUPERADMIN_PASSWORD)`);
  }

  if (process.env.SEED_DEMO === "true") await seedDemo();
  else console.log("Demo data skipped (set SEED_DEMO=true to add demo users and projects).");
}

async function seedDemo() {
  if (PASSWORD.length < 10) throw new Error("Set SEED_PASSWORD (10+ characters) to seed demo accounts.");
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const users = {
    admin: { email: "admin@rnxadigital.com", name: "Aditi Rao", role: "ADMIN" },
    manager: { email: "manager@rnxadigital.com", name: "Vikram Shah", role: "MANAGER" },
    priya: { email: "priya@rnxadigital.com", name: "Priya Nair", role: "EMPLOYEE" },
    arjun: { email: "arjun@rnxadigital.com", name: "Arjun Mehta", role: "EMPLOYEE" },
  } as const;

  const ids: Record<string, string> = {};
  for (const [key, u] of Object.entries(users)) {
    const row = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash },
    });
    ids[key] = row.id;
  }

  const projects = [
    { code: "CPQ-ACME", name: "Acme Revenue Cloud rollout", client: "Acme Corp", phases: ["Discovery", "Design", "Build", "UAT", "Hypercare"] },
    { code: "AGT-OPS", name: "Agentic service desk", client: "Northwind", phases: ["Discovery", "Build", "Pilot"] },
    { code: "INT-ADMIN", name: "Internal administration", client: null, phases: [] },
  ];

  const projectIds: Record<string, string> = {};
  for (const p of projects) {
    const project = await prisma.project.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, name: p.name, client: p.client, phasesEnabled: p.phases.length > 0 },
    });
    projectIds[p.code] = project.id;
    for (const [i, name] of p.phases.entries()) {
      await prisma.phase.upsert({
        where: { projectId_name: { projectId: project.id, name } },
        update: {},
        create: { projectId: project.id, name, sortOrder: i },
      });
    }
  }

  const assign = async (userKey: string, code: string, role: "MEMBER" | "REVIEWER") => {
    const data = { userId: ids[userKey], projectId: projectIds[code], role };
    await prisma.projectAssignment.upsert({ where: { userId_projectId_role: data }, update: {}, create: data });
  };
  await assign("priya", "CPQ-ACME", "MEMBER");
  await assign("priya", "INT-ADMIN", "MEMBER");
  await assign("arjun", "CPQ-ACME", "MEMBER");
  await assign("arjun", "AGT-OPS", "MEMBER");
  await assign("arjun", "INT-ADMIN", "MEMBER");
  await assign("manager", "CPQ-ACME", "REVIEWER");
  await assign("manager", "CPQ-ACME", "MEMBER");
  await assign("manager", "INT-ADMIN", "MEMBER");

  // A few submitted entries from last week so the review queue is not empty.
  if ((await prisma.timesheetEntry.count()) === 0) {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 7);
    const build = await prisma.phase.findFirstOrThrow({ where: { projectId: projectIds["CPQ-ACME"], name: "Build" } });
    const pilot = await prisma.phase.findFirstOrThrow({ where: { projectId: projectIds["AGT-OPS"], name: "Pilot" } });
    for (let i = 0; i < 5; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      const workDate = isoDate(day);
      await prisma.timesheetEntry.create({
        data: {
          userId: ids.arjun,
          projectId: projectIds["CPQ-ACME"],
          phaseId: build.id,
          workDate,
          minutes: 300,
          description: "Configured CPQ price rules and product bundles for the Acme quote template.",
          status: "SUBMITTED",
          submittedAt: new Date(),
        },
      });
      await prisma.timesheetEntry.create({
        data: {
          userId: ids.arjun,
          projectId: projectIds["AGT-OPS"],
          phaseId: pilot.id,
          workDate,
          minutes: 180,
          description: "Reviewed pilot feedback on agent triage accuracy with the Northwind team.",
          status: "SUBMITTED",
          submittedAt: new Date(),
        },
      });
    }
  }

  console.log(`Demo data seeded. Demo accounts use the password from SEED_PASSWORD:`);
  for (const u of Object.values(users)) console.log(`  ${u.role.padEnd(8)} ${u.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
