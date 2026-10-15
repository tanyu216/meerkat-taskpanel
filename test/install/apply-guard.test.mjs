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
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { listModuleFiles, readSource, stripComments } from "../helpers/source-scan.mjs";

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

/**
 * The same guard, on every *other* entry point, plus the tripwire that keeps it fixed.
 *
 * `apply.mjs` was the one that got caught; the idiom it used had been copy-pasted across the
 * repository, so the bug had been too. The table below runs each entry point twice — once on
 * its canonical path, once through a symlinked ancestor — and requires the two runs to be
 * indistinguishable. The failure this pins is not a crash but `exit 0` with **empty stdout**,
 * which is what a silently false guard looks like: a `scripts/verify/*` checker reached
 * through a symlink printed nothing and reported success without looking at anything.
 *
 * Every entry is hermetic — it exits 0 with non-empty stdout, needing no board, no network and
 * no arguments beyond the ones listed. `monitoring/exporter.mjs` is deliberately **absent**: it
 * does not accept `--help` and starts serving, so it has no hermetic invocation at all. The
 * source-scan leg below is what covers it.
 */
const ENTRY_POINTS = [
  ["src/cli/index.mjs", ["--help"]],
  ["scripts/supervisor.mjs", ["--help"]],
  ["scripts/wake-cwd.mjs", ["--help"]],
  ["scripts/verify/version.mjs", []],
  ["scripts/verify/paths.mjs", []],
  ["scripts/sync-loop.mjs", ["--check"]],
];

/**
 * A temp root carrying a symlink *back to this checkout*, so an entry point can be invoked on a
 * path whose ancestor is a link — the shape `_common.sh`'s `script_dir()` produces, and the
 * shape macOS's own `/tmp` adds for free.
 *
 * The base is `realpathSync`ed first so the canonical side stays canonical on a platform whose
 * `tmpdir()` already sits under a symlink (`/var` on macOS). The link is always one we created,
 * never one the platform happened to provide.
 */
function linkedCheckout() {
  const base = realpathSync(makeTempDir("tp-entry-guard-"));
  const link = join(base, "linked-repo");
  symlinkSync(ROOT, link, "dir");
  return { base, link };
}

describe("every entry point is symlink-safe (the guard cannot silently no-op)", () => {
  for (const [rel, args] of ENTRY_POINTS) {
    it(`${rel} behaves identically through a symlinked ancestor`, () => {
      const { link } = linkedCheckout();
      const invoked = join(link, rel);

      // Precondition: the invoked path really does carry a symlink the guard must resolve
      // away. If that ever stops holding, this test measures nothing.
      assert.notEqual(
        realpathSync(invoked),
        invoked,
        "fixture precondition: the invoked path must differ from its realpath",
      );

      const run = (entry) => spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, encoding: "utf8" });
      const canonical = run(join(ROOT, rel));
      const linked = run(invoked);

      // Non-vacuity: if the canonical run were silent too, "identical" would prove nothing.
      assert.notEqual(canonical.stdout.trim(), "", `${rel} must print something on its canonical path`);

      assert.equal(linked.status, canonical.status, `status differs; stderr=${JSON.stringify(linked.stderr.slice(0, 300))}`);
      assert.equal(
        linked.stdout,
        canonical.stdout,
        `${rel} printed nothing (or something else) through a symlinked ancestor`,
      );
      assert.equal(linked.stderr, canonical.stderr);
    });
  }
});

describe("no entry point reverts to a symlink-fragile guard", () => {
  // Generated trees are excluded from the scan because scanning them is not what keeps them
  // honest — `sync-skills --check` is. `plugins/` and `dist/` are excluded by not being scan
  // roots at all, `web/node_modules` by taking only `web/scripts`, and `test/` because tests are
  // not entry points (and because this file, which *defines* the tripwire, lives there).
  const SCAN_ROOTS = [
    join(ROOT, "src"),
    join(ROOT, "scripts"),
    join(ROOT, "monitoring"),
    join(ROOT, "skills"),
    join(ROOT, "web", "scripts"),
  ];
  const GENERATED = [
    join(ROOT, "skills", "meerkat-loop", "body"),
    join(ROOT, "skills", "meerkat-loop", "templates"),
  ];

  /**
   * The three shapes the fragile guard came in. Each compares a path *as invoked* against
   * `import.meta.url` without resolving symlinks on both sides:
   *
   *   * `pathToFileURL(argv[1])` — the original idiom, also the `src/server` variant;
   *   * `resolve(argv[1])` — absolutised but never realpath'd, so equally fragile;
   *   * the `` `file://${argv[1]}` `` template — the naive form, fragile *and* encoding-broken.
   */
  const FRAGILE = [
    { label: "pathToFileURL(argv[1])", re: /pathToFileURL\(\s*process\.argv\[1\]\s*\)/ },
    { label: "resolve(argv[1])", re: /resolve\(\s*process\.argv\[1\]\s*\)/ },
    { label: "`file://${argv[1]}`", re: /`file:\/\/\$\{process\.argv\[1\]\}/ },
  ];

  /** Entry points that must be inside the scan — the tripwire is worthless if they are not. */
  const MUST_BE_SCANNED = [
    "src/cli/index.mjs",
    "src/server/main.mjs",
    "src/core/storage/md/migrate-cli.mjs",
    "scripts/wake-cwd.mjs",
    "scripts/supervisor.mjs",
    "scripts/verify/contract.mjs",
    "scripts/migrate/drill.mjs",
    "scripts/security/scan-gate.mjs",
    "monitoring/exporter.mjs",
    "skills/meerkat-taskpanel/scripts/report.mjs",
    "web/scripts/dom-smoke.mjs",
  ];

  const scanned = SCAN_ROOTS.flatMap(listModuleFiles).filter(
    (file) => !GENERATED.some((root) => file.startsWith(root + sep)),
  );

  it("scans the authored tree, and every known entry point still declares a guard", () => {
    assert.ok(scanned.length >= 50, `expected ≥ 50 authored modules, found ${scanned.length}`);
    for (const rel of MUST_BE_SCANNED) {
      assert.ok(scanned.includes(join(ROOT, rel)), `${rel} must be inside the scan`);
      assert.match(
        stripComments(readSource(join(ROOT, rel))),
        /isEntryPoint\(|process\.argv\[1\]/,
        `${rel} must still declare an entry-point guard for this scan to mean anything`,
      );
    }
  });

  it("matches none of the symlink-fragile guard shapes", () => {
    const offenders = [];
    for (const file of scanned) {
      // Comments are stripped first: several files *document* the fragile idiom, and a docstring
      // naming it is the opposite of a defect. String and template bodies are kept, because the
      // template-literal shape lives inside one.
      const text = stripComments(readSource(file));
      for (const { label, re } of FRAGILE) {
        if (re.test(text)) offenders.push(`${file.slice(ROOT.length + 1)}: ${label}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `compare canonical paths instead (isEntryPoint from src/shared/entry-guard.mjs):\n${offenders.join("\n")}`,
    );
  });
});
