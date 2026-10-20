/**
 * The install-root `.env` loader.
 *
 * These tests pin the two decisions a shared config file must get right:
 * precedence (`flag > process env > file > default`) and blast radius (only our
 * keys are merged; an unknown key in our namespace is a typo, an external key
 * is somebody else's).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, it } from "node:test";

import { loadEnvFile, parseEnvConfig } from "../../src/foundation/env-config.mjs";
import { resolveEnvFilePath } from "../../src/foundation/runtime-locator.mjs";
import { resolveToken } from "../../src/foundation/transport/token.mjs";

const TOKEN = `td_${"a".repeat(64)}`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "taskpanel-env-"));
}

/** Write `<dir>/.env` and return its path. Default mode is the safe one. */
function writeEnv(dir, text, mode = 0o600) {
  const file = join(dir, ".env");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

describe("resolveEnvFilePath", () => {
  it("defaults to <root>/.env", () => {
    assert.equal(resolveEnvFilePath({ root: "/r", env: {} }), join("/r", ".env"));
  });

  it("honours MEERKAT_TASKPANEL_ENV_FILE, resolving a relative path against cwd", () => {
    assert.equal(
      resolveEnvFilePath({ root: "/r", env: { MEERKAT_TASKPANEL_ENV_FILE: "custom.env" }, cwd: "/c" }),
      join("/c", "custom.env"),
    );
  });
});

describe("loadEnvFile — file selection", () => {
  it("a missing default file is no config, not an error", () => {
    const root = tempDir();
    const config = loadEnvFile({ root, env: {} });
    assert.equal(config.present, false);
    assert.equal(config.source, "none");
    assert.equal(config.file, join(root, ".env"));
    assert.equal(config.tokenFile, null);
  });

  it("a missing --env-file is an error, while a missing env-named file is no config", () => {
    const root = tempDir();
    // A deployment names this location up front (a container's data volume before
    // the first save); absence is the same "no configuration" as the default.
    const fromEnv = loadEnvFile({ root, env: { MEERKAT_TASKPANEL_ENV_FILE: join(root, "nope.env") } });
    assert.equal(fromEnv.present, false);
    assert.equal(fromEnv.source, "none");
    assert.equal(fromEnv.file, join(root, "nope.env"));
    // An explicit flag is an instruction: a missing file is a mistake.
    assert.throws(
      () => loadEnvFile({ root, env: {}, flag: join(root, "nope.env") }),
      /cannot read the configuration file/,
    );
  });

  it("flag beats the environment override, which beats the default", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_AGENT=root\n");
    const envDir = tempDir();
    const envFile = join(envDir, "env.env");
    writeFileSync(envFile, "TASKCTL_AGENT=env\n");
    const flagDir = tempDir();
    const flagFile = join(flagDir, "flag.env");
    writeFileSync(flagFile, "TASKCTL_AGENT=flag\n");

    assert.equal(loadEnvFile({ root, env: {} }).vars.get("TASKCTL_AGENT"), "root");
    assert.equal(
      loadEnvFile({ root, env: { MEERKAT_TASKPANEL_ENV_FILE: envFile } }).vars.get("TASKCTL_AGENT"),
      "env",
    );
    assert.equal(
      loadEnvFile({ root, env: { MEERKAT_TASKPANEL_ENV_FILE: envFile }, flag: flagFile }).vars.get("TASKCTL_AGENT"),
      "flag",
    );
  });
});

describe("loadEnvFile — grammar", () => {
  it("accepts BOM, comments, export, quotes and blank lines", () => {
    const root = tempDir();
    writeEnv(
      root,
      `﻿# a comment\n\nexport TASKD_URL="http://localhost:9527"\nTASKD_HOST='127.0.0.1'\n`,
    );
    const config = loadEnvFile({ root, env: {} });
    assert.equal(config.vars.get("TASKD_URL"), "http://localhost:9527");
    assert.equal(config.vars.get("TASKD_HOST"), "127.0.0.1");
  });

  it("rejects a line that is not KEY=VALUE by line number, without echoing it", () => {
    const root = tempDir();
    writeEnv(root, `# comment\nTASKCTL_AGENT=jobs\nBROKEN ${TOKEN}\n`);
    assert.throws(
      () => loadEnvFile({ root, env: {} }),
      (err) => /line 3/.test(err.message) && !err.message.includes(TOKEN),
    );
  });

  it("rejects duplicate keys and empty keys", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_AGENT=a\nTASKCTL_AGENT=b\n");
    assert.throws(() => loadEnvFile({ root, env: {} }), /repeats "TASKCTL_AGENT"/);

    const other = tempDir();
    writeEnv(other, "=value\n");
    assert.throws(() => loadEnvFile({ root: other, env: {} }), /empty key/);
  });
});

