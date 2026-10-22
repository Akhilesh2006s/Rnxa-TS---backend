import request from "supertest";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { prisma } from "../src/db.js";
import { addDays, today, weekStart } from "../src/services/dates.js";

export const app = createApp();
export const PASSWORD = "test-password-123";

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function makeUser(role: "ADMIN" | "MANAGER" | "EMPLOYEE", name = role.toLowerCase(), verifierId?: string) {
  return prisma.user.create({
    data: {
      email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${unique()}@test.local`,
      name,
      role,
      verifierId,
      passwordHash: await hashPassword(PASSWORD),
    },
  });
}

/** Updates the single org policy row used by every test. */
export function setPolicy(data: { autoVerify?: boolean; autoVerifyMaxDailyMinutes?: number; maxFutureDays?: number; workDays?: string; expectedDailyMinutes?: number }) {
  return prisma.orgPolicy.upsert({ where: { id: "org" }, update: data, create: { id: "org", ...data } });
}

export async function makeProject(phases = ["Build"]) {
  const code = `P-${unique()}`.toUpperCase();
  return prisma.project.create({
    data: {
      code,
      name: `Project ${code}`,
      phasesEnabled: phases.length > 0,
      phases: { create: phases.map((name, i) => ({ name, sortOrder: i })) },
    },
    include: { phases: true },
  });
}

export function assign(userId: string, projectId: string, role: "MEMBER" | "REVIEWER" = "MEMBER") {
  return prisma.projectAssignment.create({ data: { userId, projectId, role } });
}

/** A supertest agent signed in as the given user, sending the CSRF header. */
export async function signIn(email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").set("X-Requested-With", "rnxa-web").send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const withHeader = <T extends { set: (k: string, v: string) => T }>(r: T) => r.set("X-Requested-With", "rnxa-web");
  return {
    get: (url: string) => withHeader(agent.get(url)),
    post: (url: string) => withHeader(agent.post(url)),
    patch: (url: string) => withHeader(agent.patch(url)),
    put: (url: string) => withHeader(agent.put(url)),
    delete: (url: string) => withHeader(agent.delete(url)),
  };
}

export const thisWeek = () => weekStart(today());
export const yesterdayOrToday = () => {
  // A date inside the current week that is not in the future.
  const t = today();
  return t === thisWeek() ? t : addDays(t, -1);
};

/** The configured super admin for tests (SUPERADMIN_EMAIL in vitest.config.ts). */
export async function superAdmin() {
  return prisma.user.upsert({
    where: { email: "superadmin@test.local" },
    update: { role: "ADMIN", active: true, passwordHash: await hashPassword(PASSWORD) },
    create: { email: "superadmin@test.local", name: "Super Admin", role: "ADMIN", passwordHash: await hashPassword(PASSWORD) },
  });
}
