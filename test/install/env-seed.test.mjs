/**
 * `install.sh` seeds one install-root `.env`, never per host and never over an
 * existing file.
 *
 * The file is the only place a fresh install's default board URL lives, so this
 * suite pins the three things that keep it safe: 0600, idempotence (a token may
 * be inside), and the `MEERKAT_TASKPANEL_ENV_FILE` escape hatch used by the test
 * suite and a read-only package root.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { loadEnvFile } from "../../src/foundation/env-config.mjs";
import { slaEnvDefaults } from "../../src/foundation/sla-config.mjs";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-env-seed-" });

after(cleanup);

function fakeCli(binDir) {
  const dest = join(binDir, "claude");
  writeFileSync(dest, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(dest, 0o755);
}

function install(home, dataDir, envFile, extra = []) {
  const bin = makeTempDir();
  fakeCli(bin);
  return runInstall(["--target", "claude", "--prefix", home, ...extra], {
    PATH: `${bin}:${process.env.PATH}`,
    TASKD_DATA_DIR: dataDir,
    MEERKAT_TASKPANEL_ENV_FILE: envFile,
  });
}

describe("install.sh: the install-root .env", () => {
  it("creates it 0600 with the default board URL", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const envFile = join(dataDir, ".env");
    const run = install(home, dataDir, envFile);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(envFile), true);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    assert.match(readFileSync(envFile, "utf8"), /^TASKD_URL=http:\/\/localhost:9527$/m);
  });

  it("keeps an existing file, even with --force", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const envFile = join(dataDir, ".env");
    writeFileSync(envFile, "TASKD_URL=http://board.example:9600\n", "utf8");
    const run = install(home, dataDir, envFile, ["--force"]);
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(envFile, "utf8");
    assert.match(text, /^TASKD_URL=http:\/\/board\.example:9600$/m, "the operator's value survives");
    assert.doesNotMatch(text, /^TASKD_URL=http:\/\/localhost:9527$/m);
  });

  it("--dry-run prints the path and writes nothing", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const envFile = join(dataDir, ".env");
    const run = install(home, dataDir, envFile, ["--dry-run"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(envFile), false);
    assert.match(run.stdout, /would create .*\.env/);
  });

  it("the generated template parses with the client loader", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const envFile = join(dataDir, ".env");
    assert.equal(install(home, dataDir, envFile).status, 0);
    const config = loadEnvFile({ flag: envFile, env: {} });
    assert.equal(config.present, true);
    assert.equal(config.vars.get("TASKD_URL"), "http://localhost:9527");
  });

  it("lists every SLA key with its default, commented out and inert", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const envFile = join(dataDir, ".env");
    assert.equal(install(home, dataDir, envFile).status, 0);
    const text = readFileSync(envFile, "utf8");
    const defaults = slaEnvDefaults();
    for (const [key, value] of Object.entries(defaults)) {
      assert.match(text, new RegExp(`^# ${key}=${value}$`, "m"), key);
    }
    // Commented means the loader sees none of them: the code defaults apply.
    const config = loadEnvFile({ flag: envFile, env: {} });
    assert.equal([...config.vars.keys()].some((key) => key.startsWith("TASKD_SLA_")), false);
  });

  it("does not write the checkout when the override names another path", () => {
    const rootEnv = join(ROOT, ".env");
    const hadRootEnv = existsSync(rootEnv);
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const envFile = join(dataDir, ".env");
    assert.equal(install(home, dataDir, envFile).status, 0);
    assert.equal(existsSync(envFile), true);
    if (!hadRootEnv) assert.equal(existsSync(rootEnv), false, "the default path was not touched");
  });
});
