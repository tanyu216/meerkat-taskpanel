/**
 * The attachment surface: `GET|PUT /api/v1/attachments/:id/content` (§5.1) plus
 * the metadata routes T-20261014-212017-4 added
 * (`POST|GET /api/v1/tasks/:ref/attachments`, `DELETE /api/v1/attachments/:id`).
 *
 * The content pair is handled **outside the router** on purpose. Everything else
 * on the board is JSON in and JSON out, which is exactly what the router's
 * uniform envelope is for; an attachment is bytes in and bytes out, and routing
 * it through `readJsonBody`/`sendJson` would be a category error. `index.mjs`
 * matches the path and calls `handleAttachmentContent` before dispatch. The
 * three metadata routes below are ordinary JSON and therefore ordinary routes.
 *
 * The row stays metadata (`attachments` has no content column) — the bytes live
 * in `<dataDir>/attachments/<id>`, owned by the single-writer daemon. A row with
 * no stored bytes is a truthful 404, not an error: attachments are a reserved
 * surface (§13) and most rows will never have content.
 *
 * ## Upload is two requests, deliberately
 *
 * `POST …/attachments` mints the row, `PUT …/content` stores the bytes. A
 * one-shot route would need a body that is both JSON and bytes, and would
 * duplicate the staging-plus-rename write discipline the content handler already
 * has (T-20261013-014304). The window between them is **named** rather than
 * hidden: a row whose `PUT` never arrives keeps `size = 0` and its download
 * answers an honest 404 — nothing is invented, and the web client rolls the row
 * back when the byte half fails (`stores/board.js#uploadAttachments`).
 *
 * ## The size ceiling is one verdict, not two
 *
 * Because the bytes half is a stream, the board can notice an over-limit file in
 * two different places — the declared `size` on the metadata route, the actual
 * bytes in `handleAttachmentContent`. They are the same refusal and they say so
 * with the same code and the same sentence
 * (`shared/attachments.mjs#attachmentTooLargeError`, T-20261015-075845-2): a
 * client that branches on the code must not have to know which half of the
 * upload got there first.
 *
 * ## Removal is a hard delete, and it is one act
 *
 * T-20261014-212017-4's ruling: an attachment is removed **for good** — the row
 * and its bytes go together. Nothing here is recoverable, and re-uploading the
 * file is the whole recovery story. The alternative (a `deleted_at` column) would
 * buy an undo the drawer does not offer while leaving the bytes on disk for a
 * reader to find, which is a worse answer to "is it gone?" than "yes".
 *
 * The pairing is the point. Bytes are renamed to a staging name and the row is
 * deleted **inside one transaction that holds the write lock**, and the staged
 * file is only discarded once that transaction has committed. So every way this
 * can be refused leaves the board as it was: a retried `DB_BUSY` re-runs the
 * body (the bytes are already staged, which the guard below tolerates), and a
 * refusal that exhausts the budget puts the bytes back before re-throwing.
 */

