import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { actorOf, decide, loadConversation, sendMessage, type Emit, type TurnResult, type UiItem } from "../assistant/agent.js";
import { currentUser } from "../auth.js";
import { prisma } from "../db.js";
import { HttpError, idParam } from "../errors.js";

export const assistantRouter = Router();

const burst = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (req) => req.user?.id ?? "anonymous",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  message: { error: { code: "USER_LIMIT", message: "Too many assistant requests. Please wait a moment." } },
});

/**
 * Runs a turn. With `Accept: text/event-stream` the reply streams as
 * server-sent events (text deltas, screen effects, then the final result);
 * otherwise the final result is returned as JSON.
 */
async function respond(req: Request, res: Response, run: (emit?: Emit) => Promise<TurnResult>) {
  if (!req.get("accept")?.includes("text/event-stream")) {
    res.json(await run());
    return;
  }
  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await run((e) => send(e));
    send({ type: "done", result });
  } catch (error) {
    const e = error instanceof HttpError ? error : null;
    if (!e) console.error("[assistant] stream error", error);
    send({ type: "error", error: { code: e?.code ?? "INTERNAL", message: e?.message ?? "Something went wrong." } });
  } finally {
    res.end();
  }
}

/** The user's most recent conversation from the last 12 hours, so a refresh keeps context. */
assistantRouter.get("/assistant/conversation", async (req, res) => {
  const user = currentUser(req);
  const convo = await prisma.assistantConversation.findFirst({
    where: { userId: user.id, actorId: actorOf(user), updatedAt: { gte: new Date(Date.now() - 12 * 3600_000) } },
    orderBy: { updatedAt: "desc" },
  });
  res.json(convo ? { conversationId: convo.id, ui: JSON.parse(convo.ui) as UiItem[], hasPending: !!convo.pending } : { conversationId: null, ui: [], hasPending: false });
});

const messageSchema = z.object({
  conversationId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(),
  text: z.string().trim().min(1).max(4000),
  mode: z.enum(["voice", "chat"]).optional(),
  page: z.string().max(300).optional(),
});

assistantRouter.post("/assistant/message", burst, async (req, res) => {
  const user = currentUser(req);
  const { conversationId, text, mode, page } = messageSchema.parse(req.body);
  await respond(req, res, (emit) => sendMessage(user, conversationId ?? undefined, text, { mode, page }, emit));
});

assistantRouter.post("/assistant/:id/decide", burst, async (req, res) => {
  const user = currentUser(req);
  const id = idParam(req.params.id);
  const { decisions, mode } = z.object({ decisions: z.record(z.enum(["approve", "decline"])), mode: z.enum(["voice", "chat"]).optional() }).parse(req.body);
  await respond(req, res, (emit) => decide(user, id, decisions, emit, mode));
});

assistantRouter.delete("/assistant/:id", async (req, res) => {
  const user = currentUser(req);
  const convo = await loadConversation(user, idParam(req.params.id));
  await prisma.assistantConversation.delete({ where: { id: convo.id } });
  res.json({ ok: true });
});
