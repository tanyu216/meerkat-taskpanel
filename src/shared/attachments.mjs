/**
 * Attachment policy — the two pure decisions the upload surface makes
 * (T-20261014-212017-4, the write side ARCHITECTURE §5.1 / §13 reserved).
 *
 * Both are here rather than in the route so the **server and the CLI** reach the
 * same verdict: the CLI is a second client of the same board and may not be the
 * one place a type is judged. Pure — no `node:` specifiers — so
 * `node --test` covers it without a database or a socket.
 */

import { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_DEFAULT_CONTENT_TYPE } from "./constants.mjs";
import { DomainError } from "./errors.mjs";

/**
 * The stored form of a caller-supplied `content_type`.
 *
 * Parameters are dropped (`text/plain; charset=utf-8` → `text/plain`): the board
 * stores what a file *is*, and a charset is a rendering hint the download path
 * does not honour. Case is folded for the same reason — a type has one spelling.
 *
 * A value outside `ATTACHMENT_CONTENT_TYPES` is refused rather than stored. This
 * is the type half of "上传（大小/类型限制）": without it `content_type` was
 * whatever the caller sent and the board served it back from its own origin.
 *
 * @param {unknown} value the declared content type (`undefined`/`null` = none)
 * @returns {string|null} the type to store, or `null` when none was declared
 * @throws {DomainError} `ATTACHMENT_TYPE_UNSUPPORTED` for an unknown type
 */
export function normalizeAttachmentContentType(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new DomainError("ATTACHMENT_TYPE_UNSUPPORTED", {
      message: "content_type must be a string",
      details: { field: "content_type", received: typeof value },
    });
  }
  const base = value.split(";")[0].trim().toLowerCase();
  if (base === "") return null;
  if (!ATTACHMENT_CONTENT_TYPES.includes(base)) {
    throw new DomainError("ATTACHMENT_TYPE_UNSUPPORTED", {
      message: `content type ${JSON.stringify(base)} is not allowed on the board`,
      details: { field: "content_type", received: base, allowed: [...ATTACHMENT_CONTENT_TYPES] },
    });
  }
  return base;
}

/** The type the download path serves for a row that declares none. */
export function downloadContentType(stored) {
  return typeof stored === "string" && stored !== "" ? stored : ATTACHMENT_DEFAULT_CONTENT_TYPE;
}

/**
 * The `content_type` a filename suggests, for the CLI (which has a path and no
 * declaration). Only the extensions this board's list can name are mapped; an
 * unknown extension becomes `application/octet-stream`, which is the honest
 * statement "we do not know what this is" and is always allowed.
 *
 * @param {unknown} filename
 * @returns {string}
 */
export function contentTypeForFilename(filename) {
  const name = String(filename ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1);
  return EXTENSION_TYPES[extension] ?? ATTACHMENT_DEFAULT_CONTENT_TYPE;
}

const EXTENSION_TYPES = Object.freeze({
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

/**
 * The bytes limit, stated once for both clients: a body over it is refused
 * **before** anything is written. The transport enforces it too
 * (`readRawBody({maxBytes})` → 413); this is the check a CLI or a test can call
 * without a socket.
 *
 * @param {unknown} size
 * @param {number} maxBytes
 * @returns {number} the size, when it fits
 * @throws {DomainError} `ATTACHMENT_TOO_LARGE`
 */
export function assertAttachmentSize(size, maxBytes) {
  // A numeric string is read as its value (a CLI flag, a JSON field read by a
  // caller that did not coerce); anything with no size at all — `null`, a
  // boolean, an empty string — is not a size and is refused rather than read as
  // zero, which would silently turn "we forgot to pass it" into "empty file".
  const bytes =
    size === null || size === undefined || typeof size === "boolean" || (typeof size === "string" && size.trim() === "")
      ? Number.NaN
      : Number(size);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    throw new DomainError("ATTACHMENT_TOO_LARGE", {
      message: `attachment is ${Number.isFinite(bytes) ? bytes : "not a number of"} bytes; the limit is ${maxBytes}`,
      details: { field: "size", received: Number.isFinite(bytes) ? bytes : null, maxBytes },
    });
  }
  return bytes;
}
