/**
 * Step 5: token priority, redaction and exit codes (§7.1, §F-F).
 *
 * The priority ladder is `--token` > `$TASKD_TOKEN` > `TASKD_TOKEN_FILE` (the
 * explicit config value) > pointer→tokenFile > none, and "none" is legal on
 * loopback. The second half of the contract — that the token never appears in
 * any output — is asserted end-to-end in the `cli/token rotate — end to end
 * (V10)` describe below, where a real CLI process is on the wire.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { withCli } from "./helpers/cli-harness.mjs";
import { resolveActor } from "../../src/shared/transport/actor.mjs";
import { exitCodeFor, ioError, renderErrorText, usageError } from "../../src/shared/transport/errors.mjs";
import { TOKEN_FORMAT, isTokenShape, resolveToken } from "../../src/shared/transport/token.mjs";
import { DomainError } from "../../src/shared/errors.mjs";

const TOKEN = `td_${"a1b2c3d4".repeat(8)}`;
const OTHER = `td_${"0f".repeat(32)}`;

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-cli-token-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("cli/token — the three-step ladder", () => {
  it("prefers --token over env and the pointer file", () => {
    const dir = tempDir();
    const file = join(dir, "token");
    writeFileSync(file, `${OTHER}\n`, "utf8");

    const resolved = resolveToken({
      flag: TOKEN,
      env: { TASKD_TOKEN: OTHER },
      pointer: { tokenFile: file },
    });
    assert.deepEqual(resolved, { token: TOKEN, source: "flag" });
  });

  it("prefers $TASKD_TOKEN over the pointer file", () => {
    const dir = tempDir();
    const file = join(dir, "token");
    writeFileSync(file, `${OTHER}\n`, "utf8");
    const resolved = resolveToken({ env: { TASKD_TOKEN: TOKEN }, pointer: { tokenFile: file } });
    assert.deepEqual(resolved, { token: TOKEN, source: "env" });
  });

  it("falls back to the tokenFile named by the runtime pointer", () => {
    const dir = tempDir();
    const file = join(dir, "token");
    writeFileSync(file, `${TOKEN}\n`, "utf8");
    assert.deepEqual(resolveToken({ env: {}, pointer: { tokenFile: file } }), {
      token: TOKEN,
      source: "file",
    });
  });

  it("reports source 'none' when there is nothing — legal on loopback", () => {
    assert.deepEqual(resolveToken({ env: {}, pointer: null }), { token: null, source: "none" });
    assert.deepEqual(resolveToken({ env: {}, pointer: { tokenFile: "/nope/missing" } }), {
      token: null,
      source: "none",
    });
  });

  it("refuses a pointer file that does not hold a token (and never echoes it)", () => {
    const dir = tempDir();
    const file = join(dir, "token");
    writeFileSync(file, "not-a-token\n", "utf8");
    assert.throws(
      () => resolveToken({ env: {}, pointer: { tokenFile: file } }),
      (err) => {
        assert.equal(err.code, "TOKEN_FILE_CORRUPT");
        assert.equal(err.message.includes("not-a-token"), false, "must not echo the file body");
        // M3fix D3: the payload is surfaced to callers, so it stays free of
        // the host absolute path — the file *name* is the actionable part.
        assert.equal(err.details.file, "token", "only the file name, never the host path");
        assert.equal(JSON.stringify(err.hint).includes(dir), false, "the repair hint must not echo the host path");
        return true;
      },
    );
  });

  it("recognises exactly `td_` + 64 hex characters", () => {
    assert.equal(isTokenShape(TOKEN), true);
    assert.equal(isTokenShape("td_short"), false);
    assert.equal(isTokenShape(`${TOKEN}0`), false);
    assert.equal(isTokenShape(`TD_${"a".repeat(64)}`), false);
    assert.match(TOKEN_FORMAT.source, /^\^td_/);
  });

  it("trusts an explicitly configured token file, strictly", () => {
    const dir = tempDir();
    const file = join(dir, "explicit-token");
    writeFileSync(file, `${TOKEN}\n`, "utf8");
    chmodSync(file, 0o600);
    assert.deepEqual(resolveToken({ env: {}, tokenFile: file }), { token: TOKEN, source: "file" });
  });

  it("lets $TASKD_TOKEN win without reading the configured file", () => {
    const resolved = resolveToken({
      env: { TASKD_TOKEN: TOKEN },
      // A missing path proves the higher rung short-circuits the file read.
      tokenFile: "/nope/missing-token",
    });
    assert.deepEqual(resolved, { token: TOKEN, source: "env" });
  });

  it("refuses a configured file that is missing or is not a token", () => {
    const dir = tempDir();
    assert.throws(
      () => resolveToken({ env: {}, tokenFile: join(dir, "missing") }),
      (err) => err.code === "CONFIG_FILE_INVALID" && err.details.source === "config",
    );

    const bad = join(dir, "bad-token");
    writeFileSync(bad, "not-a-token\n", "utf8");
    chmodSync(bad, 0o600);
    assert.throws(
      () => resolveToken({ env: {}, tokenFile: bad }),
      (err) => err.code === "TOKEN_FILE_CORRUPT" && err.details.source === "config",
    );
  });

  it("refuses a configured token file other users can read", () => {
    const dir = tempDir();
    const file = join(dir, "open-token");
    writeFileSync(file, `${TOKEN}\n`, "utf8");
    chmodSync(file, 0o644);
    assert.throws(
      () => resolveToken({ env: {}, tokenFile: file }),
      (err) => err.code === "CONFIG_FILE_INSECURE" && /chmod 600/.test(JSON.stringify(err.hint)),
    );
  });
});

describe("cli/actor", () => {
  // A writer's kind is the **only** identity axis: `human`, or the platform an
  // agent runs on (`claude`, `codex`, …). The old model had a second axis —
  // `--agent-platform` beside a coarse `agent|human` — and they were two copies
  // of one fact, with the platform half read by nothing.
  it("is a human unless the caller names a kind", () => {
    assert.deepEqual(resolveActor({ flags: {}, env: { USER: "tanyu" } }).actor, {
      kind: "human",
      id: "tanyu",
    });
    assert.deepEqual(resolveActor({ flags: {}, env: {} }).actor, { kind: "human", id: "local" });
    // The kind is the platform, verbatim — not a boolean "is an agent".
    assert.deepEqual(
      resolveActor({ flags: { actorKind: "claude" }, env: {} }).actor,
      { kind: "claude", id: "local" },
    );
    assert.deepEqual(
      resolveActor({ flags: {}, env: { TASKCTL_ACTOR_KIND: "codex" } }).actor,
      { kind: "codex", id: "local" },
    );
  });

  it("refuses a caller that declares itself the human", () => {
    // `human` is the only kind the board reasons about: a decision on the record
    // (I5), an `awaiting` card resuming, the patrol counting the leader as
    // active. A flag that could set it would be a way to forge all three.
    assert.throws(
      () => resolveActor({ flags: { actorKind: "human" }, env: {} }),
      (err) => err.code === "VALIDATION_FAILED" && err.details.reserved === "human",
    );
    assert.throws(
      () => resolveActor({ flags: {}, env: { TASKCTL_ACTOR_KIND: "human" } }),
      (err) => err.code === "VALIDATION_FAILED",
    );
  });

  it("refuses a session id with no kind", () => {
    // A session id comes from a host, so a write carrying one is an agent's. With
    // no kind the only thing left to record is `human` — and that would put an
    // agent's write on the record as a person's.
    assert.throws(
      () => resolveActor({ flags: { sessionId: "s-1" }, env: {} }),
      (err) => err.code === "VALIDATION_FAILED" && err.details.missing === "actorKind",
    );
  });

  it("lets --agent name the actor without claiming to be an agent", () => {
    const resolved = resolveActor({ flags: { agent: "Terry" }, env: { USER: "tanyu" } });
    assert.deepEqual(resolved.actor, { kind: "human", id: "Terry" });
  });

  it("prefers --agent over --session-id for the id, keeping the session as attribution", () => {
    const resolved = resolveActor({
      flags: { agent: "x", sessionId: "y", actorKind: "claude" },
      env: { USER: "tanyu" },
    });
    assert.equal(resolved.actor.id, "x", "the session id must not shadow --agent");
    assert.notEqual(resolved.actor.id, "y");
    assert.equal(resolved.actor.kind, "claude");
    assert.equal(resolved.session, "y", "the session is still recorded as attribution");
  });

  it("takes the id from TASKCTL_AGENT — never from the kind, the session or $USER", () => {
    const resolved = resolveActor({
      flags: {},
      env: {
        TASKCTL_AGENT: "linus",
        TASKCTL_ACTOR_KIND: "claude",
        TASKCTL_SESSION_ID: "sid",
        USER: "tanyu",
      },
    });
    assert.equal(resolved.actor.id, "linus", "two agents on one host must not collapse onto $USER");
    assert.equal(resolved.actor.kind, "claude", "the kind is what the host declared");
    assert.notEqual(resolved.actor.id, "sid");
    assert.notEqual(resolved.actor.id, "claude");
    assert.notEqual(resolved.actor.id, "tanyu");
    assert.equal(resolved.session, "sid", "the session still rides along as attribution");
  });

  it("records the kind and the session without letting either win the id", () => {
    const resolved = resolveActor({
      flags: { actorKind: "codex", sessionId: "s-9" },
      env: { TASKCTL_AGENT: "linus" },
    });
    assert.deepEqual(resolved.actor, { kind: "codex", id: "linus" });
    assert.equal(resolved.session, "s-9");
  });

  it("writes as the configured human only when asked", () => {
    // Every other write is the agent's own and carries the agent's kind. This is
    // the one write that is the human's, and it has to be explicit: the
    // alternative — letting one env var outrank another — cannot tell a
    // transcript from a claim, and the shim injects `--agent` on every call.
    const resolved = resolveActor({
      flags: { asHuman: true, actorKind: "claude", agent: "linus" },
      env: { TASKCTL_HUMAN: "Terry", TASKCTL_AGENT: "linus" },
    });
    assert.deepEqual(resolved.actor, { kind: "human", id: "Terry" });
  });

  it("only reaches $USER / LOGNAME when nothing names an actor", () => {
    assert.equal(resolveActor({ flags: {}, env: { USER: "tanyu" } }).actor.id, "tanyu");
    assert.equal(resolveActor({ flags: {}, env: { LOGNAME: "tanyu" } }).actor.id, "tanyu");
    // A named actor — flag or env — beats the ambient OS user.
    assert.equal(resolveActor({ flags: { agent: "linus" }, env: { USER: "tanyu" } }).actor.id, "linus");
    assert.equal(
      resolveActor({ flags: {}, env: { TASKCTL_AGENT: "linus", USER: "tanyu" } }).actor.id,
      "linus",
    );
    // The configured human is the last name before the OS user, so a host that
    // has one does not fall through to whatever the shell happens to say.
    assert.equal(resolveActor({ flags: {}, env: { TASKCTL_HUMAN: "Terry" } }).actor.id, "Terry");
  });

  it("does not let an agent inherit the human's name as its id", () => {
    // `TASKCTL_HUMAN` names the person, not a role. Two agents sharing one host
    // (jobs / linus / turing) must not both be recorded as that person when they
    // forget `--agent`; they fall through to the OS user or "local".
    const resolved = resolveActor({
      flags: { actorKind: "claude" },
      env: { TASKCTL_HUMAN: "Terry", USER: "tanyu" },
    });
    assert.equal(resolved.actor.kind, "claude");
    assert.equal(resolved.actor.id, "tanyu");
  });
});

describe("cli/errors — exit codes and rendering", () => {
  it("maps usage to 2 and everything else to 1", () => {
    assert.equal(exitCodeFor(usageError("bad flag")), 2);
    assert.equal(exitCodeFor(ioError("no server")), 1);
    assert.equal(exitCodeFor(new DomainError("REPORT_REQUIRED")), 1);
    assert.equal(exitCodeFor(new Error("boom")), 1);
  });

  it("renders the delivery gate as code + message + the command that fixes it", () => {
    const err = new DomainError("REPORT_REQUIRED", {
      message: "cannot move PROJ-0007 to in_review: no report for delivery round 1",
      details: { round: 1 },
      hint: { command: "taskctl issue deliver PROJ-0007 --report-file -", alternative: "or the waiver" },
    });
    const text = renderErrorText(err);
    assert.match(text, /^REPORT_REQUIRED: cannot move PROJ-0007/);
    assert.match(text, /try: taskctl issue deliver PROJ-0007 --report-file -/);
    assert.match(text, /or: or the waiver/);
  });

  it("prints REPORT_INVALID's issues one per line", () => {
    const err = new DomainError("REPORT_INVALID", {
      message: "report rejected",
      details: { issues: [{ path: "acceptance[0].status", message: "must be one of …" }] },
    });
    assert.match(renderErrorText(err), /acceptance\[0\]\.status: must be one of/);
  });

  it("redacts a token that found its way into a message", () => {
    const err = ioError(`failed to call http://127.0.0.1/?token=${TOKEN}`);
    const text = renderErrorText(err);
    assert.equal(text.includes(TOKEN), false);
    assert.match(text, /td_\*{4}/);
  });
});

describe("cli/token rotate — end to end (V10)", () => {
  it("rotates the board's token from loopback, printing td_**** by default", async () => {
    await withCli(async ({ run, dataDir }) => {
      const before = readFileSync(join(dataDir, "token"), "utf8").trim();

      const human = run(["token", "rotate"]);
      assert.equal(human.status, 0, human.stderr);
      assert.match(human.stdout, /rotated\s+\S*token/);
      assert.match(human.stdout, /token\s+td_\*{4}/);
      assert.equal(/td_[0-9a-f]{64}/.test(human.stdout), false, "the value must not be printed");

      const after_ = readFileSync(join(dataDir, "token"), "utf8").trim();
      assert.notEqual(after_, before, "the token really changed");
      assert.equal(isTokenShape(after_), true);
      assert.equal(run(["token", "rotate"]).stdout.includes(after_), false);
    });
  });

  it("prints the value only with --show, and says what it just did", async () => {
    await withCli(async ({ run, dataDir }) => {
      const shown = run(["token", "rotate", "--show"]);
      assert.equal(shown.status, 0, shown.stderr);
      const token = readFileSync(join(dataDir, "token"), "utf8").trim();
      assert.equal(shown.stdout.includes(token), true, "--show is the one time a secret is printed");
      assert.match(shown.stdout, /is a secret/);

      // Without --show, the same command must not leak it — including in --json.
      const rotated = run(["token", "rotate", "--json"]);
      const current = readFileSync(join(dataDir, "token"), "utf8").trim();
      assert.equal(rotated.stdout.includes(current), false);
      const data = JSON.parse(rotated.stdout).data;
      assert.equal(data.token, null);
      assert.equal(data.token_file, join(dataDir, "token"));
      assert.equal(data.rotated, true);
    });
  });

  it("rotates the token the CLI then presents, so the board still answers", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["token", "rotate", "--json"]);
      const token = readFileSync(join(dataDir, "token"), "utf8").trim();
      // The pointer names the token file, so the next call picks the new one up.
      const listed = run(["project", "list", "--json"], { token });
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(JSON.parse(listed.stdout).data.token_source, "env");
    });
  });
});
