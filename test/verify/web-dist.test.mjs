/**
 * Tests for `scripts/verify/web-dist.mjs` — the gate's frontend coverage verdict.
 *
 * Every case builds a real tree on disk (a temp dir with a `web/` in it) and calls the real
 * `classifyDist` / `legs` / CLI. Nothing is mocked: the thing under test is precisely "does
 * it read this tree correctly and say what it found".
 *
 * Two decisions the cases pin down, because both are easy to reverse by accident:
 *
 *   * **the harness is not a build input.** `web/scripts/**` and `web/manifests/**` are not
 *     read by Vite, so touching them must not make a good build look stale;
 *   * **"not asked" never reads as "covered".** With the browser probe off the DOM leg is
 *     reported UNCOVERED, not assumed green.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, describe, it } from "node:test";

import { ROOT, classifyDist, legs, newestSource } from "../../scripts/verify/web-dist.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "web-dist.mjs");

/** Two fixed instants, a minute apart, so "newer than" is a fact and not a race. */
const T1 = Date.UTC(2026, 0, 1, 0, 0, 0);
const T2 = T1 + 60_000;

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-web-dist-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a file into the tree and stamp its mtime, so freshness is decided, not observed. */
async function write(root, rel, { body = "// fixture\n", mtime } = {}) {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  if (mtime !== undefined) await utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

/** A tree with one source and a build product stamped at `builtAt`. */
async function builtTree({ builtAt = T2, sourceAt = T1 } = {}) {
  const root = await makeTree();
  await write(root, "web/src/main.js", { mtime: sourceAt });
  await write(root, "web/index.html", { mtime: sourceAt });
  await write(root, "web/dist/assets/main.js", { mtime: builtAt });
  await write(root, "web/dist/index.html", { mtime: builtAt });
  return root;
}

/** Run the CLI over a fixture tree. */
function cli(root, ...args) {
  return cliWithEnv(root, args, process.env);
}

function cliWithEnv(root, args, env) {
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", env });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("web-dist — classifying the on-disk build", () => {
  it("reports `unbuilt` when there is no web/dist at all", async () => {
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    const dist = classifyDist(root);
    assert.equal(dist.state, "unbuilt");
    assert.equal(dist.distDirExists, false);
    assert.match(dist.reason, /web\/dist is not built/);
  });

  it("reports `unbuilt` for the container's empty web/dist, and says which it is", async () => {
    // The Dockerfile's three-way guard runs `mkdir -p /app/web/dist` in every branch, so an
    // empty directory is a real state — not a "stale build of nothing".
    const root = await makeTree();
    await mkdir(join(root, "web/dist"), { recursive: true });
    const dist = classifyDist(root);
    assert.equal(dist.state, "unbuilt");
    assert.equal(dist.distDirExists, true);
    assert.match(dist.reason, /carries no index\.html/);
  });

  it("reports `stale`, naming the source that outran the build", async () => {
    const root = await builtTree({ builtAt: T1, sourceAt: T2 });
    const dist = classifyDist(root);
    assert.equal(dist.state, "stale");
    assert.equal(dist.newestSource.path, "web/src/main.js");
    assert.match(dist.reason, /predates web\/src\/main\.js/);
    assert.equal(dist.builtAtISO, new Date(T1).toISOString().replace(/\.\d{3}Z$/, "Z"));
  });

  it("reports `fresh` when the build is newer than every input", async () => {
    const dist = classifyDist(await builtTree({ builtAt: T2, sourceAt: T1 }));
    assert.equal(dist.state, "fresh");
    assert.equal(dist.builtAtISO, new Date(T2).toISOString().replace(/\.\d{3}Z$/, "Z"));
  });

  it("does not treat the host harness or the ui-align manifests as build inputs", async () => {
    // `web/scripts/**` (the browser harness) and `web/manifests/**` (ui-align) are not read
    // by Vite. Folding them in would call a perfectly good build stale after any harness
    // edit — and the gate would then cry stale at a tree nothing is wrong with.
    const root = await builtTree({ builtAt: T2, sourceAt: T1 });
    const later = T2 + 60_000;
    await write(root, "web/scripts/dom-smoke.mjs", { mtime: later });
    await write(root, "web/manifests/board.json", { mtime: later });
    assert.equal(classifyDist(root).state, "fresh");
    assert.equal(newestSource(root).path, "web/src/main.js");
  });
});

describe("web-dist — per-leg coverage", () => {
  const fresh = { state: "fresh", reason: "newer than every build input" };
  const stale = { state: "stale", reason: "the build predates web/src/main.js" };
  const unbuilt = { state: "unbuilt", reason: "web/dist is not built" };

  it("covers both legs on a fresh build with a browser", () => {
    const got = legs(fresh, { ok: true });
    assert.equal(got.bundle.covered, true);
    assert.equal(got.dom.covered, true);
  });

  it("blames the build — not the browser — when the build is stale", () => {
    const got = legs(stale, { ok: true });
    assert.equal(got.bundle.covered, false);
    assert.equal(got.dom.covered, false);
    assert.equal(got.dom.reason, stale.reason, "the DOM leg inherits the build's reason, not a browser one");
  });

  it("keeps the bundle leg covered but not the DOM one when no browser resolves", () => {
    const got = legs(fresh, { ok: false, reason: "Playwright is not installed on this host" });
    assert.equal(got.bundle.covered, true);
    assert.equal(got.dom.covered, false);
    assert.match(got.dom.reason, /no browser: Playwright is not installed/);
  });

  it("treats an unasked browser question as uncovered, never as covered", () => {
    const got = legs(fresh, null);
    assert.equal(got.bundle.covered, true);
    assert.equal(got.dom.covered, false);
    assert.match(got.dom.reason, /probe was off/);
  });

  it("does not consult the browser at all for an unbuilt tree", () => {
    assert.equal(legs(unbuilt, null).bundle.reason, unbuilt.reason);
  });
});

