/**
 * The server materializer: what lands in `<tree>/`, what survives a re-run, and
 * what `--force` refreshes versus what it must never touch.
 *
 * `server.sh` owns the `.env` seed and `install.sh` owns dispatch; this file
 * exercises the copy half directly with a synthetic source root, so it runs
 * without a checkout's `web/` toolchain.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { installServer, planWebInstall } from "../../scripts/install/lib/server-install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `tp-${name}-`));
  dirs.push(dir);
  return dir;
}

/** A minimal source root that looks like the package/checkout. */
function sourceRoot({ web = false } = {}) {
  const root = tempDir("server-src");
  mkdirSync(join(root, "src", "server"), { recursive: true });
  mkdirSync(join(root, "src", "cli"), { recursive: true });
  mkdirSync(join(root, "src", "core", "storage", "migrations"), { recursive: true });
  writeFileSync(join(root, "src", "server", "main.mjs"), "// server\n");
  writeFileSync(join(root, "src", "cli", "index.mjs"), "// cli\n");
  writeFileSync(join(root, "src", "core", "storage", "migrations", "0001_init.sql"), "-- migration\n");
  for (const name of ["package.json", "README.md", "README.zh-CN.md", "LICENSE"]) {
    writeFileSync(join(root, name), `${name}\n`);
  }
  mkdirSync(join(root, "scripts", "install", "templates"), { recursive: true });
  cpTree(join(ROOT, "scripts", "install", "templates", "server"), join(root, "scripts", "install", "templates", "server"));
  if (web) {
    mkdirSync(join(root, "web", "dist"), { recursive: true });
    writeFileSync(join(root, "web", "dist", "index.html"), "<html></html>\n");
  }
  return root;
}

function cpTree(from, to) {
  // `cp -R` semantics without importing cpSync into every helper.
  mkdirSync(to, { recursive: true });
  for (const name of ["taskd", "taskctl"]) {
    writeFileSync(join(to, name), readFileSync(join(from, name)));
  }
}

describe("server-install — planWebInstall", () => {
  it("copies a built dist, builds when modules exist, otherwise warns", () => {
    const root = tempDir("web-plan");
    const dist = join(root, "dist");
    const modules = join(root, "node_modules");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>\n");
    assert.deepEqual(planWebInstall({ distDir: dist, nodeModulesDir: modules }), {
      action: "copy",
      source: dist,
    });

    const empty = tempDir("web-empty");
    mkdirSync(join(empty, "node_modules"), { recursive: true });
    assert.equal(
      planWebInstall({ distDir: join(empty, "dist"), nodeModulesDir: join(empty, "node_modules") }).action,
      "build",
    );
    assert.equal(
      planWebInstall({ distDir: join(empty, "dist"), nodeModulesDir: join(empty, "node_modules"), skipBuild: true }).action,
      "warn",
    );
    assert.equal(
      planWebInstall({ distDir: join(root, "none"), nodeModulesDir: join(root, "none-modules") }).action,
      "warn",
    );
  });
});

describe("server-install — the tree", () => {
  it("copies src, metadata and the launchers; creates .data 0700; never seeds .env", () => {
    const source = sourceRoot({ web: true });
    const dest = join(tempDir("server-dest"), ".meerkat-taskpanel");

    const report = installServer({ root: source, dest, skipWebBuild: true });
    assert.equal(report.ok, true, report.error);
    assert.ok(existsSync(join(dest, "src", "server", "main.mjs")));
    assert.ok(existsSync(join(dest, "src", "core", "storage", "migrations", "0001_init.sql")));
    assert.ok(existsSync(join(dest, "package.json")));
    assert.ok(existsSync(join(dest, "web", "dist", "index.html")));
    assert.equal(statSync(join(dest, ".data")).mode & 0o777, 0o700);

    for (const name of ["taskd", "taskctl"]) {
      const launcher = join(dest, "bin", name);
      assert.equal(statSync(launcher).mode & 0o777, 0o755);
      const text = readFileSync(launcher, "utf8");
      assert.match(text, /^#!\/usr\/bin\/env bash/);
      assert.ok(text.includes("BASH_SOURCE"));
      assert.ok(text.includes(name === "taskd" ? "src/server/main.mjs" : "src/cli/index.mjs"));
    }
    assert.equal(existsSync(join(dest, ".env")), false, "server.sh owns the .env seed");
  });

  it("is idempotent and --force refreshes managed bytes without touching .data", () => {
    const source = sourceRoot();
    const dest = join(tempDir("server-idem"), ".meerkat-taskpanel");
    assert.equal(installServer({ root: source, dest, skipWebBuild: true }).ok, true);

    writeFileSync(join(dest, ".data", "sentinel"), "keep me\n");
    writeFileSync(join(dest, "src", "stale.mjs"), "// gone after --force\n");
    writeFileSync(join(dest, "src", "server", "main.mjs"), "// drifted\n");

    const again = installServer({ root: source, dest, skipWebBuild: true });
    assert.equal(again.ok, true);
    assert.equal(readFileSync(join(dest, "src", "server", "main.mjs"), "utf8"), "// server\n");
    assert.ok(existsSync(join(dest, "src", "stale.mjs")), "without --force a stale file is kept");
    assert.equal(readFileSync(join(dest, ".data", "sentinel"), "utf8"), "keep me\n");

    const forced = installServer({ root: source, dest, force: true, skipWebBuild: true });
    assert.equal(forced.ok, true);
    assert.equal(existsSync(join(dest, "src", "stale.mjs")), false, "--force prunes stale src files");
    assert.equal(readFileSync(join(dest, ".data", "sentinel"), "utf8"), "keep me\n");
  });

  it("--dry-run writes nothing", () => {
    const source = sourceRoot();
    const dest = join(tempDir("server-dry"), ".meerkat-taskpanel");
    const report = installServer({ root: source, dest, dryRun: true, skipWebBuild: true });
    assert.equal(report.ok, true);
    assert.equal(existsSync(dest), false);
  });

  it("fails when the source has no src/", () => {
    const source = tempDir("server-empty");
    const dest = join(tempDir("server-empty-dest"), ".meerkat-taskpanel");
    const report = installServer({ root: source, dest, skipWebBuild: true });
    assert.equal(report.ok, false);
    assert.match(report.error, /src is missing|is missing/);
  });
});
