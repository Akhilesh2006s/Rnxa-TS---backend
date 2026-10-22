import { prisma } from "../db.js";

export interface NotificationInput {
  kind: "REMINDER" | "INFO" | "ALERT";
  title: string;
  body: string;
  link?: string;
  createdById?: string | null;
  /** When set, a user never receives two notifications with the same key. */
  dedupeKey?: string;
}

/** Creates one notification per user, skipping users who already got the same dedupeKey. Returns how many were sent. */
export async function notifyUsers(userIds: string[], input: NotificationInput): Promise<number> {
  let sent = 0;
  for (const userId of new Set(userIds)) {
    const key = input.dedupeKey ? `${input.dedupeKey}:${userId}` : null;
    if (key && (await prisma.notification.findFirst({ where: { dedupeKey: key }, select: { id: true } }))) continue;
    await prisma.notification.create({
      data: {
        userId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        link: input.link,
        createdById: input.createdById ?? null,
        dedupeKey: key,
      },
    });
    sent++;
  }
  return sent;
}
