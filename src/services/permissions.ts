import type { RequestHandler } from "express";
import type { SessionUser } from "../auth.js";
import { prisma } from "../db.js";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, ROLES, type Permission, type Role } from "../domain.js";
import { HttpError, forbidden } from "../errors.js";

const parse = (csv: string) => csv.split(",").filter((p): p is Permission => (PERMISSION_KEYS as string[]).includes(p));

// Role permissions change rarely; a short cache avoids a query on every request.
let cache: { at: number; map: Record<Role, Permission[]> } | null = null;

export async function rolePermissions(): Promise<Record<Role, Permission[]>> {
  if (cache && Date.now() - cache.at < 15_000) return cache.map;
  const rows = await prisma.rolePermissions.findMany();
  const map = Object.fromEntries(
    ROLES.map((role) => {
      const row = rows.find((r) => r.role === role);
      return [role, row ? parse(row.permissions) : DEFAULT_ROLE_PERMISSIONS[role]];
    }),
  ) as Record<Role, Permission[]>;
  cache = { at: Date.now(), map };
  return map;
}

export function clearPermissionCache() {
  cache = null;
}

/** Everything a person may do: all permissions for the super admin, otherwise role + personal grants. */
export async function effectivePermissions(user: { role: Role; isSuperAdmin?: boolean; extra?: string }): Promise<Permission[]> {
  if (user.isSuperAdmin) return [...PERMISSION_KEYS];
  const byRole = (await rolePermissions())[user.role] ?? [];
  return [...new Set([...byRole, ...parse(user.extra ?? "")])];
}

export const can = (user: SessionUser, permission: Permission) => !!user.isSuperAdmin || (user.permissions ?? []).includes(permission);

/** Route guard: the signed-in user needs at least one of these permissions. */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in."));
    if (!permissions.some((p) => can(req.user!, p))) return next(forbidden("You don't have permission to do that. The super admin can grant it."));
    next();
  };
}

export async function setRolePermissions(role: Role, permissions: Permission[]) {
  await prisma.rolePermissions.upsert({ where: { role }, update: { permissions: permissions.join(",") }, create: { role, permissions: permissions.join(",") } });
  clearPermissionCache();
}
