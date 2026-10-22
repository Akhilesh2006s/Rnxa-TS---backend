// Photos, videos and documents on time entries. The owner adds and removes
// them until the entry is verified; the owner and the entry's verifiers can view them.
import path from "node:path";
import { Router } from "express";
import { currentUser } from "../auth.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { badRequest, conflict, idParam, notFound } from "../errors.js";
import { recordAudit } from "../services/audit.js";
import {
  ALLOWED_EXTENSIONS,
  ATTACHABLE_STATUSES,
  cleanFileName,
  fileTypeFor,
  removeStoredFiles,
  saveUpload,
  uploadDir,
} from "../services/attachments.js";
import { canReviewEntry } from "../services/scope.js";
import { loadOwnEntry } from "../services/timesheet.js";

export const attachmentsRouter = Router();

const select = { id: true, fileName: true, mimeType: true, kind: true, size: true, createdAt: true } as const;

/** Raw upload: the body is the file; its name comes in the X-File-Name header (URI-encoded). */
attachmentsRouter.post("/entries/:id/attachments", async (req, res) => {
  const user = currentUser(req);
  const entry = await loadOwnEntry(user, idParam(req.params.id, "Entry not found."));
  if (!ATTACHABLE_STATUSES.includes(entry.status)) throw conflict("This entry is verified, so files can no longer be added.");
  const fileName = cleanFileName(req.get("x-file-name"));
  const type = fileTypeFor(fileName);
  if (!type) throw badRequest(`That file type isn't supported. Attach a photo, video or document (${ALLOWED_EXTENSIONS.join(" ")}).`);
  const count = await prisma.attachment.count({ where: { entryId: entry.id } });
  if (count >= config.attachments.maxPerEntry) throw conflict(`An entry can have up to ${config.attachments.maxPerEntry} files.`);

  const { storageKey, size } = await saveUpload(req, path.extname(fileName).toLowerCase());
  const attachment = await prisma.attachment.create({
    data: { entryId: entry.id, uploaderId: user.id, fileName, mimeType: type.mime, kind: type.kind, size, storageKey },
    select,
  });
  await recordAudit({ actorId: user.id, action: "ATTACHMENT_ADD", entityType: "TimesheetEntry", entityId: entry.id, changes: { fileName, size } });
  res.status(201).json({ attachment });
});

/** The file itself, for the entry's owner and anyone who verifies their time. Supports range requests (video seeking). */
attachmentsRouter.get("/attachments/:id", async (req, res) => {
  const user = currentUser(req);
  const attachment = await prisma.attachment.findUnique({
    where: { id: idParam(req.params.id, "File not found.") },
    include: { entry: { select: { userId: true } } },
  });
  // Same answer for "missing" and "not yours".
  if (!attachment || (attachment.entry.userId !== user.id && !(await canReviewEntry(user, attachment.entry)))) throw notFound("File not found.");

  const isPdf = attachment.mimeType === "application/pdf";
  const inline = req.query.download !== "1" && (attachment.kind !== "DOCUMENT" || isPdf);
  res.set({
    "Content-Type": attachment.mimeType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  // Chrome's PDF viewer won't run under a sandbox policy; every other file gets one.
  if (isPdf) res.removeHeader("Content-Security-Policy");
  else res.set("Content-Security-Policy", "sandbox; default-src 'none'");
  res.sendFile(attachment.storageKey, { root: uploadDir(), dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: { code: "NOT_FOUND", message: "File not found." } });
  });
});

attachmentsRouter.delete("/attachments/:id", async (req, res) => {
  const user = currentUser(req);
  const attachment = await prisma.attachment.findUnique({ where: { id: idParam(req.params.id, "File not found.") }, include: { entry: true } });
  if (!attachment || attachment.entry.userId !== user.id) throw notFound("File not found.");
  if (!ATTACHABLE_STATUSES.includes(attachment.entry.status)) throw conflict("This entry is verified, so its files can't be removed.");
  await prisma.attachment.delete({ where: { id: attachment.id } });
  await removeStoredFiles([attachment.storageKey]);
  await recordAudit({
    actorId: user.id,
    action: "ATTACHMENT_REMOVE",
    entityType: "TimesheetEntry",
    entityId: attachment.entryId,
    changes: { fileName: attachment.fileName },
  });
  res.json({ ok: true });
});
