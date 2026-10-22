/**
 * The acceptance-policy wizard and its two persisted copies.
 *
 * `install.sh` asks "who may close a task?" when stdin is a TTY and no flag was
 * given, defaults to **both** everywhere else, and writes the answer **twice**:
 *
 *   * `<target_home>/<agent-dir>/meerkat-taskpanel.env` — what the loop believes
 *     (`MEERKAT_TASKPANEL_ACCEPTANCE_POLICY`);
 *   * the install-root `.env` — what the board enforces
 *     (`TASKD_ACCEPTANCE_POLICY`). The board is authoritative, and this file is
 *     shared with the Access panel and the client, so the write merges rather
 *     than rewrites.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { createInstallHarness } from "./helpers/install-harness.mjs";

const { makeTempDir, runInstall, cleanup } = createInstallHarness({ prefix: "meerkat-taskpanel-acceptance-" });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

after(cleanup);

function makeFakeCli(binDir, name) {
  const dest = join(binDir, name);
  writeFileSync(dest, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

const agentConfig = (home) => {
  const path = join(home, ".claude", "meerkat-taskpanel.env");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const boardConfig = (envFile) => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");

describe("install.sh: acceptance policy", () => {
  it("defaults to both and persists it in the agent config and the install-root .env", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const bin = makeTempDir();
    const envFile = join(dataDir, ".env");
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--prefix", home], {
      PATH: `${bin}:${process.env.PATH}`,
      TASKD_DATA_DIR: dataDir,
      MEERKAT_TASKPANEL_ENV_FILE: envFile,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(agentConfig(home), /^MEERKAT_TASKPANEL_ACCEPTANCE_POLICY=both$/m);
    assert.match(boardConfig(envFile), /^TASKD_ACCEPTANCE_POLICY=both$/m);
  });

  it("takes both spellings, in joined and spaced form, and refuses a misspelt value", () => {
    const cases = [
      { flags: ["--acceptance=human-only"], expected: "human-only" },
      { flags: ["--acceptance", "both"], expected: "both" },
      { flags: ["--acceptance-policy=agent-only"], expected: "agent-only" },
      { flags: ["--acceptance-policy", "human-only"], expected: "human-only" },
    ];
    for (const { flags, expected } of cases) {
      const home = makeTempDir();
      const dataDir = makeTempDir();
      const bin = makeTempDir();
      const envFile = join(dataDir, ".env");
      makeFakeCli(bin, "claude");
      const run = runInstall(["--target", "claude", "--prefix", home, ...flags], {
        PATH: `${bin}:${process.env.PATH}`,
        TASKD_DATA_DIR: dataDir,
        MEERKAT_TASKPANEL_ENV_FILE: envFile,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(agentConfig(home), new RegExp(`^MEERKAT_TASKPANEL_ACCEPTANCE_POLICY=${expected}$`, "m"));
      assert.match(boardConfig(envFile), new RegExp(`^TASKD_ACCEPTANCE_POLICY=${expected}$`, "m"));
    }

    const run = runInstall(["--target", "claude", "--acceptance=loop-only", "--dry-run"]);
    assert.equal(run.status, 2, "a misspelt policy installs nothing");
    assert.match(run.stderr, /human-only, both or agent-only/);
  });

  it("merges into an existing .env instead of erasing another writer's keys", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const bin = makeTempDir();
    const envFile = join(dataDir, ".env");
    makeFakeCli(bin, "claude");
    writeFileSync(envFile, "TASKD_ALLOW_LIST_ENABLED=true\nTASKD_ALLOW_CIDRS=10.0.0.0/8\n", "utf8");

    const run = runInstall(["--target", "claude", "--prefix", home, "--acceptance=human-only"], {
      PATH: `${bin}:${process.env.PATH}`,
      TASKD_DATA_DIR: dataDir,
      MEERKAT_TASKPANEL_ENV_FILE: envFile,
    });
    assert.equal(run.status, 0, run.stderr);
    const text = boardConfig(envFile);
    assert.match(text, /^TASKD_ALLOW_LIST_ENABLED=true$/m);
    assert.match(text, /^TASKD_ALLOW_CIDRS=10\.0\.0\.0\/8$/m);
    assert.match(text, /^TASKD_ACCEPTANCE_POLICY=human-only$/m);
    assert.equal((text.match(/^TASKD_ACCEPTANCE_POLICY=/gm) ?? []).length, 1, "one active line, not an append per run");
  });

  it("is idempotent: a second install leaves one key and the same value", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const bin = makeTempDir();
    const envFile = join(dataDir, ".env");
    makeFakeCli(bin, "claude");
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      TASKD_DATA_DIR: dataDir,
      MEERKAT_TASKPANEL_ENV_FILE: envFile,
    };
    assert.equal(runInstall(["--target", "claude", "--prefix", home, "--acceptance=both"], env).status, 0);
    assert.equal(runInstall(["--target", "claude", "--prefix", home, "--acceptance=both", "--force"], env).status, 0);
    const text = boardConfig(envFile);
    assert.equal((text.match(/^TASKD_ACCEPTANCE_POLICY=/gm) ?? []).length, 1);
    assert.match(text, /^TASKD_ACCEPTANCE_POLICY=both$/m);
  });

  it("--dry-run writes neither copy", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const bin = makeTempDir();
    const envFile = join(dataDir, ".env");
    makeFakeCli(bin, "claude");
    const run = runInstall(["--target", "claude", "--prefix", home, "--acceptance=agent-only", "--dry-run"], {
      PATH: `${bin}:${process.env.PATH}`,
      TASKD_DATA_DIR: dataDir,
      MEERKAT_TASKPANEL_ENV_FILE: envFile,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(boardConfig(envFile), "", "no .env");
    assert.match(run.stdout, /would write TASKD_ACCEPTANCE_POLICY=agent-only/);
    assert.match(run.stdout, /would create .*\.env/);
  });

  it("agent-only warns (but does not refuse) when nothing can close a card", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const bin = makeTempDir();
    const envFile = join(dataDir, ".env");
    makeFakeCli(bin, "claude");
    const run = runInstall(
      ["--target", "claude", "--prefix", home, "--acceptance=agent-only", "--workflow=no", "--auto-accept-reviews=no"],
      { PATH: `${bin}:${process.env.PATH}`, TASKD_DATA_DIR: dataDir, MEERKAT_TASKPANEL_ENV_FILE: envFile },
    );
    assert.equal(run.status, 0, "warnings only — who closes is the skill's business");
    assert.match(run.stderr, /agent-only with --workflow=no/);
    assert.match(run.stderr, /agent-only with --auto-accept-reviews=no/);
    assert.match(run.stderr, /agent-only with no --reviewer/);
  });
});
