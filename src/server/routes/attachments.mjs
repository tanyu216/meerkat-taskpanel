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

import { createReadStream, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { transaction } from "../../core/index.mjs";
import { ATTACHMENTS_DIRNAME, ATTACHMENT_MAX_BYTES } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { newId } from "../../shared/ids.mjs";
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
      storeContent(board.db, board.repos.attachments, id, path, body);
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
    const { status, payload, headers } = errorResponse(err);
    sendJson(res, status, payload, headers);
  }
}

/**
 * Put the bytes and the row on disk together, and **take the write lock first**
 * (T-20261013-014304).
 *
 * The order is the whole point. This handler used to `writeFile` first and take
 * the lock second, so a PUT that lost the contention race answered 503 *after*
 * its payload had already replaced the stored file: bytes nobody would ever
 * read, on top of a row whose `size` now described a file that was no longer
 * there. GET kept serving the truth — it goes by `stat`, not by the row — so the
 * damage was quiet: disk growth and a listing that lied.
 *
 * Now the payload is written *inside* the transaction that holds the lock, to a
 * staging name beside the attachment, and only a body that has already updated
 * the row swaps it into place. Every way this write can be refused therefore
 * leaves the board exactly as it was: nothing stored, nothing staged, and a
 * `size` that still matches the bytes on disk.
 *
 * Three things are load-bearing:
 *
 *   * the body is **synchronous** on purpose. An `await` between `BEGIN
 *     IMMEDIATE` and `COMMIT` would let another request run; the unit of work
 *     turns a nested call into a SAVEPOINT, so that request would be enrolled in
 *     *this* transaction and rolled back with it — after it was answered.
 *   * the bytes go to a **staging file**, and `path` is only ever replaced by a
 *     rename. A payload that fails halfway (a full disk, say) can therefore
 *     truncate a staging file, never the attachment that is already stored.
 *   * one window is left open and it is deliberately not a contention window: if
 *     `COMMIT` itself fails *after* the body ran, the rollback restores the row
 *     while the file keeps the new bytes. The retry re-runs the body and heals
 *     that; only a budget exhausted by repeated COMMIT failures would leave the
 *     row and the disk disagreeing — and then with no bytes leaked, which is the
 *     failure this ordering exists to prevent.
 *
 * The lock is also taken like every other write takes it (R2): one transaction
 * boundary and the repository's `mapSqliteError`, so contention is retried a
 * bounded number of times and then reported as `DB_BUSY` (503 + `Retry-After`)
 * rather than escaping as the 500 a bare `.run()` produced.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{setSize: (id: string, size: number) => void}} attachments
 * @param {string} id
 * @param {string} path
 * @param {Buffer} body
 */
function storeContent(db, attachments, id, path, body) {
  const staged = `${path}.${newId()}.part`;
  try {
    transaction(
      db,
      () => {
        writeFileSync(staged, body);
        // Keeping the row's `size` honest so a listing can render it without a
        // stat is a write like any other: the trigger bumps `global_revision`,
        // so the SSE stream sees it.
        attachments.setSize(id, body.length);
        renameSync(staged, path);
      },
      { op: "attachments.setSize" },
    );
  } catch (err) {
    // A refused write leaves nothing of its own behind — the staged bytes go
    // with it. (`path` is untouched unless the swap itself succeeded.)
    //
    // The cleanup must never *replace* the failure it is cleaning up after: a
    // `DB_BUSY` that reached the client as a filesystem error would be the R2
    // bug wearing a different hat, so a cleanup that cannot run is swallowed
    // and the original error is what propagates.
    try {
      rmSync(staged, { force: true });
    } catch {
      /* the staging file is the lesser problem */
    }
    throw err;
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
