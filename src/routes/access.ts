// Access control: the super admin decides which roles (and which individual
// people) get each administrative permission.
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_KEYS, ROLES, type Permission } from "../domain.js";
import { forbidden, idParam, notFound } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import { clearPermissionCache, rolePermissions, setRolePermissions } from "../services/permissions.js";

export const accessRouter = Router();

accessRouter.use("/access", (req, _res, next) => {
  if (!currentUser(req).isSuperAdmin) return next(forbidden("Only the super admin can change access."));
  next();
});

accessRouter.get("/access", async (_req, res) => {
  const people = await prisma.user.findMany({
    where: { permissions: { not: "" } },
    select: { id: true, name: true, email: true, role: true, permissions: true },
    orderBy: { name: "asc" },
  });
  res.json({
    permissions: PERMISSION_KEYS.map((key) => ({ key, description: PERMISSIONS[key] })),
    roles: await rolePermissions(),
    defaults: DEFAULT_ROLE_PERMISSIONS,
    people: people.map((p) => ({ ...p, permissions: p.permissions.split(",").filter(Boolean) })),
  });
});

const listSchema = z.object({ permissions: z.array(z.enum(PERMISSION_KEYS as [Permission, ...Permission[]])) });

accessRouter.put("/access/roles/:role", async (req, res) => {
  const actor = currentUser(req);
  const role = z.enum(ROLES).parse(req.params.role);
  const { permissions } = listSchema.parse(req.body);
  const before = (await rolePermissions())[role];
  await setRolePermissions(role, permissions);
  await recordAudit({ actorId: actor.id, action: "ACCESS_ROLE_UPDATE", entityType: "Role", entityId: role, changes: { from: before, to: permissions } });
  res.json({ role, permissions });
});

accessRouter.put("/access/users/:id", async (req, res) => {
  const actor = currentUser(req);
  const id = idParam(req.params.id);
  const { permissions } = listSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("User not found.");
  await prisma.user.update({ where: { id }, data: { permissions: [...new Set(permissions)].join(",") } });
  clearPermissionCache();
  await recordAudit({ actorId: actor.id, action: "ACCESS_USER_UPDATE", entityType: "User", entityId: id, changes: { from: user.permissions, to: permissions } });
  res.json({ id, permissions });
});
