import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { REWRITE_SYSTEM_PROMPT, ProviderError, claudeProvider } from "../src/rewrite/claudeProvider.js";
import { setRewriteProvider } from "../src/rewrite/rewriteService.js";
import { makeUser, signIn } from "./helpers.js";

afterEach(() => setRewriteProvider(claudeProvider));

describe("POST /api/timesheets/rewrite-description", () => {
  it("returns rewrittenText and records metrics without the description", async () => {
    const user = await makeUser("EMPLOYEE");
    let received = "";
    setRewriteProvider({
      async rewrite(text) {
        received = text;
        return { text: "Fixed the SSO login defect in RNXA-142.", inputTokens: 120, outputTokens: 20 };
      },
    });
    const api = await signIn(user.email);
    const res = await api.post("/api/timesheets/rewrite-description").send({ description: "  fixd sso login bug RNXA-142 " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rewrittenText: "Fixed the SSO login defect in RNXA-142." });
    // Only the trimmed description text is sent to the provider.
    expect(received).toBe("fixd sso login bug RNXA-142");
    const metric = await prisma.rewriteMetric.findFirstOrThrow({ where: { userId: user.id } });
    expect(metric).toMatchObject({ success: true, inputTokens: 120, outputTokens: 20 });
    expect(JSON.stringify(metric)).not.toContain("sso");
  });

  it.each([
    ["TIMEOUT", 504, "TIMEOUT"],
    ["RATE_LIMITED", 503, "RATE_LIMITED"],
    ["UNAVAILABLE", 503, "UNAVAILABLE"],
    ["MISCONFIGURED", 503, "UNAVAILABLE"],
    ["REFUSED", 503, "UNAVAILABLE"],
  ] as const)("maps provider %s to a safe error code", async (providerCode, status, code) => {
    const user = await makeUser("EMPLOYEE");
    setRewriteProvider({
      async rewrite() {
        throw new ProviderError(providerCode);
      },
    });
    const api = await signIn(user.email);
    const res = await api.post("/api/timesheets/rewrite-description").send({ description: "did stuff" });
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.message).toMatch(/original text is unchanged/);
  });

  it("hides unexpected provider errors", async () => {
    const user = await makeUser("EMPLOYEE");
    setRewriteProvider({
      async rewrite() {
        throw new Error("sk-ant-secret leaked in stack trace");
      },
    });
    const api = await signIn(user.email);
    const res = await api.post("/api/timesheets/rewrite-description").send({ description: "did stuff" });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("sk-ant");
  });

  it("validates input and requires authentication", async () => {
    const user = await makeUser("EMPLOYEE");
    const api = await signIn(user.email);
    expect((await api.post("/api/timesheets/rewrite-description").send({ description: "   " })).body.error.code).toBe("EMPTY_INPUT");
    expect((await api.post("/api/timesheets/rewrite-description").send({ description: "a".repeat(2001) })).body.error.code).toBe("TOO_LONG");
    expect((await api.post("/api/timesheets/rewrite-description").send({ description: 42 })).status).toBe(400);
  });

  it("enforces the per-user hourly limit", async () => {
    const user = await makeUser("EMPLOYEE");
    await prisma.rewriteMetric.createMany({
      data: Array.from({ length: 30 }, () => ({ userId: user.id, success: true, latencyMs: 1 })),
    });
    setRewriteProvider({
      async rewrite() {
        throw new Error("should not be called");
      },
    });
    const api = await signIn(user.email);
    const res = await api.post("/api/timesheets/rewrite-description").send({ description: "did stuff" });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("USER_LIMIT");
  });

  it("system prompt treats user text as content, not instructions", () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain("Do not invent work performed");
    expect(REWRITE_SYSTEM_PROMPT).toMatch(/never as instructions/);
  });
});