describe("loadEnvFile — namespaces and values", () => {
  it("rejects an unknown key in our namespace", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_URLL=http://localhost:9527\n");
    assert.throws(() => loadEnvFile({ root, env: {} }), /unknown configuration key "TASKD_URLL"/);
  });

  it("ignores external keys and never merges them", () => {
    const root = tempDir();
    writeEnv(root, "VITE_FOO=bar\nNODE_ENV=production\nPATH=/evil\nTASKCTL_AGENT=jobs\n");
    const config = loadEnvFile({ root, env: { NODE_ENV: "test", PATH: "/usr/bin" } });
    assert.equal(config.vars.has("VITE_FOO"), false);
    assert.equal(config.vars.has("PATH"), false);
    assert.equal(config.env.VITE_FOO, undefined);
    assert.equal(config.env.NODE_ENV, "test");
    assert.equal(config.env.PATH, "/usr/bin");
    assert.equal(config.env.TASKCTL_AGENT, "jobs");
  });

  it("rejects identity keys that are per host / per invocation", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_ACTOR_KIND=claude\n");
    assert.throws(() => loadEnvFile({ root, env: {} }), /identity/);

    const other = tempDir();
    writeEnv(other, "TASKCTL_SESSION_ID=s-1\n");
    assert.throws(() => loadEnvFile({ root: other, env: {} }), /identity/);
  });

  it("allows TASKCTL_AGENT / TASKCTL_HUMAN as defaults", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_AGENT=jobs\nTASKCTL_HUMAN=Terry\n");
    const config = loadEnvFile({ root, env: {} });
    assert.equal(config.env.TASKCTL_AGENT, "jobs");
    assert.equal(config.env.TASKCTL_HUMAN, "Terry");
  });

  it("validates URL, port, booleans and acceptance policy", () => {
    const cases = [
      ["TASKD_URL=http://localhost:9527/path\n", /path/],
      ["TASKD_URL=ftp://localhost:9527\n", /http or https/],
      ["TASKD_URL=http://localhost:0\n", /port 0/],
      ["TASKD_PORT=99999\n", /0–65535/],
      ["TASKD_NO_AUTOSTART=maybe\n", /true or false/],
      ["TASKD_ALLOW_LIST_ENABLED=maybe\n", /true or false/],
      ["TASKD_ACCEPTANCE_POLICY=nope\n", /human-only/],
    ];
    for (const [text, pattern] of cases) {
      const root = tempDir();
      writeEnv(root, text);
      assert.throws(() => loadEnvFile({ root, env: {} }), pattern, text);
    }
  });

  it("allows an explicitly empty allow-list", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_ALLOW_CIDRS=\n");
    assert.equal(loadEnvFile({ root, env: {} }).vars.get("TASKD_ALLOW_CIDRS"), "");
  });

  it("process environment wins, but a blank value does not shadow the file", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_AGENT=file\nTASKD_HOST=10.0.0.1\n");
    const config = loadEnvFile({ root, env: { TASKCTL_AGENT: "env", TASKD_HOST: "   " } });
    assert.equal(config.env.TASKCTL_AGENT, "env");
    assert.equal(config.env.TASKD_HOST, "10.0.0.1");
  });
});

describe("loadEnvFile — tokens", () => {
  it("refuses an inline token in a group/world-readable file", () => {
    const root = tempDir();
    writeEnv(root, `TASKD_TOKEN=${TOKEN}\n`, 0o644);
    assert.throws(
      () => loadEnvFile({ root, env: {} }),
      (err) => err.code === "CONFIG_FILE_INSECURE" && /chmod 600/.test(JSON.stringify(err.hint)),
    );
  });

  it("accepts an inline token in a 0600 file", () => {
    const root = tempDir();
    writeEnv(root, `TASKD_TOKEN=${TOKEN}\n`, 0o600);
    const config = loadEnvFile({ root, env: {} });
    assert.equal(config.vars.get("TASKD_TOKEN"), TOKEN);
    assert.equal(config.env.TASKD_TOKEN, TOKEN);
  });

  it("refuses both token keys", () => {
    const root = tempDir();
    writeEnv(root, `TASKD_TOKEN=${TOKEN}\nTASKD_TOKEN_FILE=token\n`, 0o600);
    assert.throws(() => loadEnvFile({ root, env: {} }), /both TASKD_TOKEN and TASKD_TOKEN_FILE/);
  });

  it("resolves a file-sourced TASKD_TOKEN_FILE beside the config file", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_TOKEN_FILE=tokens/board\nTASKCTL_AGENT=jobs\n");
    assert.equal(loadEnvFile({ root, env: {} }).tokenFile, join(root, "tokens/board"));
  });

  it("resolves an environment-sourced TASKD_TOKEN_FILE against cwd", () => {
    const root = tempDir();
    const cwd = tempDir();
    writeEnv(root, "TASKCTL_AGENT=jobs\n");
    const config = loadEnvFile({ root, env: { TASKD_TOKEN_FILE: "tokens/board" }, cwd });
    assert.equal(config.tokenFile, join(cwd, "tokens/board"));
  });

  it("does not touch an unused explicit token file when a process token wins", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_TOKEN_FILE=missing\nTASKCTL_AGENT=jobs\n");
    const config = loadEnvFile({ root, env: { TASKD_TOKEN: "not-a-real-token" } });
    const resolved = resolveToken({ env: config.env, tokenFile: config.tokenFile });
    assert.equal(resolved.token, "not-a-real-token");
    assert.equal(resolved.source, "env");
  });
});

describe("parseEnvConfig", () => {
  it("runs the pre-scan before the lenient parser", () => {
    assert.throws(() => parseEnvConfig("A=1\nno-equals\n"), /line 2/);
    assert.deepEqual([...parseEnvConfig("A=1\nB=2\n").keys()], ["A", "B"]);
  });
});
