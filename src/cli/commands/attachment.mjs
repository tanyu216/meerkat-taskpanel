/**
 * `attachment add|list|remove` — the file surface of a card
 * (T-20261014-212017-4, closing `T-20261014-212017-2` G1's "no CLI group").
 *
 * The board stores an attachment as **two things** and this group drives both:
 * a metadata row (`POST /api/v1/tasks/:ref/attachments`) and the bytes
 * (`PUT /api/v1/attachments/:id/content`, §5.1). `add` is therefore two
 * requests, and the second one is raw bytes rather than JSON — which is why the
 * transport grew `putBytes` beside `put`.
 *
 * Removal is a **hard delete** (row + bytes, one act): an attachment is not
 * recoverable, and re-uploading is the whole recovery story. That ruling is
 * stated where it is implemented (`src/server/routes/attachments.mjs`).
 *
 * The type is checked on both sides: this command refuses one outside
 * `ATTACHMENT_CONTENT_TYPES` before it opens a socket, and the board refuses it
 * again. The size limit is stated once (`ATTACHMENT_MAX_BYTES`) and enforced by
 * the command, the transport and the server.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { assertAttachmentSize, contentTypeForFilename, normalizeAttachmentContentType } from "../../foundation/attachments.mjs";
import { ATTACHMENT_MAX_BYTES } from "../../foundation/constants.mjs";
import { DomainError } from "../../foundation/errors.mjs";
import { table } from "../output/human.mjs";

/**
 * Bytes as the drawer writes them: whole KB below a megabyte, one decimal above.
 * Exported so a unit test can pin the format without a socket — the CLI and the
 * web drawer must not disagree about how big a file is.
 */
export function sizeLabel(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export const COMMANDS = [
  {
    name: "add",
    summary: "Upload a file to a card: metadata row then bytes.",
    usage: "attachment add <id|identifier> --file <path> [--name <filename>] [--content-type <type>]",
    positionals: [{ name: "ref", summary: "The card the file belongs to." }],
    flags: [
      { flag: "file", key: "file", as: "string", value: "<path>", required: true },
      { flag: "name", key: "name", as: "string", value: "<filename>", summary: "Store under this name instead of the file's own." },
      { flag: "content-type", key: "contentType", as: "string", value: "<type>", summary: "Defaults to the type the file extension names." },
    ],
    async run(ctx) {
      const path = ctx.flags.file;
      let bytes;
      try {
        bytes = readFileSync(path);
      } catch (err) {
        throw new DomainError("CLI_IO", {
          message: `cannot read ${path}: ${err?.code ?? err?.message ?? String(err)}`,
          details: { file: path },
          hint: { fix: "check the path and that the file is readable" },
        });
      }
      // The policy is shared, not restated: the same call the server's own
      // ceiling comes from decides this, so the CLI cannot drift from the board
      // it uploads to.
      assertAttachmentSize(bytes.length, ATTACHMENT_MAX_BYTES);

      const filename = ctx.flags.name ?? basename(path);
      const contentType = normalizeAttachmentContentType(ctx.flags.contentType ?? contentTypeForFilename(filename));

      const created = await ctx.client.post(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/attachments`, {
        filename,
        ...(contentType === null ? {} : { content_type: contentType }),
        size: bytes.length,
      });
      const id = created.attachment.id;
      const stored = await ctx.client.putBytes(
        `/api/v1/attachments/${encodeURIComponent(id)}/content`,
        bytes,
        contentType ?? "application/octet-stream",
      );
      return {
        data: { attachment: { ...created.attachment, size: stored.size } },
        human: `attached ${filename} (${sizeLabel(stored.size)}) to ${ctx.args.ref} as #${id}`,
      };
    },
  },


  {
    name: "list",
    summary: "List a card's attachments.",
    usage: "attachment list <id|identifier>",
    positionals: [{ name: "ref", summary: "Task id or identifier." }],
    flags: [],
    async run(ctx) {
      const listing = await ctx.client.get(`/api/v1/tasks/${encodeURIComponent(ctx.args.ref)}/attachments`);
      const rows = listing.attachments.map((row) => [row.id, row.filename, sizeLabel(row.size), row.content_type ?? "—"]);
      return {
        data: listing,
        human: rows.length === 0 ? "no attachments" : table(["id", "filename", "size", "type"], rows),
      };
    },
  },

  {
    name: "remove",
    summary: "Remove an attachment for good: its row and its bytes.",
    usage: "attachment remove <attachment-id>",
    positionals: [{ name: "id", summary: "The attachment id (`attachment list` prints it)." }],
    flags: [],
    async run(ctx) {
      const removed = await ctx.client.delete(`/api/v1/attachments/${encodeURIComponent(ctx.args.id)}`);
      return { data: removed, human: `removed ${removed.attachment.filename} (#${removed.attachment.id})` };
    },
  },
];
