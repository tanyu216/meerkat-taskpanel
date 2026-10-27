/**
 * The install-root `.env` loader.
 *
 * These tests pin the two decisions a shared config file must get right:
 * precedence (`flag > process env > file > default`) and blast radius (only our
 * keys are merged; an unknown key in our namespace is a typo, an external key
 * is somebody else's).
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("rejects identity keys that are per agent kind / per invocation", () => {
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

  it("validates URL, port and booleans", () => {
    const cases = [
      ["TASKD_URL=http://localhost:9527/path\n", /path/],
      ["TASKD_URL=ftp://localhost:9527\n", /http or https/],
      ["TASKD_URL=http://localhost:0\n", /port 0/],
      ["TASKD_PORT=99999\n", /0–65535/],
      ["TASKD_NO_AUTOSTART=maybe\n", /true or false/],
      ["TASKD_ALLOW_LIST_ENABLED=maybe\n", /true or false/],
      // The retired key is no longer a recognized config key; it falls through
      // the project-namespace unknown-key rule.
      ["TASKD_ACCEPTANCE_POLICY=both\n", /unknown configuration key/],
    ];
    for (const [text, pattern] of cases) {
      const root = tempDir();
      writeEnv(root, text);
      assert.throws(() => loadEnvFile({ root, env: {} }), pattern, text);
    }
  });

  it("validates the logging controls and normalises a level alias", () => {
    for (const [text, pattern] of [
      ["TASKD_LOG_LEVEL=verbose\n", /debug, info, warn, error or off/],
      ["TASKD_LOG_MAX_BYTES=0\n", /positive integer/],
      ["TASKD_LOG_KEEP=-1\n", /positive integer/],
      ["TASKD_LOG_KEEP=2.5\n", /positive integer/],
    ]) {
      const root = tempDir();
      writeEnv(root, text);
      assert.throws(() => loadEnvFile({ root, env: {} }), pattern, text);
    }

    const root = tempDir();
    writeEnv(root, "TASKD_LOG_LEVEL=warning\nTASKD_LOG_MAX_BYTES=2048\nTASKD_LOG_KEEP=2\n");
    const config = loadEnvFile({ root, env: {} });
    assert.equal(config.vars.get("TASKD_LOG_LEVEL"), "warn");
    assert.equal(config.env.TASKD_LOG_LEVEL, "warn");
    assert.equal(config.vars.get("TASKD_LOG_MAX_BYTES"), "2048");
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

describe("the TASKD_SLA_* keys", () => {
  it("accepts the documented keys and keeps their values", () => {
    const root = tempDir();
    writeEnv(
      root,
      [
        "TASKD_SLA_PERIOD_SECONDS=600",
        "TASKD_SLA_BLOCKED_CLARIFICATION_LIMIT_MIN=60",
        "TASKD_SLA_BLOCKED_CLARIFICATION_FURTHER_MIN=120",
      ].join("\n"),
    );
    const config = loadEnvFile({ root, env: {} });
    assert.equal(config.vars.get("TASKD_SLA_PERIOD_SECONDS"), "600");
    assert.equal(config.vars.get("TASKD_SLA_BLOCKED_CLARIFICATION_LIMIT_MIN"), "60");
  });

  it("refuses a malformed, out-of-range or empty value by key", () => {
    for (const line of [
      "TASKD_SLA_PERIOD_SECONDS=abc",
      "TASKD_SLA_PERIOD_SECONDS=0",
      "TASKD_SLA_PERIOD_SECONDS=-5",
      "TASKD_SLA_PERIOD_SECONDS=12.5",
      "TASKD_SLA_PERIOD_SECONDS=",
    ]) {
      const root = tempDir();
      writeEnv(root, `${line}\n`);
      assert.throws(
        () => loadEnvFile({ root, env: {} }),
        (err) => err.code === "CONFIG_FILE_INVALID" && err.details.key === "TASKD_SLA_PERIOD_SECONDS",
        line,
      );
    }
  });

  it("refuses a further bound below the normal limit, even when only one side is set", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_SLA_BLOCKED_CLARIFICATION_FURTHER_MIN=119\n");
    assert.throws(
      () => loadEnvFile({ root, env: {} }),
      (err) => err.code === "CONFIG_FILE_INVALID" && err.details.row === "blocked_clarification",
    );
  });

  it("still refuses an unknown key in the SLA namespace", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_SLA_NOPE=1\n");
    assert.throws(() => loadEnvFile({ root, env: {} }), /unknown configuration key/);
  });

  it("refuses the retired MEERKAT_TASKPANEL_PROJECTS_JSON key in the shared file", () => {
    // The map has one location now; a leftover override is a configuration
    // error, not a silently ignored line. `install.sh` strips it on upgrade.
    const root = tempDir();
    writeEnv(root, "MEERKAT_TASKPANEL_PROJECTS_JSON=/maps/one.json\n");
    assert.throws(
      () => loadEnvFile({ root, env: {} }),
      (err) => err.code === "CONFIG_FILE_INVALID" && /MEERKAT_TASKPANEL_PROJECTS_JSON/.test(err.message),
    );
  });

  it("does not validate a process-environment value at load time (the board read does)", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_URL=http://localhost:9527\n");
    const config = loadEnvFile({ root, env: { TASKD_SLA_PERIOD_SECONDS: "abc" } });
    assert.equal(config.env.TASKD_SLA_PERIOD_SECONDS, "abc");
  });
});

describe("loadEnvFile — the per-kind overlay", () => {
  it("applies .env.<kind> above the shared .env and below the process environment", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_AGENT=shared-agent\nTASKCTL_HUMAN=shared-human\n");
    const kindFile = join(root, ".env.claude");
    writeFileSync(kindFile, "TASKCTL_AGENT=alice\nMEERKAT_TASKPANEL_REPO=/opt/tree\n");

    const config = loadEnvFile({ root, env: {}, kindFile });
    assert.equal(config.env.TASKCTL_AGENT, "alice", "the per-kind file wins over .env");
    assert.equal(config.env.TASKCTL_HUMAN, "shared-human", "absent keys fall through to .env");
    assert.equal(config.env.MEERKAT_TASKPANEL_REPO, "/opt/tree");
    assert.equal(config.kindFile, kindFile);
    assert.deepEqual([...config.kindVars.keys()].sort(), [
      "MEERKAT_TASKPANEL_REPO",
      "TASKCTL_AGENT",
    ]);

    const overridden = loadEnvFile({ root, env: { TASKCTL_AGENT: "from-env" }, kindFile });
    assert.equal(overridden.env.TASKCTL_AGENT, "from-env", "the process environment still wins");
  });

  it("takes only the per-kind keys and ignores loop policy without error", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_URL=http://localhost:9527\n");
    const kindFile = join(root, ".env.codex");
    writeFileSync(
      kindFile,
      "MEERKAT_TASKPANEL_REPO=/tree\nMEERKAT_TASKPANEL_REVIEWER=Reviewer\nMEERKAT_TASKPANEL_MAX_CONCURRENCY=4\n",
    );

    const config = loadEnvFile({ root, env: {}, kindFile });
    assert.equal(config.env.MEERKAT_TASKPANEL_REPO, "/tree", "REPO is a per-kind deployment fact");
    assert.equal(config.env.MEERKAT_TASKPANEL_REVIEWER, undefined, "loop policy is not a board key");
    assert.equal(config.env.MEERKAT_TASKPANEL_MAX_CONCURRENCY, undefined);
  });

  it("ignores the retired project-map key in a per-kind file", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_URL=http://localhost:9527\n");
    const kindFile = join(root, ".env.pi");
    writeFileSync(kindFile, "TASKCTL_AGENT=pioneer\nMEERKAT_TASKPANEL_PROJECTS_JSON=/maps/old.json\n");

    const config = loadEnvFile({ root, env: {}, kindFile });
    assert.equal(config.env.MEERKAT_TASKPANEL_PROJECTS_JSON, undefined);
    assert.deepEqual([...config.kindVars.keys()], ["TASKCTL_AGENT"]);
  });

  it("still reads the per-kind file when the shared .env is absent", () => {
    const root = tempDir();
    const kindFile = join(root, ".env.pi");
    writeFileSync(kindFile, "TASKCTL_AGENT=pioneer\n");

    const config = loadEnvFile({ root, env: {}, kindFile });
    assert.equal(config.present, false);
    assert.equal(config.env.TASKCTL_AGENT, "pioneer");
  });

  it("treats a missing per-kind file as no overlay", () => {
    const root = tempDir();
    writeEnv(root, "TASKCTL_AGENT=shared\n");
    const config = loadEnvFile({ root, env: {}, kindFile: join(root, "nope", ".env.claude") });
    assert.equal(config.env.TASKCTL_AGENT, "shared");
    assert.equal(config.kindVars.size, 0);
  });

  it("does not let a per-kind file smuggle an unknown shared key past the allowlist", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_URL=http://localhost:9527\n");
    const kindFile = join(root, ".env.claude");
    writeFileSync(kindFile, "TASKD_URLL=typo\nTASKCTL_AGENT=alice\n");

    const config = loadEnvFile({ root, env: {}, kindFile });
    assert.equal(config.env.TASKD_URLL, undefined);
    assert.equal(config.env.TASKCTL_AGENT, "alice");
  });
});

describe("loadEnvFile — a per-kind file that cannot be read", () => {
  it("reports it as a configuration failure, not as an absent overlay", () => {
    const root = tempDir();
    writeEnv(root, "TASKD_URL=http://localhost:9527\n");
    const kindFile = join(root, ".env.claude");
    assert.throws(
      () =>
        loadEnvFile({
          root,
          env: {},
          kindFile,
          readFile: (file) => {
            if (file === kindFile) {
              const err = new Error("permission denied");
              err.code = "EACCES";
              throw err;
            }
            return readFileSync(file, "utf8");
          },
        }),
      (err) => err.code === "CONFIG_FILE_INVALID" && err.details.file === kindFile,
    );
  });
});
