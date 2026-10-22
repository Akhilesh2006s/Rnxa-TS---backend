// Deletes all application data except the super admin account (SUPERADMIN_EMAIL).
// Usage: npm run db:clear -- --yes      (refuses in production)
import { rm } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to clear data in production.");
  const keepEmail = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  if (!keepEmail) throw new Error("Set SUPERADMIN_EMAIL so the super admin account is kept.");
  const keep = await prisma.user.findUnique({ where: { email: keepEmail } });
  if (!keep) throw new Error(`Super admin ${keepEmail} not found. Run the seed first.`);

  const before = await counts();
  console.log("Before:", before);
  if (!process.argv.includes("--yes")) {
    console.log("Dry run. Re-run with --yes to delete everything above except the super admin.");
    return;
  }

  // Children before parents.
  await prisma.attachment.deleteMany({});
  await prisma.leaveRequest.deleteMany({});
  await prisma.alert.deleteMany({});
  await prisma.holiday.deleteMany({});
  await rm(path.resolve(process.env.UPLOAD_DIR || "uploads"), { recursive: true, force: true });
  await prisma.approvalAction.deleteMany({});
  await prisma.timesheetEntry.deleteMany({});
  await prisma.projectAssignment.deleteMany({});
  await prisma.phase.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.assistantConversation.deleteMany({});
  await prisma.auditEvent.deleteMany({});
  await prisma.rewriteMetric.deleteMany({});
  // Unlink verifiers first: users point at each other through verifierId.
  await prisma.user.updateMany({ where: { verifierId: { not: null } }, data: { verifierId: null } });
  await prisma.user.deleteMany({ where: { id: { not: keep.id } } });
  console.log("After:", await counts());
}

async function counts() {
  return {
    users: await prisma.user.count(),
    projects: await prisma.project.count(),
    phases: await prisma.phase.count(),
    assignments: await prisma.projectAssignment.count(),
    entries: await prisma.timesheetEntry.count(),
    approvalActions: await prisma.approvalAction.count(),
    notifications: await prisma.notification.count(),
    conversations: await prisma.assistantConversation.count(),
    auditEvents: await prisma.auditEvent.count(),
    metrics: await prisma.rewriteMetric.count(),
  };
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
