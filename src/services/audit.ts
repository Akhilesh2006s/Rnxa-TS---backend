import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requestContext } from "../requestContext.js";

type Db = Prisma.TransactionClient | typeof prisma;

export interface AuditInput {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  changes?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput, db: Db = prisma) {
  const impersonatorId = requestContext.getStore()?.impersonatorId;
  if (impersonatorId) input = { ...input, changes: { ...input.changes, impersonatedBy: impersonatorId } };
  await db.auditEvent.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes ? JSON.stringify(input.changes) : null,
    },
  });
}

/** Returns only the fields whose values differ, as { field: { from, to } }. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (after[key] !== undefined && after[key] !== before[key]) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  return changes;
}
