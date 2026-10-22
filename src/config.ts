import "dotenv/config";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be an integer`);
  return value;
}

const sessionSecret = process.env.SESSION_SECRET ?? "";
if (sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must be set to at least 32 characters");
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: int("PORT", 4000),
  trustProxyHops: int("TRUST_PROXY_HOPS", 1),
  sessionSecret,
  sessionTtlHours: int("SESSION_TTL_HOURS", 8),
  // The one account allowed to view the app as other users.
  superAdminEmail: (process.env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase(),
  attachments: {
    // Where uploaded files are kept. Use a persistent volume (or swap in object storage) in production.
    dir: process.env.UPLOAD_DIR || "uploads",
    maxBytes: int("ATTACHMENT_MAX_MB", 50) * 1024 * 1024,
    maxPerEntry: int("ATTACHMENT_MAX_PER_ENTRY", 10),
  },
  rewrite: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.REWRITE_MODEL || "claude-opus-5-5",
    timeoutMs: int("REWRITE_TIMEOUT_MS", 20_000),
    maxInputChars: int("REWRITE_MAX_INPUT_CHARS", 2_000),
    maxOutputTokens: int("REWRITE_MAX_OUTPUT_TOKENS", 4_000),
    userHourlyLimit: int("REWRITE_USER_HOURLY_LIMIT", 30),
    monthlyTokenBudget: int("REWRITE_MONTHLY_TOKEN_BUDGET", 2_000_000),
  },
  assistant: {
    // Sonnet 5.5 with thinking off answers in about a second and handles tool use well.
    // Set claude-opus-5-5 for deeper reasoning (it always thinks, so it is slower).
    model: process.env.ASSISTANT_MODEL || "claude-sonnet-5-5",
    // Voice conversations favour speed: Haiku 5.5 starts speaking in about 1.5s.
    voiceModel: process.env.ASSISTANT_VOICE_MODEL || "claude-haiku-5-5",
    // "off" = no extended thinking where the model allows it (fastest); "adaptive" = think when useful.
    thinking: (process.env.ASSISTANT_THINKING || "off") as "off" | "adaptive",
    // low | medium | high. Low keeps voice replies quick; raise for deeper analysis.
    effort: (process.env.ASSISTANT_EFFORT || "low") as "low" | "medium" | "high",
    timeoutMs: int("ASSISTANT_TIMEOUT_MS", 60_000),
    maxSteps: int("ASSISTANT_MAX_STEPS", 8),
    userHourlyLimit: int("ASSISTANT_USER_HOURLY_LIMIT", 60),
    monthlyTokenBudget: int("ASSISTANT_MONTHLY_TOKEN_BUDGET", 20_000_000),
  },
};

export const isProduction = config.env === "production";
