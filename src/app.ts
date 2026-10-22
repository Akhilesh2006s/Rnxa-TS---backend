import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { authenticate, requireAuth, requireCsrfHeader } from "./auth.js";
import { config } from "./config.js";
import { errorHandler, notFound } from "./errors.js";
import { accessRouter } from "./routes/access.js";
import { adminRouter } from "./routes/admin.js";
import { attachmentsRouter } from "./routes/attachments.js";
import { alertsRouter } from "./routes/alerts.js";
import { leaveRouter } from "./routes/leave.js";
import { reportsRouter } from "./routes/reports.js";
import { assistantRouter } from "./routes/assistant.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { entriesRouter } from "./routes/entries.js";
import { myReportRouter } from "./routes/myReport.js";
import { notificationsRouter } from "./routes/notifications.js";
import { projectDetailsRouter } from "./routes/projectDetails.js";
import { reviewsRouter } from "./routes/reviews.js";
import { rewriteRouter } from "./routes/rewrite.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Proxies in front of the API (Render adds one; a Vercel rewrite adds another), so rate limits see the real client IP.
  app.set("trust proxy", config.trustProxyHops);
  app.use(helmet());
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", requireCsrfHeader, authenticate);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/auth", authRouter);

  // Everything below requires a signed-in user.
  app.use("/api", requireAuth);
  app.use("/api", entriesRouter);
  app.use("/api", attachmentsRouter);
  app.use("/api", leaveRouter);
  app.use("/api", reportsRouter);
  app.use("/api", alertsRouter);
  app.use("/api", dashboardRouter);
  app.use("/api", rewriteRouter);
  app.use("/api", notificationsRouter);
  app.use("/api", myReportRouter);
  app.use("/api", projectDetailsRouter);
  app.use("/api", assistantRouter);
  app.use("/api/reviews", reviewsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api", accessRouter);

  app.use("/api", (_req, _res, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
