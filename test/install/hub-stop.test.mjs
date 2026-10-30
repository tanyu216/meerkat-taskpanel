/**
 * The installer's local-hub stop.
 *
 * The hub is not a unit: it is started on demand and outlives the command that
 * needed it, so an install that replaced `src/**` would otherwise leave it
 * running the previous code until it idles out. When the server tree changed
 * the installer stops it; the next consumer starts one from the new tree. A dry
 * run, an agent-only install and an unchanged tree never touch it.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";

import { hubPaths, writeJsonFile } from "../../src/cli/hub/runtime.mjs";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const TOKEN = "td_install_hub";
/** The harness bypasses the step by default; every case that tests it clears it. */
const harness = createInstallHarness({ prefix: "meerkat-taskpanel-hub-stop-" });

const healthServers = [];
const children = [];

after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const child of healthServers) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  harness.cleanup();
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, budgetMs = 5_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(10);
  }
  return false;
}

/** A board that answers `/health`, so the installed CLI resolves without autostart. */
async function startHealthServer() {
  const script = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: { status: "ok" } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  healthServers.push(child);
  const port = await new Promise((done, fail) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const [first] = buffer.split("\n");
      if (/^\d+$/.test(first.trim())) done(Number(first.trim()));
    });
    child.on("exit", (code) => fail(new Error(`the /health server exited early (${code})`)));
  });
  return { port, url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

const serverArgs = (home) => [
  "--target", "server",
  "--prefix", home,
  "--force",
  "--skip-node-check",
  "--skip-web-build",
];

describe("install.sh: the local event hub", () => {
  it("skips the stop when the contract's test-only bypass is set", () => {
    const home = harness.makeTempDir();
    const result = harness.runInstall(serverArgs(home), { MEERKAT_TASKPANEL_SKIP_HUB_STOP: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hub: skipped \(MEERKAT_TASKPANEL_SKIP_HUB_STOP=1 — tests only\)/);
  });

  it("reports when no hub is running", async () => {
    const health = await startHealthServer();
    const home = harness.makeTempDir();
    const result = harness.runInstall(serverArgs(home), {
      MEERKAT_TASKPANEL_SKIP_HUB_STOP: "",
      MEERKAT_HUB_DIR: harness.makeTempDir(),
      TASKD_URL: health.url,
      TASKD_TOKEN: TOKEN,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hub: no local event hub is running/);
  });

  it("stops the hub that is still running the replaced code", async () => {
    const health = await startHealthServer();
    const hubDir = harness.makeTempDir();
    const home = harness.makeTempDir();
    const paths = hubPaths(health.url, TOKEN, { MEERKAT_HUB_DIR: hubDir });

    // A stand-in that behaves like the real stop(): it clears its own pointer and
    // owner on SIGTERM. The installer runs synchronously here, so the test process
    // cannot reap the child while it waits; the files are what prove the stop.
    const sleeper = `
      const { rmSync } = require("node:fs");
      process.on("SIGTERM", () => {
        for (const file of process.env.TP_CLEANUP.split(":")) rmSync(file, { force: true });
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", sleeper], {
      stdio: "ignore",
      env: { ...process.env, TP_CLEANUP: `${paths.pointer}:${paths.owner}` },
    });
    children.push(child);

    writeJsonFile(paths.pointer, {
      version: 1,
      protocol: 1,
      key: paths.key,
      pid: child.pid,
      port: 1,
      token: TOKEN,
      log: paths.log,
      startedAt: new Date().toISOString(),
    });
    writeJsonFile(paths.owner, { pid: child.pid, startedAt: Date.now() });

    const result = harness.runInstall(serverArgs(home), {
      MEERKAT_TASKPANEL_SKIP_HUB_STOP: "",
      MEERKAT_HUB_DIR: hubDir,
      TASKD_URL: health.url,
      TASKD_TOKEN: TOKEN,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`hub: stopped the local event hub \\(pid ${child.pid}\\)`));
    assert.equal(await waitForExit(child.pid), true);
  });

  it("does nothing when the server tree did not change", () => {
    const home = harness.makeTempDir();
    const first = harness.runInstall(serverArgs(home), { MEERKAT_TASKPANEL_SKIP_HUB_STOP: "1" });
    assert.equal(first.status, 0, first.stderr);

    const second = harness.runInstall(serverArgs(home), { MEERKAT_TASKPANEL_SKIP_HUB_STOP: "" });
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /^hub:/m);
  });

  it("skips a dry run", () => {
    const home = harness.makeTempDir();
    const result = harness.runInstall(
      ["--target", "server", "--prefix", home, "--dry-run", "--skip-node-check", "--skip-web-build"],
      {
        MEERKAT_TASKPANEL_SKIP_HUB_STOP: "",
        MEERKAT_TASKPANEL_RUNTIME_CHANGED: "1",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hub: skipped \(dry-run\)/);
  });

  it("does nothing on an agent-only install", () => {
    const home = harness.makeTempDir();
    const result = harness.runInstall(
      ["--target", "claude", "--prefix", home, "--force", "--skip-node-check"],
      { MEERKAT_TASKPANEL_SKIP_HUB_STOP: "" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^hub:/m);
  });
});
