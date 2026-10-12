/**
 * B09 · the drawer's attachment rows (M2).
 *
 * `attachmentRows` reads the task's free-form `meta` bucket, which is the only
 * place the board has ever carried attachment metadata (`[data-card-attachment-count]`
 * reads `meta.attachment_count`). Two things are worth asserting without a
 * browser: the display string never lies about a size, and a row without a
 * filename is not a row.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attachmentRows, formatFileSize } from "../../web/src/lib/attachments.js";

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
  it("maps the meta bucket in order, in the table's own vocabulary", () => {
    const rows = attachmentRows({ attachments: [{ filename: "spec.md", size: 12 * 1024 }, { filename: "shot.png", size: 248 * 1024 }] });
    assert.deepEqual(rows, [
      { name: "spec.md", size: "12 KB" },
      { name: "shot.png", size: "248 KB" },
    ]);
  });

  it("drops an entry that names no file — an unnamed row is not an attachment", () => {
    assert.deepEqual(attachmentRows({ attachments: [{ size: 10 }, { filename: "", size: 10 }, { filename: "ok.txt" }] }), [
      { name: "ok.txt", size: "" },
    ]);
  });

  it("is empty, not broken, when the task carries no meta at all", () => {
    assert.deepEqual(attachmentRows(undefined), []);
    assert.deepEqual(attachmentRows({}), []);
    assert.deepEqual(attachmentRows({ attachments: "two files" }), []);
  });
});
