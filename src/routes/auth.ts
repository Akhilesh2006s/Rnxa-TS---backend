import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clearSessionCookie, currentUser, hashPassword, isSuperAdminAccount, requireAuth, setSessionCookie, verifyPassword } from "../auth.js";
import { prisma } from "../db.js";
import { objectId, type Role } from "../domain.js";
import { effectivePermissions } from "../services/permissions.js";
import { HttpError, badRequest, forbidden, notFound } from "../errors.js";
import { recordAudit } from "../services/audit.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: { code: "TOO_MANY_ATTEMPTS", message: "Too many sign-in attempts. Try again in a few minutes." } },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  // Always run a hash comparison so response time does not reveal valid emails.
  const ok = await verifyPassword(password, user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
  if (!user || !user.active || !ok) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  setSessionCookie(res, user.id);
  await recordAudit({ actorId: user.id, action: "USER_LOGIN", entityType: "User", entityId: user.id });
  const isSuperAdmin = isSuperAdminAccount(user);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isSuperAdmin,
      permissions: await effectivePermissions({ role: user.role as Role, isSuperAdmin, extra: user.permissions }),
    },
  });
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(10, "The new password must be at least 10 characters.").max(200),
  })
  .refine((v) => v.newPassword !== v.currentPassword, { message: "Choose a password different from the current one.", path: ["newPassword"] });

/** Signed-in users change their own password; the current one is required. */
authRouter.post("/password", loginLimiter, requireAuth, async (req, res) => {
  const user = currentUser(req);
  if (user.impersonator) throw forbidden("Return to your own view to change your password.");
  const { currentPassword, newPassword } = passwordChangeSchema.parse(req.body);
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
    throw new HttpError(400, "WRONG_PASSWORD", "Your current password is incorrect.");
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  await recordAudit({ actorId: user.id, action: "PASSWORD_CHANGE", entityType: "User", entityId: user.id });
  res.json({ ok: true });
});

/** Who is signed in. Answers { user: null } (not an error) before sign-in, so the page can check quietly. */
authRouter.get("/me", (req, res) => {
  res.json({ user: req.user ?? null });
});

/** Super admin only: view and use the app as another user. Audited on both ends. */
authRouter.post("/impersonate", requireAuth, async (req, res) => {
  const current = currentUser(req);
  const realId = current.impersonator?.id ?? current.id;
  if (!current.impersonator && !current.isSuperAdmin) throw forbidden("Only the super admin can view as other users.");
  const { userId } = z.object({ userId: objectId }).parse(req.body);
  if (userId === realId) throw badRequest("That's your own account.");
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || !target.active) throw notFound("User not found or inactive.");
  setSessionCookie(res, realId, target.id);
  await recordAudit({ actorId: realId, action: "IMPERSONATE_START", entityType: "User", entityId: target.id, changes: { email: target.email } });
  res.json({ user: { id: target.id, email: target.email, name: target.name, role: target.role, impersonator: current.impersonator ?? { id: current.id, name: current.name, email: current.email } } });
});

authRouter.post("/impersonate/stop", requireAuth, async (req, res) => {
  const current = currentUser(req);
  if (!current.impersonator) throw badRequest("You are not viewing as another user.");
  setSessionCookie(res, current.impersonator.id);
  await recordAudit({ actorId: current.impersonator.id, action: "IMPERSONATE_STOP", entityType: "User", entityId: current.id });
  res.json({ ok: true });
});
