/**
 * B09 · the drawer's attachment rows (M2, re-sourced by T-20261014-212017-4).
 *
 * The rows come from the **`attachments` table** — `GET /api/v1/tasks/:ref/attachments`
 * — which is the G2 ruling (`T-20261014-212017-2`, 2026-10-14: "附件唯一真源 =
 * `attachments` 表；`meta.attachments` 数组约定**不引入**"). The old reader here
 * took `task.meta.attachments`, a convention with **no writer anywhere**
 * (`--meta attachments=…` stores a string, not an array), so the drawer could
 * only ever show whatever a hand-written `meta` bucket happened to hold while a
 * real upload went somewhere the UI never looked.
 *
 * `[data-card-attachment-count]` is *not* re-sourced here: it reads
 * `meta.attachment_count` on the card face, which is B07's own seat and a
 * separate question from "what does this card's file list hold". Changing it
 * would be a design change, and this card makes none.
 *
 * The row shape follows the table's own vocabulary: `id`, `filename`, `size` in
 * bytes, `content_type`.
 */

/**
 * A byte count as the prototype writes it: whole KB below a megabyte, one
 * decimal above ("12 KB", "1.2 MB"). Sizes are display strings, so they round —
 * a file is never reported as `0 KB` when it has bytes, and never as `NaN KB`
 * when it has none.
 *
 * @param {unknown} bytes
 * @returns {string} `""` when the size is not a number
 */
export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The drawer's rows, in the order the wire returned them (the table's own
 * `created_at, id`), with any entry that names no file dropped — a row with an
 * empty name is not an attachment.
 *
 * @param {unknown} rows the `attachments` half of the listing
 * @returns {{id: string, name: string, size: string, contentType: string|null}[]}
 */
export function attachmentRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((file) => ({
      id: String(file?.id ?? ""),
      name: String(file?.filename ?? file?.name ?? ""),
      size: formatFileSize(file?.size),
      contentType: typeof file?.content_type === "string" ? file.content_type : (file?.contentType ?? null),
    }))
    .filter((row) => row.name !== "");
}

/**
 * The stored name of a `File` the reader picked, made safe to hand to the board.
 *
 * Browsers give a `File.name` with no directory component, but the value is
 * ultimately a string a page or a hand-written client controls, so it is
 * reduced to its last path segment here as well: a name that still carried
 * `../` would be sent to a board whose own id/filename handling is the last line
 * of defence, and defence in depth is the point of the strip.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function safeFileName(name) {
  const text = String(name ?? "");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return cut === -1 ? text : text.slice(cut + 1);
}
