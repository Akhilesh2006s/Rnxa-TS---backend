// Governance around the rewrite provider: input limits, per-user rate limit,
// monthly token budget, and metrics that never contain description text.
import { config } from "../config.js";
import { prisma } from "../db.js";
import { claudeProvider, ProviderError, type RewriteProvider } from "./claudeProvider.js";

export type RewriteErrorCode =
  | "DISABLED"
  | "TOO_LONG"
  | "EMPTY_INPUT"
  | "USER_LIMIT"
  | "BUDGET_EXHAUSTED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export type RewriteOutcome = { ok: true; rewrittenText: string } | { ok: false; code: RewriteErrorCode };

let provider: RewriteProvider = claudeProvider;
/** Test seam: swap the provider without touching the network. */
export function setRewriteProvider(next: RewriteProvider) {
  provider = next;
}

function startOfMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function rewriteDescription(userId: string, raw: string): Promise<RewriteOutcome> {
  const description = raw.trim();
  if (!description) return { ok: false, code: "EMPTY_INPUT" };
  if (description.length > config.rewrite.maxInputChars) return { ok: false, code: "TOO_LONG" };
  if (config.rewrite.monthlyTokenBudget <= 0) return { ok: false, code: "DISABLED" };

  const hourAgo = new Date(Date.now() - 3600_000);
  const recent = await prisma.rewriteMetric.count({ where: { kind: "rewrite", userId, createdAt: { gte: hourAgo } } });
  if (recent >= config.rewrite.userHourlyLimit) return { ok: false, code: "USER_LIMIT" };

  const used = await prisma.rewriteMetric.aggregate({
    where: { kind: "rewrite", createdAt: { gte: startOfMonth() } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  if ((used._sum.inputTokens ?? 0) + (used._sum.outputTokens ?? 0) >= config.rewrite.monthlyTokenBudget) {
    return { ok: false, code: "BUDGET_EXHAUSTED" };
  }

  const started = Date.now();
  try {
    const result = await provider.rewrite(description);
    await prisma.rewriteMetric.create({
      data: {
        userId,
        success: true,
        latencyMs: Date.now() - started,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    });
    return { ok: true, rewrittenText: result.text };
  } catch (error) {
    const providerCode = error instanceof ProviderError ? error.code : "UNEXPECTED";
    await prisma.rewriteMetric.create({
      data: { userId, success: false, errorCode: providerCode, latencyMs: Date.now() - started },
    });
    if (!(error instanceof ProviderError)) console.error("[rewrite] unexpected error", (error as Error)?.name);
    if (providerCode === "MISCONFIGURED") console.error("[rewrite] provider misconfigured: check API key and model");
    const code: RewriteErrorCode =
      providerCode === "TIMEOUT" ? "TIMEOUT" : providerCode === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE";
    return { ok: false, code };
  }
}
