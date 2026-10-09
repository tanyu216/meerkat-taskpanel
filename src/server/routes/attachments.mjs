/**
 * `GET|PUT /api/v1/attachments/:id/content` (§5.1).
 *
 * This pair is handled **outside the router** on purpose. Everything else on the
 * board is JSON in and JSON out, which is exactly what the router's uniform
 * envelope is for; an attachment is bytes in and bytes out, and routing it
 * through `readJsonBody`/`sendJson` would be a category error. `index.mjs`
 * matches the path and calls `handleAttachmentContent` before dispatch.
 *
 * The row stays metadata (`attachments` has no content column) — the bytes live
 * in `<dataDir>/attachments/<id>`, owned by the single-writer daemon. A row with
 * no stored bytes is a truthful 404, not an error: attachments are a reserved
 * surface (§13) and most rows will never have content.
 */

import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ATTACHMENTS_DIRNAME, ATTACHMENT_MAX_BYTES } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { errorResponse, readRawBody, sendJson } from "../router.mjs";

/** Where one attachment's bytes live: `<dataDir>/attachments/<id>`. */
export function attachmentContentPath(dataDir, id) {
  // `id` is a UUID or an import id; a path separator in it must never become a
  // second path segment, so anything but a safe token is refused up front.
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return null;
  return join(dataDir, ATTACHMENTS_DIRNAME, id);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{board: object}} surface
 * @param {string} id
 */
export async function handleAttachmentContent(req, res, board, id) {
  try {
    const attachment = board.repos.attachments.get(id);
    if (attachment === null) {
      throw new DomainError("NOT_FOUND", {
        message: `no attachment ${id}`,
        details: { attachmentId: id },
      });
    }
    const path = attachmentContentPath(board.dataDir, id);
    if (path === null) {
      // Unreachable for a row that came out of the database (ids are UUIDs), but
      // a security control that assumes its input is a belt to keep fastened.
      throw new DomainError("VALIDATION_FAILED", {
        message: `attachment id ${JSON.stringify(id)} is not a safe file name`,
        details: { attachmentId: id },
      });
    }

    if (req.method === "PUT") {
      const body = await readRawBody(req, { maxBytes: ATTACHMENT_MAX_BYTES });
      await mkdir(join(board.dataDir, ATTACHMENTS_DIRNAME), { recursive: true });
      await writeFile(path, body);
      // Keep the row's `size` honest so a listing can render it without a stat.
      // This is a write like any other: the trigger bumps `global_revision`, so
      // the SSE stream sees it.
      board.db.prepare("UPDATE attachments SET size = ? WHERE id = ?").run(body.length, id);
      sendJson(res, 200, { ok: true, data: { attachment_id: id, size: body.length, stored: true } });
      return;
    }

    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new DomainError("NOT_FOUND", {
        message: `attachment ${id} has no stored content`,
        details: { attachmentId: id },
        hint: { fix: `PUT the bytes to /api/v1/attachments/${id}/content first` },
      });
    }

    res.writeHead(200, {
      "content-type": attachment.contentType ?? "application/octet-stream",
      "content-length": info.size,
      "content-disposition": `attachment; filename="${sanitizeFilename(attachment.filename)}"`,
      "cache-control": "no-store",
    });
    await pipe(createReadStream(path), res);
  } catch (err) {
    // A client that hangs up mid-download is not an error to answer — the
    // response is already on the wire, so there is nowhere to put an envelope.
    if (res.headersSent || res.writableEnded) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
      return;
    }
    const { status, payload } = errorResponse(err);
    sendJson(res, status, payload);
  }
}

/** A `"` or newline in a filename would break the header; strip the surprises. */
export function sanitizeFilename(filename) {
  return String(filename ?? "attachment").replace(/[^\w.\- ]+/g, "_");
}

function pipe(stream, res) {
  return new Promise((resolvePromise, reject) => {
    stream.on("error", reject);
    res.on("finish", resolvePromise);
    res.on("error", reject);
    stream.pipe(res);
  });
}
