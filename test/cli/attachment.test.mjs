/**
 * T-20261014-212017-4 — `attachment add|list|remove`.
 *
 * The CLI is the board's **second front door** and this group is the one that
 * closes `T-20261014-212017-2` G1's "CLI 零面". Every case runs a real `taskctl`
 * against a real `taskd`, so what is asserted is the whole path: the metadata
 * row (`POST …/attachments`), the bytes (`PUT …/content`, the one request on
 * this board that is not JSON) and the pairing that removal makes of them.
 *
 * The two refusals worth driving from here are the ones a caller can act on: a
 * file over the `ATTACHMENT_MAX_BYTES` ceiling, and a type outside the board's
 * allow-list. Both arrive as `code`s the skill documents, not as prose.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ATTACHMENT_MAX_BYTES } from "../../src/foundation/constants.mjs";
import { cleanupTempDirs, dataOf, errorOf, makeTempDir, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

/** A scratch directory for the files being uploaded (never the repository). */
function scratch() {
  return mkdtempSync(join(tmpdir(), "meerkat-attach-files-"));
}

async function board(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Carry a file", "--json"]);
    return fn(ctx);
  });
}

describe("cli/attachment", () => {
  it("uploads a file, lists it and removes it for good", async () => {
    await board(async ({ run }) => {
      const dir = scratch();
      const file = join(dir, "spec.md");
      writeFileSync(file, "# Spec\n\nSome markdown.\n", "utf8");

      const added = dataOf(run(["attachment", "add", "DEMO-0001", "--file", file, "--json"]));
      assert.equal(added.attachment.filename, "spec.md");
      assert.equal(added.attachment.content_type, "text/markdown", "the extension names the type");
      assert.equal(added.attachment.size, Buffer.byteLength("# Spec\n\nSome markdown.\n"), "the PUT's byte count is the row's");

      const listed = dataOf(run(["attachment", "list", "DEMO-0001", "--json"]));
      assert.equal(listed.attachments.length, 1);
      assert.equal(listed.attachments[0].id, added.attachment.id);

      const removed = dataOf(run(["attachment", "remove", added.attachment.id, "--json"]));
      assert.equal(removed.removed, true);
      assert.equal(dataOf(run(["attachment", "list", "DEMO-0001", "--json"])).attachments.length, 0);
    });
  });

  it("downloads the bytes back into the task's process directory", async () => {
    await board(async ({ run }) => {
      const dir = scratch();
      const source = join(dir, "spec.md");
      const content = Buffer.from("# Spec\n\nSome markdown.\n");
      writeFileSync(source, content);
      const added = dataOf(run(["attachment", "add", "DEMO-0001", "--file", source, "--json"]));

      const taskDir = join(scratch(), ".meerkat", "DEMO-0001");
      mkdirSync(taskDir, { recursive: true });
      const out = join(taskDir, "spec.md");
      const downloaded = dataOf(
        run(["attachment", "download", added.attachment.id, "--out", out, "--json"]),
      );
      assert.equal(downloaded.attachment_id, added.attachment.id);
      assert.equal(downloaded.out, out);
      assert.equal(downloaded.size, content.length);
      assert.match(downloaded.content_type, /^text\/markdown/);
      assert.deepEqual(readFileSync(out), content, "the bytes are the stored bytes");

      // The parent is the caller's job, exactly as with `export md` file mode.
      const missing = join(scratch(), "absent", "spec.md");
      const failed = run(["attachment", "download", added.attachment.id, "--out", missing, "--json"]);
      assert.notEqual(failed.status, 0);
      assert.equal(errorOf(failed).code, "CLI_USAGE");
      assert.equal(existsSync(missing), false);
    });
  });

  it("returns the board's NOT_FOUND when no bytes were stored", async () => {
    await board(async ({ run }) => {
      // `attachment add` always stores bytes, so mint the row directly? The
      // public path cannot produce an empty row; remove is the closest analogue.
      const dir = scratch();
      const source = join(dir, "gone.md");
      writeFileSync(source, "x", "utf8");
      const added = dataOf(run(["attachment", "add", "DEMO-0001", "--file", source, "--json"]));
      run(["attachment", "remove", added.attachment.id, "--json"]);
      const taskDir = join(scratch(), ".meerkat", "DEMO-0001");
      mkdirSync(taskDir, { recursive: true });
      const failed = run([
        "attachment",
        "download",
        added.attachment.id,
        "--out",
        join(taskDir, "gone.md"),
        "--json",
      ]);
      assert.notEqual(failed.status, 0);
      assert.equal(errorOf(failed).code, "NOT_FOUND");
    });
  });

  it("reads an empty list as 'no attachments', not as an error", async () => {
    await board(async ({ run }) => {
      const listing = run(["attachment", "list", "DEMO-0001"]);
      assert.equal(listing.status, 0);
      assert.match(listing.stdout, /no attachments/);
      assert.deepEqual(dataOf(run(["attachment", "list", "DEMO-0001", "--json"])).attachments, []);
    });
  });

  it("refuses a declared type the board will not store", async () => {
    await board(async ({ run }) => {
      const dir = scratch();
      const file = join(dir, "page.html");
      writeFileSync(file, "<html></html>", "utf8");
      // Since `--content-type` is the **declared** type, the refusal is driven
      // through it. The extension alone would not reach it: an extension the
      // board cannot name becomes `application/octet-stream` — "we do not know
      // what this is" — which is always allowed and is stored as an opaque
      // download, never as a page the origin renders.
      const failed = run(["attachment", "add", "DEMO-0001", "--file", file, "--content-type", "text/html", "--json"]);
      assert.notEqual(failed.status, 0);
      assert.equal(errorOf(failed).code, "ATTACHMENT_TYPE_UNSUPPORTED");
      // …and nothing was written: the refusal happens before the row is minted.
      assert.equal(dataOf(run(["attachment", "list", "DEMO-0001", "--json"])).attachments.length, 0);
    });
  });

  it("names a video container from its extension", async () => {
    await board(async ({ run }) => {
      const dir = scratch();
      const file = join(dir, "clip.mp4");
      writeFileSync(file, Buffer.from("not really a video, but the extension names the type"));
      const added = dataOf(run(["attachment", "add", "DEMO-0001", "--file", file, "--json"]));
      assert.equal(added.attachment.content_type, "video/mp4");
      assert.equal(added.attachment.filename, "clip.mp4");
    });
  });

  it("refuses a file over the ceiling before it opens a socket", async () => {
    await board(async ({ run }) => {
      const dir = scratch();
      const file = join(dir, "huge.bin");
      writeFileSync(file, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1));
      const failed = run(["attachment", "add", "DEMO-0001", "--file", file, "--json"]);
      assert.notEqual(failed.status, 0);
      assert.equal(errorOf(failed).code, "ATTACHMENT_TOO_LARGE");
      assert.equal(dataOf(run(["attachment", "list", "DEMO-0001", "--json"])).attachments.length, 0);
    });
  });

  it("accepts an explicit --content-type and an explicit --name", async () => {
    await board(async ({ run }) => {
      const dir = scratch();
      const file = join(dir, "notes");
      writeFileSync(file, "plain words", "utf8");
      const added = dataOf(
        run([
          "attachment",
          "add",
          "DEMO-0001",
          "--file",
          file,
          "--name",
          "notes.txt",
          "--content-type",
          "text/plain",
          "--json",
        ]),
      );
      assert.equal(added.attachment.filename, "notes.txt");
      assert.equal(added.attachment.content_type, "text/plain");
    });
  });

  it("fails readably when the file is not there", async () => {
    await board(async ({ run }) => {
      const failed = run(["attachment", "add", "DEMO-0001", "--file", join(makeTempDir(), "missing.txt"), "--json"]);
      assert.notEqual(failed.status, 0);
      assert.equal(errorOf(failed).code, "CLI_IO");
    });
  });
});
