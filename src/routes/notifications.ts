import { Router } from "express";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { idParam } from "../errors.js";

export const notificationsRouter = Router();

notificationsRouter.get("/notifications", async (req, res) => {
  const user = currentUser(req);
  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  res.json({ notifications, unread });
});

notificationsRouter.post("/notifications/read-all", async (req, res) => {
  const user = currentUser(req);
  await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

notificationsRouter.post("/notifications/:id/read", async (req, res) => {
  const user = currentUser(req);
  // Scoped to the owner, so another user's id simply matches nothing.
  await prisma.notification.updateMany({ where: { id: idParam(req.params.id), userId: user.id }, data: { readAt: new Date() } });
  res.json({ ok: true });
});
