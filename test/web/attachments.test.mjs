/**
 * B09 · the drawer's attachment rows (M2; re-sourced by T-20261014-212017-4).
 *
 * `attachmentRows` reads the **`attachments` table** — the listing
 * `GET /api/v1/tasks/:ref/attachments` returns — which is the G2 ruling
 * (`T-20261014-212017-2`). Three things are worth asserting without a browser:
 * the display string never lies about a size, a row without a filename is not a
 * row, and a name the caller controls cannot smuggle a path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachmentRows, formatFileSize, safeFileName } from "../../web/src/lib/attachments.js";

describe("web/attachments — the display size", () => {
  it("writes whole KB below a megabyte and one decimal above, like the prototype", () => {
    assert.equal(formatFileSize(12 * 1024), "12 KB");
    assert.equal(formatFileSize(248 * 1024), "248 KB");
    assert.equal(formatFileSize(1.2 * 1024 * 1024), "1.2 MB");
  });

  it("never reports an empty file as 0 KB, and never prints NaN", () => {
    assert.equal(formatFileSize(0), "0 B");
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(undefined), "");
    assert.equal(formatFileSize("big"), "");
    assert.equal(formatFileSize(-1), "");
  });
});

describe("web/attachments — the rows", () => {
  it("maps the table's rows in the order the wire returned them", () => {
    const rows = attachmentRows([
      { id: "a1", filename: "spec.md", size: 12 * 1024, content_type: "text/markdown" },
      { id: "a2", filename: "shot.png", size: 248 * 1024, content_type: "image/png" },
    ]);
    assert.deepEqual(rows, [
      { id: "a1", name: "spec.md", size: "12 KB", contentType: "text/markdown" },
      { id: "a2", name: "shot.png", size: "248 KB", contentType: "image/png" },
    ]);
  });

  it("drops an entry that names no file — an unnamed row is not an attachment", () => {
    assert.deepEqual(attachmentRows([{ id: "a1", size: 10 }, { id: "a2", filename: "", size: 10 }, { id: "a3", filename: "ok.txt" }]), [
      { id: "a3", name: "ok.txt", size: "", contentType: null },
    ]);
  });

  it("is empty, not broken, when the listing carries nothing", () => {
    assert.deepEqual(attachmentRows(undefined), []);
    assert.deepEqual(attachmentRows(null), []);
    // The old source was an object with an `attachments` array on it; a task
    // handed to this function by mistake is not a listing, and says so by
    // rendering nothing rather than by inventing rows.
    assert.deepEqual(attachmentRows({ attachments: [{ filename: "x" }] }), []);
  });
});

describe("web/attachments — the uploaded name", () => {
  it("keeps a plain filename as it is", () => {
    assert.equal(safeFileName("board-keyboard-spec.md"), "board-keyboard-spec.md");
  });

  it("reduces a name that carries a path to its last segment", () => {
    assert.equal(safeFileName("../../etc/passwd"), "passwd");
    assert.equal(safeFileName("C:\\Users\\me\\secret.txt"), "secret.txt");
    assert.equal(safeFileName("/absolute/path/report.pdf"), "report.pdf");
  });

  it("answers an empty string rather than throwing on a missing name", () => {
    assert.equal(safeFileName(undefined), "");
    assert.equal(safeFileName(null), "");
  });
});
