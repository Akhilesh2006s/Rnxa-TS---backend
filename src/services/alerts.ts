// Sending alerts down the hierarchy, shared by the API and the AI assistant.
import { z } from "zod";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { ROLES, objectId } from "../domain.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { recordAudit } from "./audit.js";

const ROLE_LABEL = { ADMIN: "All admins", MANAGER: "All managers", EMPLOYEE: "All employees" } as const;

export const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone") }),
  z.object({ type: z.literal("role"), role: z.enum(ROLES) }),
  z.object({ type: z.literal("team"), managerId: objectId.optional() }),
  z.object({ type: z.literal("people"), userIds: z.array(objectId).min(1).max(500) }),
]);
export type Audience = z.infer<typeof audienceSchema>;

export const alertSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  priority: z.enum(["NORMAL", "URGENT"]).default("NORMAL"),
  audience: audienceSchema,
});
export type AlertInput = z.infer<typeof alertSchema>;

export function assertCanSend(user: SessionUser) {
  if (user.role === "EMPLOYEE") throw forbidden("Only managers and admins can send alerts.");
}

/**
 * Who an audience reaches for this sender. Admins (and the super admin) can
 * reach anyone; managers only the people they verify.
 */
export async function resolveAudience(user: SessionUser, a: Audience): Promise<{ recipients: { id: string; name: string }[]; label: string }> {
  assertCanSend(user);
  const admin = user.role === "ADMIN";
  const select = { id: true, name: true } as const;
  if (a.type === "everyone" || a.type === "role") {
    if (!admin) throw forbidden("Managers can alert their own team.");
    const recipients = await prisma.user.findMany({ where: { active: true, id: { not: user.id }, ...(a.type === "role" ? { role: a.role } : {}) }, select });
    return { recipients, label: a.type === "role" ? ROLE_LABEL[a.role] : "Everyone" };
  }
  if (a.type === "team") {
    const managerId = a.managerId ?? user.id;
    if (managerId !== user.id && !admin) throw forbidden();
    const manager = managerId === user.id ? { name: user.name } : await prisma.user.findUnique({ where: { id: managerId }, select: { name: true } });
    if (!manager) throw notFound("Manager not found.");
    const recipients = await prisma.user.findMany({ where: { active: true, verifierId: managerId }, select });
    return { recipients, label: managerId === user.id ? "My team" : `${manager.name}'s team` };
  }
  const ids = [...new Set(a.userIds)].filter((id) => id !== user.id);
  const recipients = await prisma.user.findMany({ where: { active: true, id: { in: ids }, ...(admin ? {} : { verifierId: user.id }) }, select });
  if (recipients.length !== ids.length) throw forbidden(admin ? "Some of those people aren't active." : "You can only alert people you verify.");
  const names = recipients.map((r) => r.name);
  return { recipients, label: names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others` };
}

/** Creates the alert and one notification per recipient (their read receipt). */
export async function sendAlert(user: SessionUser, input: AlertInput) {
  const { recipients, label } = await resolveAudience(user, input.audience);
  if (!recipients.length) throw badRequest("Nobody matches that audience.");
  const alert = await prisma.alert.create({
    data: { senderId: user.id, title: input.title, body: input.body, priority: input.priority, audience: label, recipientCount: recipients.length },
  });
  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      userId: r.id,
      kind: "ALERT",
      title: `${input.priority === "URGENT" ? "Urgent: " : ""}${input.title}`,
      body: `${input.body}\n\nFrom ${user.name}`,
      link: null,
      createdById: user.id,
      alertId: alert.id,
      // Set explicitly: unread means readAt is null, and createMany leaves unset fields out.
      readAt: null,
    })),
  });
  await recordAudit({ actorId: user.id, action: "ALERT_SEND", entityType: "Alert", entityId: alert.id, changes: { audience: label, recipients: recipients.length, priority: input.priority } });
  return alert;
}
