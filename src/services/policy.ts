import { prisma } from "../db.js";

export interface Policy {
  expectedDailyMinutes: number;
  workDays: number[];
  maxPastDays: number;
  maxFutureDays: number;
  longEntryMinutes: number;
  autoVerify: boolean;
  autoVerifyMaxDailyMinutes: number;
  autoReminders: boolean;
  reminderHour: number;
  leaveAllowance: { CASUAL: number; SICK: number; EARNED: number };
}

export async function getPolicy(): Promise<Policy> {
  const row = await prisma.orgPolicy.upsert({ where: { id: "org" }, update: {}, create: { id: "org" } });
  return {
    expectedDailyMinutes: row.expectedDailyMinutes,
    workDays: row.workDays.split(",").map(Number).filter((n) => n >= 1 && n <= 7),
    maxPastDays: row.maxPastDays,
    maxFutureDays: row.maxFutureDays,
    longEntryMinutes: row.longEntryMinutes,
    autoVerify: row.autoVerify,
    autoVerifyMaxDailyMinutes: row.autoVerifyMaxDailyMinutes,
    autoReminders: row.autoReminders,
    reminderHour: row.reminderHour,
    leaveAllowance: { CASUAL: row.casualLeaveDays, SICK: row.sickLeaveDays, EARNED: row.earnedLeaveDays },
  };
}
