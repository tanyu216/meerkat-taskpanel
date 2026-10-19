/**
 * The Access panel's server half: the policy store and `GET|PUT /api/v1/access`.
 *
 * Three properties matter more than any payload:
 *
 *   * **the two defaults** — allow-list off, seeded with the two private ranges;
 *   * **persistence** — a save writes `<dataDir>/taskd.env`, and a fresh `taskd`
 *     on the same directory reads it back;
 *   * **locality** — the read returns the bearer token, so both verbs are
 *     loopback-only and an environment-owned policy refuses a save rather than
 *     letting the panel believe it stuck.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { authorize } from "../../src/server/auth.mjs";
import { isAddressAllowed } from "../../src/server/cidr.mjs";
import {
  accessEnvPath,
  allowListFrom,
  readAccessConfig,
  validateCidrs,
  writeAccessConfig,
} from "../../src/server/access-config.mjs";
import { readAcceptancePolicy, writeAcceptancePolicy } from "../../src/core/acceptance-policy.mjs";
import { createTaskd } from "../../src/server/index.mjs";
import { ALLOW_CIDRS_ENV } from "../../src/shared/constants.mjs";

const tempDirs = [];
const servers = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-access-"));
  tempDirs.push(dir);
  return dir;
}

async function start(options = {}) {
  const taskd = await createTaskd({ host: "127.0.0.1", port: 0, env: {}, ...options });
  servers.push(taskd);
  return taskd;
}

after(async () => {
  for (const taskd of servers) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function call(taskd, method, path, body) {
  const response = await fetch(`${taskd.url}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

const dataOf = (result) => {
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.data;
};

describe("server/access-config — defaults and validation", () => {
  it("defaults to an off list seeded with the two private ranges", () => {
    const dir = tempDir();
    const config = readAccessConfig({ dataDir: dir, env: {} });
    assert.deepEqual(config, {
      enabled: false,
      cidrs: ["192.168.0.0/16", "10.0.0.0/8"],
      source: "default",
      file: accessEnvPath(dir),
    });
    assert.deepEqual(allowListFrom(config), { configured: false, rules: [], invalid: [] });
  });

  it("keeps an enabled empty list as deny-all, not as 'no list'", () => {
    const parsed = allowListFrom({ enabled: true, cidrs: [] });
    assert.deepEqual(parsed, { configured: true, rules: [], invalid: [] });
    assert.equal(isAddressAllowed("10.0.0.7", parsed), false);
  });

  it("treats a process-environment list as env-owned", () => {
    const config = readAccessConfig({ dataDir: tempDir(), env: { [ALLOW_CIDRS_ENV]: "10.0.0.0/8, 2001:db8::/32" } });
    assert.equal(config.source, "env");
    assert.equal(config.enabled, true);
    assert.deepEqual(config.cidrs, ["10.0.0.0/8", "2001:db8::/32"]);
    assert.equal(config.file, null);
  });

  it("refuses an invalid range instead of dropping it", () => {
    assert.throws(() => validateCidrs(["10.0.0.0/8", "not-a-range"]), (err) => {
      assert.equal(err.code, "VALIDATION_FAILED");
      assert.equal(err.details.field, "allow_list.cidrs");
      return true;
    });
    assert.throws(() => validateCidrs([""]), (err) => err.code === "VALIDATION_FAILED");
    assert.throws(() => validateCidrs("10.0.0.0/8"), (err) => err.code === "VALIDATION_FAILED");
  });

  it("trims and de-duplicates a valid list, preserving order", () => {
    assert.deepEqual(validateCidrs([" 10.0.0.0/8 ", "192.168.0.0/16", "10.0.0.0/8"]), [
      "10.0.0.0/8",
      "192.168.0.0/16",
    ]);
  });
});

describe("server/access — the HTTP surface", () => {
  it("answers the persisted token and the default policy", async () => {
    const taskd = await start({ dataDir: tempDir() });
    const data = dataOf(await call(taskd, "GET", "/api/v1/access"));
    assert.equal(data.token, taskd.token);
    assert.equal(data.source, "default");
    assert.deepEqual(data.allow_list, {
      enabled: false,
      cidrs: ["192.168.0.0/16", "10.0.0.0/8"],
    });
    assert.equal(data.config_file, accessEnvPath(taskd.board.dataDir));
  });

  it("saves the switch and the ranges, and a fresh taskd reads them back", async () => {
    const dataDir = tempDir();
    const first = await start({ dataDir });
    const saved = dataOf(
      await call(first, "PUT", "/api/v1/access", {
        allow_list: { enabled: true, cidrs: ["10.0.0.0/8"] },
      }),
    );
    assert.deepEqual(saved.allow_list, { enabled: true, cidrs: ["10.0.0.0/8"] });
    assert.equal(saved.source, "file");

    const file = accessEnvPath(dataDir);
    assert.equal(existsSync(file), true);
    const text = readFileSync(file, "utf8");
    assert.match(text, /^TASKD_ALLOW_LIST_ENABLED=true$/m);
    assert.match(text, /^TASKD_ALLOW_CIDRS=10\.0\.0\.0\/8$/m);

    // The running policy took effect without a restart.
    const meta = dataOf(await call(first, "GET", "/meta"));
    assert.equal(meta.capabilities.allow_list, true);

    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await start({ dataDir });
    const restored = dataOf(await call(second, "GET", "/api/v1/access"));
    assert.equal(restored.source, "file");
    assert.deepEqual(restored.allow_list, { enabled: true, cidrs: ["10.0.0.0/8"] });
    assert.equal(dataOf(await call(second, "GET", "/meta")).capabilities.allow_list, true);
  });

  it("refuses an invalid range and leaves the saved policy untouched", async () => {
    const taskd = await start({ dataDir: tempDir() });
    const result = await call(taskd, "PUT", "/api/v1/access", {
      allow_list: { enabled: true, cidrs: ["10.0.0.0/8", "10.0.0.0/99"] },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "VALIDATION_FAILED");
    assert.equal(existsSync(accessEnvPath(taskd.board.dataDir)), false);

    const current = dataOf(await call(taskd, "GET", "/api/v1/access"));
    assert.deepEqual(current.allow_list, {
      enabled: false,
      cidrs: ["192.168.0.0/16", "10.0.0.0/8"],
    });
  });

  it("rotates the token in the same save when asked", async () => {
    const taskd = await start({ dataDir: tempDir() });
    const before = taskd.token;
    const saved = dataOf(
      await call(taskd, "PUT", "/api/v1/access", {
        allow_list: { enabled: false, cidrs: ["192.168.0.0/16", "10.0.0.0/8"] },
        rotate_token: true,
      }),
    );
    assert.equal(saved.rotated, true);
    assert.notEqual(saved.token, before);
    assert.equal(saved.token, taskd.token);
    assert.equal(dataOf(await call(taskd, "GET", "/api/v1/access")).token, saved.token);
  });

  it("refuses a save when the process environment owns the policy", async () => {
    const taskd = await start({
      dataDir: tempDir(),
      env: { [ALLOW_CIDRS_ENV]: "10.0.0.0/8" },
    });
    const current = dataOf(await call(taskd, "GET", "/api/v1/access"));
    assert.equal(current.source, "env");
    assert.deepEqual(current.allow_list, { enabled: true, cidrs: ["10.0.0.0/8"] });

    const refused = await call(taskd, "PUT", "/api/v1/access", {
      allow_list: { enabled: false, cidrs: [] },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "VALIDATION_FAILED");
    assert.equal(refused.body.error.details.reason, "env_managed");
    assert.equal(existsSync(accessEnvPath(taskd.board.dataDir)), false);
  });

  it("keeps both verbs loopback-only", () => {
    const remote = { socket: { remoteAddress: "10.0.0.7" }, headers: {} };
    const verdict = authorize({
      req: remote,
      url: new URL("http://board/api/v1/access"),
      token: "td_x",
      loopbackOnly: true,
      allowList: { configured: false, rules: [], invalid: [] },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.payload.error.details.reason, "loopback_only");
  });
});

describe("server/access-config — the shared taskd.env", () => {
  it("a policy save keeps the acceptance policy, and vice versa", () => {
    const dir = tempDir();
    writeAcceptancePolicy({ dataDir: dir, policy: "human-only" });
    writeAccessConfig({ dataDir: dir, enabled: true, cidrs: ["10.0.0.0/8"] });
    assert.equal(readAcceptancePolicy({ dataDir: dir, env: {} }).policy, "human-only", "the access save merged");

    writeAcceptancePolicy({ dataDir: dir, policy: "agent-only" });
    assert.deepEqual(
      readAccessConfig({ dataDir: dir, env: {} }).cidrs,
      ["10.0.0.0/8"],
      "the acceptance save merged too",
    );
    const text = readFileSync(accessEnvPath(dir), "utf8");
    assert.equal((text.match(/^TASKD_ACCEPTANCE_POLICY=/gm) ?? []).length, 1);
    assert.equal((text.match(/^TASKD_ALLOW_CIDRS=/gm) ?? []).length, 1);
  });
});

describe("server/meta — the acceptance capability", () => {
  it("reports the policy in force, and re-reads it on each request", async () => {
    const dir = tempDir();
    writeAcceptancePolicy({ dataDir: dir, policy: "human-only" });
    const taskd = await start({ dataDir: dir });
    assert.equal(
      dataOf(await call(taskd, "GET", "/meta")).capabilities.acceptance.policy,
      "human-only",
    );
    // A re-install rewrites the file; the running board reports the new value
    // without a restart (the policy is read per decision, not cached).
    writeAcceptancePolicy({ dataDir: dir, policy: "agent-only" });
    assert.equal(
      dataOf(await call(taskd, "GET", "/meta")).capabilities.acceptance.policy,
      "agent-only",
    );
  });
});