import { createReadStream, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { transaction } from "../../core/index.mjs";
import { attachmentTooLargeError, downloadContentType, normalizeAttachmentContentType } from "../../shared/attachments.mjs";
import { ATTACHMENTS_DIRNAME, ATTACHMENT_MAX_BYTES } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { newId } from "../../shared/ids.mjs";
import { attachmentToWire } from "../../shared/wire.mjs";
import { int, shape, str } from "../requests.mjs";
import { errorResponse, readRawBody, sendJson } from "../router.mjs";
import { resolveTask } from "./tasks.mjs";

// Declared request schemas, frozen by the contract snapshot (`routes[].request`);
// the vocabulary lives in `src/server/requests.mjs`.
//
// `kind` is **not** here. The board's attachment surface is download-only —
// every response states `content-disposition: attachment` — so `inline` has no
// writer on this surface, and the create route stores `attachment`
// unconditionally rather than accepting a value it would then have to ignore.
const CREATE_BODY = shape({ filename: str(), content_type: str(), comment_id: str(), size: int() });

/**
 * `POST|GET /api/v1/tasks/:ref/attachments` · `DELETE /api/v1/attachments/:id`.
 *
 * The three JSON halves of the attachment surface. Before them the table had no
 * writer outside the tests (`T-20261014-212017-2` G1), so the drawer could list
 * nothing, upload nothing and remove nothing.
 *
 * @param {object} router @param {{board: object}} surface
 */
export function registerAttachmentRoutes(router, surface) {
  const { board } = surface;
  const { repos } = board;

  router.post(
    "/api/v1/tasks/:ref/attachments",
    ({ params, body }) => {
      const task = resolveTask(repos, params.ref);
      const contentType = normalizeAttachmentContentType(body.content_type);
      const size = body.size === undefined ? 0 : body.size;
      if (!Number.isInteger(size) || size < 0 || size > ATTACHMENT_MAX_BYTES) {
        // The same refusal the content route raises for the same file. The
        // declared size is known exactly here, so it goes to `details.received`;
        // the message is the shared one (see `attachmentTooLargeError`).
        throw attachmentTooLargeError(ATTACHMENT_MAX_BYTES, Number.isFinite(size) ? size : null);
      }
      const attachment = repos.attachments.insert({
        taskId: task.id,
        commentId: body.comment_id ?? null,
        filename: String(body.filename),
        contentType,
        size,
        kind: "attachment",
        createdAt: new Date().toISOString(),
      });
      return { attachment: attachmentToWire(attachment), upload_url: `/api/v1/attachments/${attachment.id}/content` };
    },
    { body: CREATE_BODY },
  );

  router.get("/api/v1/tasks/:ref/attachments", ({ params }) => {
    const task = resolveTask(repos, params.ref);
    return { task_id: task.id, attachments: repos.attachments.listByTask(task.id).map(attachmentToWire) };
  });

  router.delete("/api/v1/attachments/:id", ({ params }) => {
    const id = params.id;
    const attachment = repos.attachments.get(id);
    if (attachment === null) {
      throw new DomainError("NOT_FOUND", { message: `no attachment ${id}`, details: { attachmentId: id } });
    }
    const path = attachmentContentPath(board.dataDir, id);
    if (path === null) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `attachment id ${JSON.stringify(id)} is not a safe file name`,
        details: { attachmentId: id },
      });
    }
    removeAttachmentRow(board.db, repos.attachments, id, path);
    return { removed: true, attachment: attachmentToWire(attachment) };
  });
}

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
      // The transport's own `VALIDATION_FAILED` is the right answer for a JSON
      // body the router would not take; it is the *wrong* answer here, where the
      // ceiling is the attachment's and a client branches on the code to say
      // "that file is too big" instead of falling back to a generic sentence
      // (T-20261015-075845-2, F2). The bytes path and the declared-size path
      // therefore raise one code and one sentence.
      const body = await readRawBody(req, {
        maxBytes: ATTACHMENT_MAX_BYTES,
        onOverLimit: (maxBytes) => attachmentTooLargeError(maxBytes),
      });
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

    // Three headers, three jobs, all of them the type boundary
    // (T-20261014-212017-4):
    //
    //   * `content-disposition: attachment` — the bytes are a download, never a
    //     document the origin renders. This is what makes a stored `text/plain`
    //     (or anything else that survived the create-time allow-list) inert.
    //   * `x-content-type-options: nosniff` — the browser may not second-guess
    //     the stored type and execute what it finds instead.
    //   * `cache-control: no-store` — a removed attachment must not survive in a
    //     cache after `DELETE` reports it gone.
    //
    // The filename is stripped of `"` and newlines: a value that reached the
    // header raw would let a caller write header syntax (`sanitizeFilename`).
    res.writeHead(200, {
      "content-type": downloadContentType(attachment.contentType),
      "content-length": info.size,
      "content-disposition": `attachment; filename="${sanitizeFilename(attachment.filename)}"`,
      "x-content-type-options": "nosniff",
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

/**
 * Remove an attachment **for good**: its bytes and its row, in one act.
 *
 * The order is the whole point, and it is the mirror of `storeContent`'s. The
 * bytes are renamed to a staging name and the row is deleted inside a single
 * transaction that holds the write lock; the staged file is discarded only after
 * that transaction committed. So:
 *
 *   * a refused write (a `DB_BUSY` that exhausts the retry budget, a row that
 *     vanished under us) leaves the board exactly as it was — the catch puts the
 *     bytes back, and the rollback restores the row;
 *   * a **retry** re-runs the body. The rename is the one step that is not
 *     idempotent, so it is guarded by `existsSync`: on the second pass the bytes
 *     are already staged and there is nothing left to move, which is exactly the
 *     state the commit wants;
 *   * a row with no stored bytes (the `PUT` never arrived) is the ordinary case,
 *     not an error — there is nothing to rename and the row still goes.
 *
 * A file that could not be discarded after the commit is swallowed on purpose: a
 * leftover `.part` is garbage, while a throw here would report a delete that
 * *did* happen as a failure.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{remove: (id: string) => boolean}} attachments
 * @param {string} id
 * @param {string} path
 */
function removeAttachmentRow(db, attachments, id, path) {
  const staged = `${path}.${newId()}.part`;
  let stagedBytes = false;
  try {
    transaction(
      db,
      () => {
        if (!stagedBytes && existsSync(path)) {
          renameSync(path, staged);
          stagedBytes = true;
        }
        if (!attachments.remove(id)) {
          throw new DomainError("NOT_FOUND", { message: `no attachment ${id}`, details: { attachmentId: id } });
        }
      },
      { op: "attachments.remove" },
    );
  } catch (err) {
    if (stagedBytes) {
      try {
        renameSync(staged, path);
      } catch {
        /* the row is intact; the bytes' exact name matters less than the throw */
      }
    }
    throw err;
  }
  if (stagedBytes) {
    try {
      rmSync(staged, { force: true });
    } catch {
      /* the staged bytes are the lesser problem */
    }
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
