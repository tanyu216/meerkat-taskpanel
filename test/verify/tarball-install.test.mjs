/**
 * Tests for `scripts/verify/tarball-install.mjs` and its two helpers.
 *
 * What can run on the host is the refusal path: a missing tarball, a package root
 * that is not a package, and the environment scrub. The real install boots a
 * board and installs from npm, so it belongs to the container suite
 * (`docker/verify-in-container.sh`); these cases never start a server.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ROOT, verifyTarballInstall } from "../../scripts/verify/tarball-install.mjs";
import { SCRUB_PREFIXES, scrubEnv } from "../../scripts/verify/lib/scrub-env.mjs";
import { smokeInstalledBoard } from "../../scripts/verify/lib/installed-board.mjs";

const SCRIPT = join(ROOT, "scripts", "verify", "tarball-install.mjs");
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-tarball-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("tarball-install — refusals", () => {
  it("fails before installing when the tarball does not exist", async () => {
    const dir = await makeTree();
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--tarball", join(dir, "missing.tgz"), "--expected-version", "0.0.1"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest check/);
  });

  it("prints usage with --help", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--tarball/);
  });

  it("does not treat an empty directory as a package root", async () => {
    const dir = await makeTree();
    await assert.rejects(
      () => smokeInstalledBoard({ packageRoot: dir }),
      /src\/cli\/index\.mjs/,
      "the smoke must name the missing entry point, not spawn something else",
    );
  });

  it("does not install when the caller's own package has the wrong version", async () => {
    // The manifest check runs before the install; a real tarball is required to
    // reach the version comparison, so that case lives in the container suite.
    const dir = await makeTree();
    await writeFile(join(dir, "not-a-tarball.tgz"), "not gzip\n", "utf8");
    await assert.rejects(
      () => verifyTarballInstall({ tarball: join(dir, "not-a-tarball.tgz"), expectedVersion: "9.9.9" }),
      /manifest check/,
    );
  });
});

describe("scrub-env — the base environment", () => {
  it("drops every board prefix and keeps the rest", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      TASKCTL_HUMAN: "alice",
      TASKD_DATA_DIR: "/data",
      TASKD_URL: "http://127.0.0.1:9527",
      MEERKAT_TASKPANEL_ENV_FILE: "/tmp/x.env",
      MEERKAT_TASKPANEL_CONFIG_DIR: "/tmp/kind",
    };
    const clean = scrubEnv(env);
    assert.deepEqual(clean, { PATH: "/usr/bin", HOME: "/home/tester" });
    for (const prefix of SCRUB_PREFIXES) {
      assert.ok(Object.keys(clean).every((key) => !key.startsWith(prefix)));
    }
  });

  it("is a copy: mutating it does not touch the caller's environment", () => {
    const env = { PATH: "/usr/bin" };
    const clean = scrubEnv(env);
    clean.EXTRA = "1";
    assert.deepEqual(env, { PATH: "/usr/bin" });
  });
});
