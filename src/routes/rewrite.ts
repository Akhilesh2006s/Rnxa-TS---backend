import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { currentUser } from "../auth.js";
import { rewriteDescription, type RewriteErrorCode } from "../rewrite/rewriteService.js";

export const rewriteRouter = Router();

// Burst protection in front of the per-user hourly limit in the service.
const burstLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (req) => req.user?.id ?? "anonymous",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: { code: "USER_LIMIT", message: "Too many rewrite requests. Please wait a moment." } },
});

// Only the description text is accepted; no entry, project or profile data.
const bodySchema = z.object({ description: z.string().max(10_000) });

const STATUS: Record<RewriteErrorCode, number> = {
  EMPTY_INPUT: 400,
  TOO_LONG: 400,
  USER_LIMIT: 429,
  BUDGET_EXHAUSTED: 503,
  DISABLED: 503,
  TIMEOUT: 504,
  RATE_LIMITED: 503,
  UNAVAILABLE: 503,
};

const MESSAGE: Record<RewriteErrorCode, string> = {
  EMPTY_INPUT: "Write a description first.",
  TOO_LONG: "This description is too long to rewrite.",
  USER_LIMIT: "You have reached the rewrite limit for now. Try again later.",
  BUDGET_EXHAUSTED: "Rewriting is paused for this month.",
  DISABLED: "Rewriting is turned off.",
  TIMEOUT: "The rewrite took too long.",
  RATE_LIMITED: "The rewrite service is busy.",
  UNAVAILABLE: "The rewrite service is unavailable.",
};

rewriteRouter.post("/timesheets/rewrite-description", burstLimiter, async (req, res) => {
  const user = currentUser(req);
  const { description } = bodySchema.parse(req.body);
  const outcome = await rewriteDescription(user.id, description);
  if (outcome.ok) {
    res.json({ rewrittenText: outcome.rewrittenText });
    return;
  }
  res.status(STATUS[outcome.code]).json({
    error: { code: outcome.code, message: `${MESSAGE[outcome.code]} Your original text is unchanged.` },
  });
});
