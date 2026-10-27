/**
 * The offline session-id derivation the board skill ships.
 *
 * `scripts/session-id.mjs` exists so a caller can compute the deterministic id
 * **before** an agent starts and without touching `taskd`. That is only safe if it
 * is byte-for-byte the board's own algorithm — same namespace, same NUL-joined
 * name, same RFC 4122 v5 bits. Every case here compares it to
 * `src/foundation/ids.mjs`, which is the authority.
 *
 * The script is installed on its own (the skill is copied without `src/`), so it
 * must stay self-contained; the last case pins that.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SESSION_ID_NAMESPACE } from "../../src/foundation/constants.mjs";
import {
  sessionId as foundationSessionId,
  uuidv5 as foundationUuidv5,
} from "../../src/foundation/ids.mjs";
import {
  SESSION_ID_NAMESPACE as scriptNamespace,
  sessionId as scriptSessionId,
  uuidv5 as scriptUuidv5,
} from "../../skills/meerkat/scripts/session-id.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "skills/meerkat/scripts/session-id.mjs");
/** The RFC 4122 DNS namespace, used by the published test vector. */
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

describe("skills/meerkat/scripts/session-id.mjs", () => {
  it("derives byte for byte the way the board does", () => {
    const vectors = [
      ["", "", ""],
      ["task-1", "linus", "seg2"],
      ["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "claude", "s1"],
      // The NUL separator is load-bearing: these two must not collide.
      ["task-1", "owner\u0000x", "seg"],
      ["task-1", "owner", "seg\u0000y"],
      ["TASK", "OWNER", "SEG"],
    ];
    for (const [taskId, owner, seg] of vectors) {
      assert.equal(
        scriptSessionId(taskId, owner, seg),
        foundationSessionId(taskId, owner, seg),
        JSON.stringify([taskId, owner, seg]),
      );
    }
  });

  it("uses the board's namespace", () => {
    assert.equal(scriptNamespace, SESSION_ID_NAMESPACE);
  });

  it("implements RFC 4122 v5 (DNS vector)", () => {
    const expected = "2ed6657d-e927-568b-95e1-2665a8aea6a2";
    assert.equal(scriptUuidv5("www.example.com", DNS_NAMESPACE), expected);
    assert.equal(foundationUuidv5("www.example.com", DNS_NAMESPACE), expected);
  });

  it("prints the id for the three required flags", () => {
    const taskId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const run = runScript(["--task-id", taskId, "--owner", "linus", "--seg", "s1"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${foundationSessionId(taskId, "linus", "s1")}\n`);
  });

  it("accepts --flag=value and answers --help", () => {
    const taskId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const run = runScript([`--task-id=${taskId}`, "--owner=linus", "--seg=s1"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${foundationSessionId(taskId, "linus", "s1")}\n`);

    const help = runScript(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--task-id/);
  });

  it("refuses missing, empty and unknown arguments with exit 2", () => {
    const taskId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    for (const args of [
      ["--owner", "linus", "--seg", "s1"],
      ["--task-id", taskId, "--seg", "s1"],
      ["--task-id", taskId, "--owner", "linus"],
      ["--task-id", "", "--owner", "linus", "--seg", "s1"],
      ["--task-id", taskId, "--owner", " ", "--seg", "s1"],
      ["--task-id", taskId, "--owner", "linus", "--seg", ""],
      ["--task-id", taskId, "--owner", "linus", "--seg", "s1", "--nope"],
    ]) {
      const run = runScript(args);
      assert.equal(run.status, 2, `${JSON.stringify(args)}: ${run.stderr}`);
      assert.equal(run.stdout, "", JSON.stringify(args));
    }
  });

  it("stays self-contained: no src/ import", () => {
    const source = readFileSync(SCRIPT, "utf8");
    assert.equal(/from\s+["'][^"']*\/src\//.test(source), false);
    assert.equal(/import\s+["'][^"']*\/src\//.test(source), false);
  });
});
