/**
 * `apply.mjs` self-dispatch guard resolves symlinks on *both* sides (T-20261012-175712).
 *
 * The guard at the bottom of `apply.mjs` decides whether the file was executed as the
 * entry point (`main()` must run) or imported as a library (it must not). It compared
 * `resolve(process.argv[1])` — the path *as invoked* — against
 * `fileURLToPath(import.meta.url)` — the path Node already resolved. Whenever the two
 * forms differed the guard was silently false: no subcommand ran, nothing was written,
 * and the process still exited 0.
 *
 * That is reachable in practice, not just in theory. `script_dir()` in `_common.sh`
 * prints the logical path (`cd "$(dirname "$0")" && pwd`), so an install tree reached
 * through a symlinked directory dispatches `node <symlink>/lib/apply.mjs emit …`; on
 * macOS `/tmp` is itself a symlink to `/private/tmp`, so `/tmp/<checkout>` is enough. The
 * failure mode is the worst kind — a silent no-op reported as success.
 *
 * Both ways of carrying a symlink are exercised (a linked *directory* on the entry path,
 * and a linked *file*), plus the direct run and the import state the other suites rely on.
 *
 * The child is always a real `node` process against a real copy of the module: no
 * in-process import, no monkey-patching, because the bug lives precisely in how the module
 * reads `process.argv[1]` and `import.meta.url` at startup.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APPLY = join(ROOT, "scripts/install/lib/apply.mjs");

/** A template with no `{{TOKEN}}`, so the child needs no TP_* environment. */
const TEMPLATE_BODY = "managed by the installer\n";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fixture where `linkApply` and `realApply` are the same file and the only difference is
 * the symlink on the invoked path: a linked directory in front of it (`shape: "dir"`), or a
 * link to the file itself (`shape: "file"`).
 *
 * Both temp roots are `realpathSync`ed first, so the canonical side stays canonical even on
 * a platform whose `tmpdir()` already sits under a symlink (`/var` on macOS).
 *
 * @param {"dir"|"file"} shape
 */
function makeFixture(shape) {
  const realBase = realpathSync(makeTempDir("tp-apply-guard-real-"));
  const linkBase = realpathSync(makeTempDir("tp-apply-guard-link-"));

  const realDir = join(realBase, "lib");
  mkdirSync(realDir);
  const realApply = join(realDir, "apply.mjs");
  copyFileSync(APPLY, realApply);

  let linkApply;
  if (shape === "dir") {
    const linkDir = join(linkBase, "linked-lib");
    symlinkSync(realDir, linkDir, "dir");
    linkApply = join(linkDir, "apply.mjs");
  } else {
    linkApply = join(linkBase, "apply.mjs");
    symlinkSync(realApply, linkApply);
  }

  return { realApply, linkApply, realBase, linkBase };
}

/** Run one `emit` through a child `node`, exactly as `_common.sh` dispatches it. */
function runEmit(entry, dest) {
  return spawnSync(process.execPath, [entry, "emit", entryTemplate(entry), dest], {
    cwd: dirname(entry),
    encoding: "utf8",
  });
}

/** The token-free template, written beside the entry so cwd-relative paths stay simple. */
function entryTemplate(entry) {
  const template = join(dirname(entry), "template.txt");
  writeFileSync(template, TEMPLATE_BODY, "utf8");
  return template;
}

describe("apply.mjs self-dispatch guard is symlink-safe (T-20261012-175712)", () => {
  it("runs emit when invoked on a canonical path", () => {
    const { realApply, realBase } = makeFixture("dir");
    const dest = join(realBase, "out", "direct.txt");

    const run = runEmit(realApply, dest);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "", "a supported invocation must say nothing on stderr");
    assert.match(run.stdout, /^wrote /, "the written/unchanged detail must be reported");
    assert.equal(readFileSync(dest, "utf8"), TEMPLATE_BODY);
  });

  for (const [shape, label] of [
    ["dir", "symlinked directory"],
    ["file", "symlinked file"],
  ]) {
    it(`runs emit when invoked through a ${label} (the silent no-op)`, () => {
      const { linkApply, linkBase } = makeFixture(shape);
      const dest = join(linkBase, "out", "linked.txt");

      // Precondition: the invoked path really does carry a symlink the guard must resolve
      // away. If that ever stops holding, this test measures nothing — so it is an
      // assertion, not a silent pass.
      assert.notEqual(
        realpathSync(linkApply),
        linkApply,
        "fixture precondition: the invoked path must differ from its realpath",
      );

      const run = runEmit(linkApply, dest);

      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^wrote /, `emit must not be a silent no-op (stdout: ${JSON.stringify(run.stdout)})`);
      assert.equal(
        readFileSync(dest, "utf8"),
        TEMPLATE_BODY,
        "emit must actually write the destination when reached through a symlink",
      );
    });
  }

  it("stays false when the module is imported as a library", () => {
    const base = realpathSync(makeTempDir("tp-apply-guard-import-"));
    const child = join(base, "import-apply.mjs");
    writeFileSync(
      child,
      `import ${JSON.stringify(pathToFileURL(APPLY).href)};\nprocess.stdout.write("imported\\n");\n`,
      "utf8",
    );

    // An argument that would make `main()` fail loudly if the guard wrongly fired.
    const run = spawnSync(process.execPath, [child, "definitely-not-a-subcommand"], {
      cwd: base,
      encoding: "utf8",
    });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "imported\n");
    assert.doesNotMatch(run.stderr, /definitely-not-a-subcommand/);
  });
});
