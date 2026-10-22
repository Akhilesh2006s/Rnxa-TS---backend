import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

/** An error that is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "BAD_REQUEST", message, details);
export const forbidden = (message = "You do not have access to this resource.") =>
  new HttpError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (message: string) => new HttpError(409, "CONFLICT", message);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Some fields are invalid.",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: "Malformed request body." } });
    return;
  }
  // Unknown errors: log server side, never leak internals to the client.
  console.error("[error]", err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
};

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Route-param id: anything that is not a MongoDB ObjectId cannot exist, so 404. */
export function idParam(value: unknown, message?: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw notFound(message);
  return value;
}
