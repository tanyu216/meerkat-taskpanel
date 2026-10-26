/**
 * The atomic-replace discipline shared by the loop's brief exporter and the
 * CLI watchers.
 *
 * The two writers obtain markdown differently (a `taskctl export md` child vs.
 * the board's in-memory export) but must agree on the file contract: a unique
 * `.tmp.md` beside the target, an unchanged file left untouched, and no temp
 * left behind on any path.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  cardTempPath,
  commitCardTemp,
  removeCardTemp,
  writeCardFileAtomic,
} from "../../src/foundation/card-write.mjs";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-card-write-"));
  dirs.push(dir);
  return dir;
}

describe("card-write — cardTempPath", () => {
  it("names a unique .tmp.md beside the final file and creates nothing", () => {
    const dir = tempDir();
    const final = join(dir, "card.md");
    const first = cardTempPath(final);
    const second = cardTempPath(final);

    assert.match(basename(first), /^card\.[^.]+\.\w+\.\w+\.tmp\.md$/);
    assert.equal(dirname(first), dir);
    assert.notEqual(first, second, "two temps never collide");
    assert.equal(existsSync(first), false, "naming a path creates nothing");
  });
});

describe("card-write — commitCardTemp", () => {
  it("reports a producer that wrote no temp", () => {
    const dir = tempDir();
    const final = join(dir, "card.md");

    assert.deepEqual(commitCardTemp({ temp: join(dir, "missing.tmp.md"), final }), {
      ok: false,
      reason: "missing",
    });
    assert.equal(existsSync(final), false);
  });

  it("rejects an empty temp, removes it, and leaves the previous brief", () => {
    const dir = tempDir();
    const final = join(dir, "card.md");
    const temp = join(dir, "empty.tmp.md");
    writeFileSync(final, "old\n", "utf8");
    writeFileSync(temp, "", "utf8");

    assert.deepEqual(commitCardTemp({ temp, final }), { ok: false, reason: "empty" });
    assert.equal(existsSync(temp), false);
    assert.equal(readFileSync(final, "utf8"), "old\n");
  });

  it("renames the temp over a missing final", () => {
    const dir = tempDir();
    const final = join(dir, "card.md");
    const temp = join(dir, "new.tmp.md");
    writeFileSync(temp, "# Card\n", "utf8");

    assert.deepEqual(commitCardTemp({ temp, final }), { ok: true, path: final, changed: true });
    assert.equal(readFileSync(final, "utf8"), "# Card\n");
    assert.equal(existsSync(temp), false);
  });

  it("leaves a byte-identical brief untouched", () => {
    const dir = tempDir();
    const final = join(dir, "card.md");
    const temp = join(dir, "same.tmp.md");
    writeFileSync(final, "same\n", "utf8");
    writeFileSync(temp, "same\n", "utf8");

    assert.deepEqual(commitCardTemp({ temp, final }), { ok: true, path: final, changed: false });
    assert.equal(readFileSync(final, "utf8"), "same\n");
    assert.equal(existsSync(temp), false);
  });

  it("replaces a different brief", () => {
    const dir = tempDir();
    const final = join(dir, "card.md");
    const temp = join(dir, "next.tmp.md");
    writeFileSync(final, "old\n", "utf8");
    writeFileSync(temp, "new\n", "utf8");

    assert.deepEqual(commitCardTemp({ temp, final }), { ok: true, path: final, changed: true });
    assert.equal(readFileSync(final, "utf8"), "new\n");
    assert.equal(existsSync(temp), false);
  });
});

describe("card-write — writeCardFileAtomic", () => {
  it("creates the parent tree and leaves no temp behind", () => {
    const dir = tempDir();
    const file = join(dir, "a", "b", "card.md");

    assert.deepEqual(writeCardFileAtomic({ file, content: "# Card\n" }), {
      path: file,
      changed: true,
    });
    assert.equal(readFileSync(file, "utf8"), "# Card\n");
    assert.deepEqual(readdirSync(dirname(file)), ["card.md"]);
  });

  it("skips an identical file without touching the directory", () => {
    const dir = tempDir();
    const file = join(dir, "card.md");
    writeFileSync(file, "# Card\n", "utf8");

    assert.deepEqual(writeCardFileAtomic({ file, content: "# Card\n" }), {
      path: file,
      changed: false,
    });
    assert.deepEqual(readdirSync(dir), ["card.md"]);
  });

  it("replaces different content", () => {
    const dir = tempDir();
    const file = join(dir, "card.md");
    writeFileSync(file, "old\n", "utf8");

    assert.deepEqual(writeCardFileAtomic({ file, content: "new\n" }), {
      path: file,
      changed: true,
    });
    assert.equal(readFileSync(file, "utf8"), "new\n");
    assert.deepEqual(readdirSync(dir), ["card.md"]);
  });

  it("refuses empty or non-string content", () => {
    const dir = tempDir();
    const file = join(dir, "card.md");

    assert.throws(() => writeCardFileAtomic({ file, content: "" }), TypeError);
    assert.throws(() => writeCardFileAtomic({ file, content: null }), TypeError);
    assert.equal(existsSync(file), false);
  });
});

describe("card-write — removeCardTemp", () => {
  it("removes a temp and never throws when it is gone", () => {
    const dir = tempDir();
    const temp = join(dir, "gone.tmp.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, "x", "utf8");

    removeCardTemp(temp);
    assert.equal(existsSync(temp), false);
    removeCardTemp(temp);
  });
});
