/**
 * B09 · the drawer's attachment rows (M2).
 *
 * Attachment metadata lives in the free-form `task.meta` bucket — the same
 * convention `[data-card-attachment-count]` already reads
 * (`meta.attachment_count`). There is no list endpoint yet (`GET
 * /api/v1/attachments/:id/content` streams bytes; the `attachments` table holds
 * the metadata), so the drawer renders whatever the task carries under
 * `meta.attachments` and shows the "no attachments" state when it carries
 * nothing. The row shape follows the table's own vocabulary: `filename` and
 * `size` in bytes.
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
 * The drawer's rows, in the order the task carries them, with any entry that
 * names no file dropped (a row with an empty name is not an attachment).
 *
 * @param {unknown} meta a task's `meta`
 * @returns {{name: string, size: string}[]}
 */
export function attachmentRows(meta) {
  const list = Array.isArray(meta?.attachments) ? meta.attachments : [];
  return list
    .map((file) => ({ name: String(file?.filename ?? file?.name ?? ""), size: formatFileSize(file?.size) }))
    .filter((row) => row.name !== "");
}
