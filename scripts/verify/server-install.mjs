#!/usr/bin/env node
/**
 * End-to-end server install check — container-only.
 *
 * It installs into a throwaway home (never the real `$HOME`), exercises both
 * entry points (the npm/npx wrapper and the source `install.sh`), and finally
 * starts the installed `bin/taskd` on an ephemeral port to prove `/health`.
 *
 * This starts a real board, so it belongs to the in-container suite
 * (`docker/verify-in-container.sh`), not the host-only static checks.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_ENV = {
  ...process.env,
  MEERKAT_TASKPANEL_SKIP_TASKD_SERVICE: "1",
  MEERKAT_TASKPANEL_SKIP_WEB_BUILD: "1",
  MEERKAT_TASKPANEL_SKIP_NODE_CHECK: "1",
};

const dirs = [];
function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "tp-server-verify-"));
  dirs.push(dir);
  return dir;
}

function fail(message) {
  throw new Error(message);
}

function check(condition, label) {
  if (!condition) fail(label);
  console.log(`OK ${label}`);
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function runInstall(kind, home, extra = []) {
  const args = kind === "npx"
    ? [process.execPath, [join(ROOT, "scripts", "install", "cli.mjs"), "install", "--prefix", home, "--skip-web-build", ...extra]]
    : ["bash", [join(ROOT, "install.sh"), "--target", "server", "--prefix", home, "--skip-web-build", "--skip-node-check", ...extra]];
  return spawnSync(args[0], args[1], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...BASE_ENV, HOME: home },
  });
}

function assertTree(tree) {
  check(existsSync(join(tree, "src", "server", "main.mjs")), "src/server/main.mjs");
  check(
    readdirSync(join(tree, "src", "core", "storage", "migrations")).some((name) => name.endsWith(".sql")),
    "a migration .sql",
  );
  check(existsSync(join(tree, "package.json")), "package.json");
  check(mode(join(tree, ".env")) === 0o600, ".env is 0600");
  check(mode(join(tree, ".data")) === 0o700, ".data is 0700");
  for (const name of ["taskd", "taskctl"]) {
    const file = join(tree, "bin", name);
    check(mode(file) === 0o755, `bin/${name} is 0755`);
    check(readFileSync(file, "utf8").includes("BASH_SOURCE"), `bin/${name} derives its root`);
  }
}

async function healthSmoke(tree) {
  const dataDir = join(tree, ".data");
  const pointer = join(dataDir, "runtime.json");
  rmSync(pointer, { force: true });
  const env = {
    ...BASE_ENV,
    TASKD_HOST: "127.0.0.1",
    TASKD_PORT: "0",
    TASKD_DATA_DIR: dataDir,
    TASKD_RUNTIME_POINTER: pointer,
  };
  // The tree's own `.env` is the config under test; an inherited override would
  // point the smoke at somebody else's board.
  delete env.MEERKAT_TASKPANEL_ENV_FILE;
  const child = spawn(join(tree, "bin", "taskd"), [], { env, stdio: "ignore" });

  try {
    const deadline = Date.now() + 10_000;
    let url = null;
    while (Date.now() < deadline) {
      if (existsSync(pointer)) {
        try {
          url = JSON.parse(readFileSync(pointer, "utf8")).url ?? null;
        } catch {
          url = null;
        }
        if (url !== null) break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    check(url !== null, "the installed taskd wrote its runtime pointer");
    const response = await fetch(`${url}/health`);
    check(response.status === 200, "GET /health is 200");
    const body = await response.json();
    check(body.ok === true && body.data?.status === "ok", "/health reports ok");
  } finally {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((done) => child.once("exit", () => done(true))),
      new Promise((done) => setTimeout(() => done(false), 5_000)),
    ]);
    if (!exited) child.kill("SIGKILL");
    check(exited, "the installed taskd stops on SIGTERM");
  }
}

async function main() {
  // 1. npm/npx wrapper, server only.
  const npxHome = tempHome();
  const npx = runInstall("npx", npxHome);
  check(npx.status === 0, `npx wrapper installs (exit ${npx.status}): ${npx.stderr}`);
  const npxTree = join(npxHome, ".meerkat-taskpanel");
  assertTree(npxTree);

  // 2. Source install, server only.
  const sourceHome = tempHome();
  const source = runInstall("source", sourceHome);
  check(source.status === 0, `install.sh installs (exit ${source.status}): ${source.stderr}`);
  assertTree(join(sourceHome, ".meerkat-taskpanel"));

  // 3. Idempotence: the config and the data survive.
  const before = readFileSync(join(npxTree, ".env"), "utf8");
  writeFileSync(join(npxTree, ".data", "sentinel"), "keep me\n");
  check(runInstall("npx", npxHome).status === 0, "a second npx install exits 0");
  check(readFileSync(join(npxTree, ".env"), "utf8") === before, "the second run keeps .env bytes");
  check(existsSync(join(npxTree, ".data", "sentinel")), "the second run keeps .data");

  // 4. --force refreshes managed bytes and prunes stale src files.
  writeFileSync(join(npxTree, "src", "stale.mjs"), "// stale\n");
  check(runInstall("npx", npxHome, ["--force"]).status === 0, "--force exits 0");
  check(!existsSync(join(npxTree, "src", "stale.mjs")), "--force prunes a stale src file");
  check(readFileSync(join(npxTree, ".env"), "utf8") === before, "--force keeps .env");
  check(existsSync(join(npxTree, ".data", "sentinel")), "--force keeps .data");

  // 5. Dry-run writes nothing.
  const dryHome = tempHome();
  check(runInstall("npx", dryHome, ["--dry-run"]).status === 0, "dry-run exits 0");
  check(!existsSync(join(dryHome, ".meerkat-taskpanel")), "dry-run writes no tree");

  // 6. Full install: the host shim/config point at the tree.
  const fullHome = tempHome();
  const full = runInstall("npx", fullHome, ["--target", "server,claude"]);
  check(full.status === 0, `full install exits 0: ${full.stderr}`);
  const fullTree = join(fullHome, ".meerkat-taskpanel");
  assertTree(fullTree);
  const shim = readFileSync(join(fullHome, ".claude", "bin", "taskctl"), "utf8");
  check(shim.includes(join(fullTree, "src", "cli", "index.mjs")), "the host shim drives the installed tree");
  check(
    readFileSync(join(fullHome, ".claude", "meerkat-taskpanel.env"), "utf8").includes(
      `MEERKAT_TASKPANEL_REPO=${fullTree}`,
    ),
    "the host config names the installed tree",
  );

  // 7. The installed launchers run.
  const version = spawnSync(join(npxTree, "bin", "taskctl"), ["--version"], {
    encoding: "utf8",
    env: { ...BASE_ENV, HOME: npxHome },
  });
  check(version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), "bin/taskctl --version");

  // 8. The installed server answers /health.
  await healthSmoke(npxTree);

  console.log("server install: OK");
  return 0;
}

try {
  if (isEntryPoint(import.meta.url)) {
    const code = await main();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  }
} catch (err) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  process.stderr.write(`server install: FAIL — ${err.message}\n`);
  process.exit(1);
}
