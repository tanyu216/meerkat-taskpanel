/**
 * Prove an installed package root actually runs: `--version`, a board on an
 * ephemeral port, `/health`, the static shell, and a clean SIGTERM.
 *
 * This is deliberately about the *installed* tree — a tarball's `node_modules`
 * directory or a published package — not about the checkout. Everything it needs
 * is found relative to `packageRoot`, and the environment is scrubbed first, so a
 * `TASKD_*` exported on the developer's machine cannot redirect the smoke at
 * somebody else's board.
 *
 * Node builtins only; no dependencies, no network beyond loopback.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubEnv } from "./scrub-env.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Run one installed CLI entry point.
 *
 * @param {string} script absolute path to a `.mjs` file inside `packageRoot`
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
async function runNode(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((done) => child.once("exit", (code, signal) => done(code ?? `signal:${signal}`)));
  return { status, stdout, stderr };
}

/**
 * Boot the installed board once and check it answers.
 *
 * @param {{packageRoot: string, expectedVersion?: string, env?: Record<string, string|undefined>, timeoutMs?: number, log?: (line: string) => void}} options
 * @returns {Promise<{version: string, url: string}>}
 * @throws {Error} with a named check when anything fails
 */
export async function smokeInstalledBoard({ packageRoot, expectedVersion, env = {}, timeoutMs = 15_000, log = () => {} }) {
  const check = (condition, label) => {
    if (!condition) throw new Error(label);
    log(`OK ${label}`);
  };

  const baseEnv = { ...scrubEnv(), ...env };

  // 1. The installed CLI reports a version — and, when the caller knows which
  //    release it installed, exactly that one.
  const cli = join(packageRoot, "src", "cli", "index.mjs");
  check(existsSync(cli), `the package root has src/cli/index.mjs (${packageRoot})`);
  const versionResult = await runNode(cli, ["--version"], baseEnv);
  check(versionResult.status === 0, `installed taskctl --version exits 0 (${versionResult.stderr.trim()})`);
  const version = versionResult.stdout.trim();
  check(/^\d+\.\d+\.\d+/.test(version), `installed taskctl --version prints a semver (got '${version}')`);
  if (expectedVersion !== undefined) {
    check(version === expectedVersion, `installed version is ${expectedVersion} (got '${version}')`);
  }

  // 2. A board from an empty data dir, on an ephemeral port.
  const work = mkdtempSync(join(tmpdir(), "meerkat-installed-smoke-"));
  const dataDir = join(work, "data");
  const pointer = join(work, "runtime.json");
  const envFile = join(work, "empty.env");
  writeFileSync(envFile, "", "utf8");

  const serverEnv = {
    ...baseEnv,
    MEERKAT_TASKPANEL_ENV_FILE: envFile,
    TASKD_HOST: "127.0.0.1",
    TASKD_PORT: "0",
    TASKD_DATA_DIR: dataDir,
    TASKD_RUNTIME_POINTER: pointer,
  };
  const server = join(packageRoot, "src", "server", "main.mjs");
  check(existsSync(server), "the package root has src/server/main.mjs");

  const child = spawn(process.execPath, [server], { env: serverEnv, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const deadline = Date.now() + timeoutMs;
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
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    check(url !== null, `the installed taskd wrote its runtime pointer (stderr: ${stderr.trim().slice(0, 400)})`);

    const health = await fetch(`${url}/health`);
    check(health.status === 200, `GET /health is 200 (got ${health.status})`);
    const body = await health.json();
    check(body?.ok === true && body?.data?.status === "ok", "/health reports ok");
    check(body?.data?.version === version, "/health reports the same version as the CLI");

    // The static shell is part of the package (`web/dist`), so a publish that
    // dropped it fails here rather than at a user's first page load.
    const page = await fetch(`${url}/`);
    check(page.status === 200, `GET / is 200 (got ${page.status})`);
    const html = await page.text();
    check(html.includes('id="app"'), "GET / serves the board shell");

    return { version, url };
  } finally {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((done) => child.once("exit", () => done(true))),
      sleep(10_000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  }
}
