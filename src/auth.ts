import bcrypt from "bcryptjs";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { config, isProduction } from "./config.js";
import { prisma } from "./db.js";
import type { Permission, Role } from "./domain.js";
import { HttpError, forbidden } from "./errors.js";
import { requestContext } from "./requestContext.js";
import { effectivePermissions } from "./services/permissions.js";

export const SESSION_COOKIE = "rnxa_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** True only for the configured super admin, when not viewing as someone else. */
  isSuperAdmin?: boolean;
  /** Set when the super admin is viewing the app as this user. */
  impersonator?: { id: string; name: string; email: string };
  /** What this person may administer (all of it for the super admin). */
  permissions?: Permission[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

/** `impersonateId` makes the session act as another user while remembering the real one. */
export function setSessionCookie(res: Response, userId: string, impersonateId?: string) {
  const token = jwt.sign({ sub: userId, ...(impersonateId ? { imp: impersonateId } : {}) }, config.sessionSecret, {
    expiresIn: `${config.sessionTtlHours}h`,
    algorithm: "HS256",
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: config.sessionTtlHours * 3600 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Resolves the session cookie to a live user record on every request, so
 * deactivation and role changes take effect immediately.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  let impersonatorId: string | undefined;
  try {
    const payload = jwt.verify(token, config.sessionSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    const user = await prisma.user.findUnique({ where: { id: String(payload.sub) } });
    if (user?.active) {
      const isSuperAdmin = isSuperAdminAccount(user);
      if (payload.imp && isSuperAdmin) {
        const target = await prisma.user.findUnique({ where: { id: String(payload.imp) } });
        if (target?.active && target.id !== user.id) {
          req.user = {
            id: target.id,
            email: target.email,
            name: target.name,
            role: target.role as Role,
            impersonator: { id: user.id, name: user.name, email: user.email },
            // While viewing as someone, you have exactly their permissions.
            permissions: await effectivePermissions({ role: target.role as Role, extra: target.permissions }),
          };
          impersonatorId = user.id;
        }
      }
      req.user ??= {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as Role,
        isSuperAdmin,
        permissions: await effectivePermissions({ role: user.role as Role, isSuperAdmin, extra: user.permissions }),
      };
    }
  } catch {
    // Invalid or expired token: treat as anonymous.
  }
  // While impersonating, everything this request does is attributed to the real super admin in the audit log.
  if (impersonatorId) return requestContext.run({ impersonatorId }, () => next());
  next();
};

export function isSuperAdminAccount(user: { email: string; role: string; active: boolean }) {
  return !!config.superAdminEmail && user.active && user.role === "ADMIN" && user.email === config.superAdminEmail;
}

/**
 * Light CSRF defence on top of SameSite=Lax cookies: state-changing requests
 * must carry a custom header, which a cross-site form cannot set.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "rnxa-web") {
    return next(new HttpError(403, "CSRF", "Missing request header."));
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in."));
  next();
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in."));
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Narrowing helper for handlers mounted behind requireAuth. */
export function currentUser(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in.");
  return req.user;
}
