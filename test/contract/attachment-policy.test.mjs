/**
 * T-20261014-212017-4 — the attachment policy, as pure rules.
 *
 * `src/shared/attachments.mjs` is the one place the type allow-list, the
 * download default and the byte ceiling are decided, and it is shared on
 * purpose: the server is the guarantee, but the CLI judges the same two things
 * before it opens a socket, and neither may disagree with the other. There is no
 * database here and no socket — the rules are pure, so they are asserted pure.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  assertAttachmentSize,
  contentTypeForFilename,
  downloadContentType,
  normalizeAttachmentContentType,
} from "../../src/shared/attachments.mjs";
import { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES } from "../../src/shared/constants.mjs";

describe("shared/attachments — the declared type", () => {
  it("folds case and drops parameters", () => {
    assert.equal(normalizeAttachmentContentType("text/plain; charset=utf-8"), "text/plain");
    assert.equal(normalizeAttachmentContentType("  APPLICATION/JSON  "), "application/json");
  });

  it("reads an absent type as 'none declared'", () => {
    assert.equal(normalizeAttachmentContentType(undefined), null);
    assert.equal(normalizeAttachmentContentType(null), null);
    assert.equal(normalizeAttachmentContentType(""), null);
    assert.equal(normalizeAttachmentContentType("   "), null);
  });

  it("refuses a type outside the allow-list, naming what is allowed", () => {
    for (const type of ["text/html", "application/xhtml+xml", "image/svg+xml", "text/javascript", "application/javascript"]) {
      assert.throws(
        () => normalizeAttachmentContentType(type),
        (err) => err.code === "ATTACHMENT_TYPE_UNSUPPORTED" && err.details.received === type,
        type,
      );
    }
  });

  it("refuses a type that is not a string at all", () => {
    assert.throws(() => normalizeAttachmentContentType(42), (err) => err.code === "ATTACHMENT_TYPE_UNSUPPORTED");
  });

  it("keeps the list closed — no `inline`-only types, and the two page types are the omissions", () => {
    assert.equal(ATTACHMENT_CONTENT_TYPES.includes("text/html"), false);
    assert.equal(ATTACHMENT_CONTENT_TYPES.includes("image/svg+xml"), false);
    assert.equal(ATTACHMENT_CONTENT_TYPES.includes("application/octet-stream"), true);
    for (const type of ATTACHMENT_CONTENT_TYPES) assert.equal(type, type.toLowerCase());
    assert.equal(new Set(ATTACHMENT_CONTENT_TYPES).size, ATTACHMENT_CONTENT_TYPES.length, "no duplicates");
  });
});

describe("shared/attachments — the download type", () => {
  it("serves what the row declares, and octet-stream when it declares nothing", () => {
    assert.equal(downloadContentType("text/markdown"), "text/markdown");
    assert.equal(downloadContentType(null), "application/octet-stream");
    assert.equal(downloadContentType(undefined), "application/octet-stream");
    assert.equal(downloadContentType(""), "application/octet-stream");
  });
});

describe("shared/attachments — the type a filename suggests", () => {
  it("maps the extensions the allow-list can name", () => {
    assert.equal(contentTypeForFilename("spec.md"), "text/markdown");
    assert.equal(contentTypeForFilename("SHOT.PNG"), "image/png");
    assert.equal(contentTypeForFilename("rows.csv"), "text/csv");
  });

  it("says 'we do not know' rather than guessing for anything else", () => {
    // Including the two types the board refuses to *store*: an unknown extension
    // becomes an opaque download, never a page the origin would render.
    for (const name of ["page.html", "drawing.svg", "archive.rar", "noextension", "", null]) {
      assert.equal(contentTypeForFilename(name), "application/octet-stream", String(name));
    }
  });
});

describe("shared/attachments — the byte ceiling", () => {
  it("passes a size that fits, including the boundary", () => {
    assert.equal(assertAttachmentSize(0, ATTACHMENT_MAX_BYTES), 0);
    assert.equal(assertAttachmentSize(ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_BYTES), ATTACHMENT_MAX_BYTES);
    // A size that arrives as a string (a CLI flag, a JSON field) is read as a
    // number: the rule is about the *value*, not about how it was spelled.
    assert.equal(assertAttachmentSize("12", ATTACHMENT_MAX_BYTES), 12);
  });

  it("refuses one over it, and anything that is not a whole non-negative count", () => {
    for (const size of [ATTACHMENT_MAX_BYTES + 1, -1, 1.5, Number.NaN, "twelve", "", null, undefined, true]) {
      assert.throws(
        () => assertAttachmentSize(size, ATTACHMENT_MAX_BYTES),
        (err) => err.code === "ATTACHMENT_TOO_LARGE" && err.details.maxBytes === ATTACHMENT_MAX_BYTES,
        String(size),
      );
    }
  });

  it("states the limit once: 8 MiB", () => {
    assert.equal(ATTACHMENT_MAX_BYTES, 8 * 1024 * 1024);
  });
});
