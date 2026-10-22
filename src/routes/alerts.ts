// Alerts sent down the hierarchy. The super admin and admins can alert
// anyone (everyone, a role, a manager's team, or chosen people); managers can
// alert the people they verify. Employees can't send alerts. Each recipient
// gets a notification; reading it is the read receipt.
import { Router } from "express";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { idParam, notFound } from "../errors.js";
import { alertSchema, assertCanSend, sendAlert } from "../services/alerts.js";

export const alertsRouter = Router();

/** Who this sender may reach, and the choices to show in the composer. */
alertsRouter.get("/alerts/options", async (req, res) => {
  const user = currentUser(req);
  assertCanSend(user);
  const broadcast = user.role === "ADMIN";
  const people = await prisma.user.findMany({
    where: { active: true, id: { not: user.id }, ...(broadcast ? {} : { verifierId: user.id }) },
    select: { id: true, name: true, role: true, verifierId: true },
    orderBy: { name: "asc" },
  });
  const managers = broadcast
    ? await prisma.user.findMany({
        where: { active: true, verifies: { some: { active: true } } },
        select: { id: true, name: true, _count: { select: { verifies: { where: { active: true } } } } },
        orderBy: { name: "asc" },
      })
    : [];
  res.json({
    broadcast,
    people: people.map(({ verifierId: _v, ...p }) => p),
    teams: managers.map((m) => ({ id: m.id, name: m.name, size: m._count.verifies })),
    myTeamSize: people.filter((p) => p.verifierId === user.id).length,
  });
});

alertsRouter.post("/alerts", async (req, res) => {
  const user = currentUser(req);
  const alert = await sendAlert(user, alertSchema.parse(req.body));
  res.status(201).json({ alert });
});

/** Alerts I sent, newest first, with how many recipients have read each. */
alertsRouter.get("/alerts/sent", async (req, res) => {
  const user = currentUser(req);
  assertCanSend(user);
  const alerts = await prisma.alert.findMany({ where: { senderId: user.id }, orderBy: { createdAt: "desc" }, take: 50 });
  const reads = await prisma.notification.groupBy({ by: ["alertId"], where: { alertId: { in: alerts.map((a) => a.id) }, readAt: { not: null } }, _count: { _all: true } });
  res.json({ alerts: alerts.map((a) => ({ ...a, readCount: reads.find((r) => r.alertId === a.id)?._count._all ?? 0 })) });
});

/** Read receipts for one alert: its sender, or the super admin. */
alertsRouter.get("/alerts/:id/receipts", async (req, res) => {
  const user = currentUser(req);
  const alert = await prisma.alert.findUnique({ where: { id: idParam(req.params.id, "Alert not found.") } });
  if (!alert || (alert.senderId !== user.id && !user.isSuperAdmin)) throw notFound("Alert not found.");
  const rows = await prisma.notification.findMany({ where: { alertId: alert.id }, select: { userId: true, readAt: true } });
  const people = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, role: true } });
  res.json({
    alert,
    receipts: rows
      .map((r) => ({ user: people.find((p) => p.id === r.userId) ?? { id: r.userId, name: "Former user", role: "" }, readAt: r.readAt }))
      .sort((x, y) => Number(!!x.readAt) - Number(!!y.readAt) || x.user.name.localeCompare(y.user.name)),
  });
});

/** My unread urgent alerts, shown as a banner until acknowledged. */
alertsRouter.get("/alerts/inbox", async (req, res) => {
  const user = currentUser(req);
  const unread = await prisma.notification.findMany({ where: { userId: user.id, kind: "ALERT", readAt: null }, orderBy: { createdAt: "desc" }, take: 10 });
  const alerts = await prisma.alert.findMany({
    where: { id: { in: unread.map((n) => n.alertId!).filter(Boolean) }, priority: "URGENT" },
    include: { sender: { select: { id: true, name: true } } },
  });
  res.json({
    urgent: unread
      .filter((n) => alerts.some((a) => a.id === n.alertId))
      .map((n) => {
        const a = alerts.find((x) => x.id === n.alertId)!;
        return { notificationId: n.id, title: a.title, body: a.body, sender: a.sender, createdAt: a.createdAt };
      }),
  });
});