describe("web-dist — the verdict and its exit code", () => {
  it("reports an unbuilt tree loudly and still exits 0 by default", async () => {
    // The default is report-only on purpose: a lane worktree cannot be made to build (see
    // the --build case below), so failing closed by default would red every lane for an
    // environmental reason — the false red this script exists to remove.
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    const { code, out } = cli(root, "--browser-probe=off");
    assert.equal(code, 0);
    assert.match(out, /web\/dist: UNBUILT/);
    assert.match(out, /blocks\.bundle\s+UNCOVERED/);
    assert.match(out, /blocks\.dom\s+UNCOVERED/);
    assert.match(out, /NOT A PASS for: bundle, dom/);
  });

  it("fails closed on --require=all, and on --require=bundle, with exit 3", async () => {
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    assert.equal(cli(root, "--require=all", "--browser-probe=off").code, 3);
    assert.equal(cli(root, "--require=bundle", "--browser-probe=off").code, 3);
  });

  it("passes --require=bundle on a fresh build even with no browser", async () => {
    const root = await builtTree();
    const { code, out } = cli(root, "--require=bundle", "--browser-probe=off", "--json");
    assert.equal(code, 0);
    const verdict = JSON.parse(out);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.allCovered, false, "the DOM leg is still uncovered — that is the point");
    assert.deepEqual(verdict.uncovered, ["dom"]);
    assert.equal(verdict.dist.state, "fresh");
  });

  it("rejects a bad --require, and --help exits 0", async () => {
    const root = await makeTree();
    assert.equal(cli(root, "--require=sometimes").code, 2);
    assert.equal(cli(root, "--browser-probe=maybe").code, 2);
    assert.equal(cli(root, "--build-guard=maybe").code, 2);
    const help = cli(root, "--help");
    assert.equal(help.code, 0);
    assert.match(help.out, /--require=<none\|bundle\|all>/);
  });
});

describe("web-dist — the rebuild", () => {
  it("repairs a missing build through the build command, then reports it covered", async () => {
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    await mkdir(join(root, "web/node_modules"), { recursive: true }); // the toolchain's marker
    // A stand-in for `npm -w web run build`: writes the artefact, newer than the sources.
    await write(root, "build.mjs", {
      body: [
        'import { mkdirSync, utimesSync, writeFileSync } from "node:fs";',
        'mkdirSync("web/dist/assets", { recursive: true });',
        'writeFileSync("web/dist/index.html", "<!doctype html>");',
        'writeFileSync("web/dist/assets/main.js", "//built");',
        "const t = Date.now() / 1000;",
        'utimesSync("web/dist/index.html", t, t);',
        'utimesSync("web/dist/assets/main.js", t, t);',
      ].join("\n"),
    });
    const { code, out } = cli(root, "--build", "--build-guard=off", "--build-cmd=node build.mjs", "--require=bundle", "--json");
    assert.equal(code, 0);
    const verdict = JSON.parse(out);
    assert.equal(verdict.build.attempted, true);
    assert.equal(verdict.build.ok, true);
    assert.equal(verdict.dist.state, "fresh");
    assert.equal(verdict.coverage.bundle.covered, true);
  });

  it("says so instead of building when the tree has no frontend toolchain", async () => {
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    const { code, out } = cli(root, "--build", "--browser-probe=off", "--json");
    assert.equal(code, 0);
    const verdict = JSON.parse(out);
    assert.equal(verdict.build.attempted, false);
    assert.equal(verdict.dist.state, "unbuilt");
  });

  it("reads a busy build lock as a skip, not as a failed build", async () => {
    // build-guard's `run` exits 1 **without running the command** when another lane holds
    // the lock, and says so only in its JSON envelope. Reporting that as "the build failed"
    // would blame the build for a lock — and send the reader looking at Vite.
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    await mkdir(join(root, "web/node_modules"), { recursive: true });
    await write(root, "guard.mjs", {
      body: 'console.log(JSON.stringify({ ok: true, held: false, path: "…", reason: "busy" }));\nprocess.exit(1);\n',
    });
    const env = { ...process.env, OPENCLAW_TEAM_BUILD_GUARD: join(root, "guard.mjs") };
    const { out } = cliWithEnv(root, ["--build", "--build-cmd=node never-runs.mjs", "--browser-probe=off", "--json"], env);
    const verdict = JSON.parse(out);
    assert.equal(verdict.build.lockBusy, true);
    assert.equal(verdict.build.ok, false);
    assert.match(verdict.build.reason, /another lane holds the build lock/);
  });

  it("reports a failed build rather than swallowing it", async () => {
    const root = await makeTree();
    await write(root, "web/src/main.js", { mtime: T1 });
    await mkdir(join(root, "web/node_modules"), { recursive: true });
    await write(root, "build.mjs", { body: 'console.error("vite: cannot find the native binding");\nprocess.exit(1);\n' });
    const { out } = cli(root, "--build", "--build-guard=off", "--build-cmd=node build.mjs", "--json");
    const verdict = JSON.parse(out);
    assert.equal(verdict.build.ok, false);
    assert.equal(verdict.build.rc, 1);
    assert.equal(verdict.dist.state, "unbuilt", "a failed build leaves the tree exactly as it was");
  });
});
