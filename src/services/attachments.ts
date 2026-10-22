// Files attached to time entries: photos, videos and documents. Files are
// kept on disk under config.attachments.dir; the database holds metadata.
//
// The file type is decided by the extension against an allowlist, never by
// what the browser claims, and files are served back with that fixed type,
// `nosniff`, and (except PDFs) a sandbox policy so nothing in them can run.
import { createWriteStream } from "node:fs";
import { mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { HttpError, badRequest } from "../errors.js";

export type AttachmentKind = "IMAGE" | "VIDEO" | "DOCUMENT";

const TYPES: Record<string, { mime: string; kind: AttachmentKind }> = {
  ".jpg": { mime: "image/jpeg", kind: "IMAGE" },
  ".jpeg": { mime: "image/jpeg", kind: "IMAGE" },
  ".png": { mime: "image/png", kind: "IMAGE" },
  ".gif": { mime: "image/gif", kind: "IMAGE" },
  ".webp": { mime: "image/webp", kind: "IMAGE" },
  ".mp4": { mime: "video/mp4", kind: "VIDEO" },
  ".webm": { mime: "video/webm", kind: "VIDEO" },
  ".mov": { mime: "video/quicktime", kind: "VIDEO" },
  ".pdf": { mime: "application/pdf", kind: "DOCUMENT" },
  ".doc": { mime: "application/msword", kind: "DOCUMENT" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "DOCUMENT" },
  ".xls": { mime: "application/vnd.ms-excel", kind: "DOCUMENT" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "DOCUMENT" },
  ".ppt": { mime: "application/vnd.ms-powerpoint", kind: "DOCUMENT" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "DOCUMENT" },
  ".txt": { mime: "text/plain; charset=utf-8", kind: "DOCUMENT" },
  ".csv": { mime: "text/csv; charset=utf-8", kind: "DOCUMENT" },
};

export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

/** Statuses on which the owner can still add or remove files (until verified). */
export const ATTACHABLE_STATUSES = ["DRAFT", "SUBMITTED", "CHANGES_REQUESTED"];

export function uploadDir() {
  return path.resolve(config.attachments.dir);
}

export function fileTypeFor(fileName: string) {
  return TYPES[path.extname(fileName).toLowerCase()] ?? null;
}

/** Display name from the X-File-Name header: no path parts or control characters. */
export function cleanFileName(raw: string | undefined): string {
  let name: string;
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    throw badRequest("Invalid file name.");
  }
  name = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  if (!name) throw badRequest("The file needs a name.");
  return name.slice(0, 200);
}

function tooLarge() {
  return new HttpError(413, "TOO_LARGE", `Files can be up to ${Math.round(config.attachments.maxBytes / 1024 / 1024)} MB.`);
}

/** Streams the request body to disk, stopping once it passes the size limit. */
export async function saveUpload(req: Request, ext: string): Promise<{ storageKey: string; size: number }> {
  if (Number(req.get("content-length") ?? 0) > config.attachments.maxBytes) throw tooLarge();
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const storageKey = `${randomUUID()}${ext}`;
  const target = path.join(dir, storageKey);
  const size = await new Promise<number>((resolve, reject) => {
    let bytes = 0;
    let failed = false;
    const out = createWriteStream(target, { flags: "wx" });
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      unlink(target).catch(() => undefined);
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > config.attachments.maxBytes) {
        fail(tooLarge());
        req.resume();
      }
    });
    req.on("aborted", () => fail(badRequest("The upload was interrupted.")));
    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (!failed) resolve(bytes);
    });
    req.pipe(out);
  });
  if (size === 0) {
    await unlink(target).catch(() => undefined);
    throw badRequest("The file is empty.");
  }
  return { storageKey, size };
}

export async function removeStoredFiles(keys: string[]) {
  const dir = uploadDir();
  await Promise.all(keys.map((k) => rm(path.join(dir, path.basename(k)), { force: true })));
}

/** Deletes the attachments (rows and files) of the given entries. */
export async function deleteAttachmentsFor(entryIds: string[]) {
  if (!entryIds.length) return;
  const rows = await prisma.attachment.findMany({ where: { entryId: { in: entryIds } }, select: { storageKey: true } });
  await prisma.attachment.deleteMany({ where: { entryId: { in: entryIds } } });
  await removeStoredFiles(rows.map((r) => r.storageKey));
}
