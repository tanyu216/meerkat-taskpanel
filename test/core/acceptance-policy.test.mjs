/**
 * The board's acceptance policy, resolved and persisted.
 *
 * Three properties:
 *
 *   1. **precedence** — explicit option → process env → `<dataDir>/taskd.env` →
 *      `both`, and an invalid configured value is refused (`ACCESS_CONFIG_INVALID`),
 *      never silently replaced;
 *   2. **merge** — `taskd.env` is shared with the Access panel, so the write
 *      touches its own key and nothing else;
 *   3. **re-read** — a resolver reads per decision, so a re-install applies
 *      without restarting the board.
 */

import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  ACCEPTANCE_POLICY_ENV,
  createAcceptancePolicy,
  readAcceptancePolicy,
  writeAcceptancePolicy,
} from "../../src/core/acceptance-policy.mjs";
import { envLineKey, mergeEnvText, parseEnvBool, parseEnvText } from "../../src/shared/env-file.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

describe("shared/env-file — the merge writer", () => {
  it("reads a key from the three line shapes", () => {
    assert.equal(envLineKey("TASKD_X=1"), "TASKD_X");
    assert.equal(envLineKey("  export TASKD_X=1"), "TASKD_X");
    assert.equal(envLineKey("# TASKD_X=1"), null);
    assert.equal(envLineKey(""), null);
    assert.equal(envLineKey("not-an-assignment"), null);
  });

  it("replaces in place, drops duplicates, appends new keys, and keeps comments", () => {
    const before = ["# header", "A=1", "B=old", "B=older", "C=3", ""].join("\n");
    const out = mergeEnvText(before, { B: "new", D: "4" });
    assert.equal(out, ["# header", "A=1", "B=new", "C=3", "D=4", ""].join("\n"));
  });

  it("creates a well-formed file from nothing", () => {
    assert.equal(mergeEnvText("", { A: "1" }), "A=1\n");
  });
});

describe("shared/env-file — the reader", () => {
  it("skips malformed lines by default and throws on them when strict", () => {
    assert.deepEqual(parseEnvText("A=1\nnot-an-assignment\n"), new Map([["A", "1"]]));
    assert.throws(
      () => parseEnvText("not-an-assignment", { strict: true }),
      (err) => err.code === "ACCESS_CONFIG_INVALID",
    );
  });

  it("lets the last write win, strips `export`, and unquotes", () => {
    assert.deepEqual(parseEnvText("A=1\nA=2\n"), new Map([["A", "2"]]));
    assert.deepEqual(parseEnvText('export Q="x y"\n'), new Map([["Q", "x y"]]));
    assert.deepEqual(parseEnvText("  export R='z'\n"), new Map([["R", "z"]]));
  });

  it("keeps the lenient reader's two documented differences", () => {
    // scheduling's reader skips a key-less line; the panel's keeps it.
    assert.deepEqual(parseEnvText("=v\n", { skipEmptyKey: true }), new Map());
    assert.deepEqual(parseEnvText("=v\n"), new Map([["", "v"]]));
    // A lone quote is stripped by the panel's rule and kept by the installer's.
    assert.deepEqual(parseEnvText('A="\n'), new Map([["A", ""]]));
    assert.deepEqual(parseEnvText('A="\n', { quoteMinLength: 2 }), new Map([["A", '"']]));
  });

  it("parses the two boolean vocabularies", () => {
    assert.equal(parseEnvBool("true"), true);
    assert.equal(parseEnvBool("off"), false);
    assert.equal(parseEnvBool("y"), null);
    assert.equal(parseEnvBool("y", { shortForms: true }), true);
    assert.equal(parseEnvBool("maybe"), null);
    assert.equal(parseEnvBool(undefined), null);
  });
});

describe("core/acceptance-policy — precedence", () => {
  it("defaults to both with no file, env or option", () => {
    const dataDir = makeTempDir("acceptance-");
    assert.deepEqual(readAcceptancePolicy({ dataDir, env: {} }), { policy: "both", source: "default" });
  });

  it("reads the file, then lets the env and an explicit option override it", () => {
    const dataDir = makeTempDir("acceptance-");
    writeAcceptancePolicy({ dataDir, policy: "human-only" });
    assert.deepEqual(readAcceptancePolicy({ dataDir, env: {} }), { policy: "human-only", source: "file" });
    assert.deepEqual(
      readAcceptancePolicy({ dataDir, env: { [ACCEPTANCE_POLICY_ENV]: "agent-only" } }),
      { policy: "agent-only", source: "env" },
    );
    assert.deepEqual(
      readAcceptancePolicy({ dataDir, acceptancePolicy: "both", env: { [ACCEPTANCE_POLICY_ENV]: "agent-only" } }),
      { policy: "both", source: "explicit" },
    );
  });

  it("refuses an invalid configured value instead of falling back", () => {
    const dataDir = makeTempDir("acceptance-");
    writeFileSync(join(dataDir, "taskd.env"), `${ACCEPTANCE_POLICY_ENV}=loop-only\n`, "utf8");
    assert.throws(
      () => readAcceptancePolicy({ dataDir, env: {} }),
      (err) => err.code === "ACCESS_CONFIG_INVALID",
    );
    // An empty env value is not a policy: it falls through to the file, which
    // here is still the invalid one — so the refusal is the file's, not the
    // env's. With a clean directory the same input reads the default.
    const clean = makeTempDir("acceptance-");
    assert.deepEqual(
      readAcceptancePolicy({ dataDir: clean, env: { [ACCEPTANCE_POLICY_ENV]: "" } }),
      { policy: "both", source: "default" },
      "an empty env value is not a policy",
    );
  });

  it("re-reads on each decision, so a re-install applies without a restart", () => {
    const dataDir = makeTempDir("acceptance-");
    const resolver = createAcceptancePolicy({ dataDir, env: {} });
    assert.equal(resolver(), "both");
    writeAcceptancePolicy({ dataDir, policy: "agent-only" });
    assert.equal(resolver(), "agent-only");
  });
});

describe("core/acceptance-policy — the persisted file", () => {
  it("writes 0600 and merges with the access policy's keys", () => {
    const dataDir = makeTempDir("acceptance-");
    writeFileSync(
      join(dataDir, "taskd.env"),
      "# written by the Access panel\nTASKD_ALLOW_LIST_ENABLED=true\nTASKD_ALLOW_CIDRS=10.0.0.0/8\n",
      "utf8",
    );
    writeAcceptancePolicy({ dataDir, policy: "human-only" });
    const text = readFileSync(join(dataDir, "taskd.env"), "utf8");
    assert.match(text, /^# written by the Access panel$/m);
    assert.match(text, /^TASKD_ALLOW_LIST_ENABLED=true$/m);
    assert.match(text, /^TASKD_ALLOW_CIDRS=10\.0\.0\.0\/8$/m);
    assert.match(text, new RegExp(`^${ACCEPTANCE_POLICY_ENV}=human-only$`, "m"));
    assert.equal(statSync(join(dataDir, "taskd.env")).mode & 0o777, 0o600);
  });

  it("refuses a policy outside the vocabulary", () => {
    const dataDir = makeTempDir("acceptance-");
    assert.throws(
      () => writeAcceptancePolicy({ dataDir, policy: "loop-only" }),
      (err) => err.code === "VALIDATION_FAILED" && err.details.field === "acceptance",
    );
  });
});
