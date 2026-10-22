// Manager/admin review queue. Every query is constrained to the reviewer's scope.
import { Router } from "express";
import { z } from "zod";
import { currentUser, requireRole } from "../auth.js";
import { prisma } from "../db.js";
import { STATUSES, objectId } from "../domain.js";
import { ISO_DATE } from "../services/dates.js";
import { reviewScopeWhere } from "../services/scope.js";
import { entryInclude, reviewEntries } from "../services/timesheet.js";

export const reviewsRouter = Router();
reviewsRouter.use(requireRole("ADMIN", "MANAGER"));

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  userId: objectId.optional(),
  projectId: objectId.optional(),
});

reviewsRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const q = listSchema.parse(req.query);
  const scope = await reviewScopeWhere(user);
  const entries = await prisma.timesheetEntry.findMany({
    where: {
      AND: [
        scope,
        { userId: { not: user.id } },
        q.status ? { status: q.status } : { status: { not: "DRAFT" } },
        q.from || q.to ? { workDate: { gte: q.from, lte: q.to } } : {},
        q.userId ? { userId: q.userId } : {},
        q.projectId ? { projectId: q.projectId } : {},
      ],
    },
    include: entryInclude,
    orderBy: [{ submittedAt: "asc" }, { workDate: "asc" }],
    take: 500,
  });
  res.json({ entries });
});

const actionSchema = z.object({
  ids: z.array(objectId).min(1).max(200),
  action: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "REOPEN"]),
  comment: z.string().max(1000).optional(),
});

reviewsRouter.post("/actions", async (req, res) => {
  const user = currentUser(req);
  const { ids, action, comment } = actionSchema.parse(req.body);
  const count = await reviewEntries(user, ids, action, comment);
  res.json({ updated: count });
});
