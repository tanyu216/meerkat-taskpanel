/**
 * The one-time loop-state relocation.
 *
 * The source is the old `<home>/<agent-dir>/meerkat-taskpanel`; the target is
 * `<config root>/loop`. These cases run the helper directly (no installer) so a
 * failure names the migration rule, not a shell wrapper.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  hasLegacyState,
  liveHolders,
  migrateLoopState,
  selectLegacySource,
} from "../../scripts/install/lib/state-dir-migration.mjs";

const dirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function write(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function fixture() {
  const root = tempDir("meerkat-state-migration-");
  const from = join(root, "legacy");
  const to = join(root, "loop");
  mkdirSync(from, { recursive: true });
  write(join(from, "cards.queue.json"), { version: 1, cards: [] });
  write(join(from, "sessions.state.json"), {
    version: 3,
    poolPid: 999_999,
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    projects: { "worker:T-1:r1": { sessionId: "sid-1", card: "T-1" } },
  });
  write(join(from, "workspaces.json"), { version: 1, workspaces: [] });
  mkdirSync(join(from, "worker-transcripts"), { recursive: true });
  write(join(from, "worker-transcripts", "t1.json"), "[]");
  write(join(from, "supervisor.log"), "old log\n");
  write(join(from, "subscribe.state.json"), { pid: 999_999 });
  write(join(from, "session.lock"), { pid: 999_999 });
  return { root, from, to };
}

describe("state-dir migration — hasLegacyState", () => {
  it("a log alone is not legacy state", () => {
    const dir = tempDir("meerkat-state-log-");
    write(join(dir, "supervisor.log"), "log\n");
    assert.equal(hasLegacyState(dir), false);
    write(join(dir, "cards.queue.json"), { version: 1, cards: [] });
    assert.equal(hasLegacyState(dir), true);
  });
});

describe("state-dir migration — live holders", () => {
  it("names a live pool, subscriber and lock", () => {
    const { from } = fixture();
    write(join(from, "sessions.state.json"), { version: 3, poolPid: process.pid, projects: {} });
    write(join(from, "subscribe.state.json"), { pid: process.pid });
    write(join(from, "session.lock"), { pid: process.pid });
    const reasons = liveHolders(from);
    assert.ok(reasons.some((reason) => reason.includes("pool pid")));
    assert.ok(reasons.some((reason) => reason.includes("subscriber pid")));
    assert.ok(reasons.some((reason) => reason.includes("session lock")));
  });

  it("a dead pid is not a holder", () => {
    const { from } = fixture();
    assert.deepEqual(liveHolders(from), []);
  });
});

describe("state-dir migration — selectLegacySource", () => {
  it("picks the only directory that holds state", () => {
    const a = tempDir("meerkat-state-kinds-a-");
    const b = tempDir("meerkat-state-kinds-b-");
    write(join(b, "cards.queue.json"), { version: 1, cards: [] });
    const got = selectLegacySource({
      candidates: [
        { kind: "claude", dir: a },
        { kind: "codex", dir: b },
      ],
    });
    assert.deepEqual(got, { ok: true, dir: b, kind: "codex" });
  });

  it("reports nothing to move when every kind is empty", () => {
    const got = selectLegacySource({
      candidates: [{ kind: "claude", dir: tempDir("meerkat-state-kinds-empty-") }],
    });
    assert.deepEqual(got, { ok: true, dir: null, kind: null });
  });

  it("prefers the loaded kind's directory when several hold state", () => {
    const a = tempDir("meerkat-state-kinds-loaded-a-");
    const b = tempDir("meerkat-state-kinds-loaded-b-");
    for (const dir of [a, b]) write(join(dir, "cards.queue.json"), { version: 1, cards: [] });
    const got = selectLegacySource({
      candidates: [
        { kind: "claude", dir: a },
        { kind: "codex", dir: b },
      ],
      loadedKinds: ["codex"],
    });
    assert.deepEqual(got, { ok: true, dir: b, kind: "codex" });
  });

  it("refuses to merge several leftovers, and names them", () => {
    const a = tempDir("meerkat-state-kinds-two-a-");
    const b = tempDir("meerkat-state-kinds-two-b-");
    for (const dir of [a, b]) write(join(dir, "cards.queue.json"), { version: 1, cards: [] });
    const got = selectLegacySource({
      candidates: [
        { kind: "claude", dir: a },
        { kind: "codex", dir: b },
      ],
    });
    assert.equal(got.ok, false);
    assert.match(got.reason, /keep the one that belongs to this board/);
    assert.match(got.reason, /install\.sh --supervisor=enable/);
    assert.deepEqual(got.candidates.sort(), [a, b].sort());
  });

  it("honors an explicit source, and refuses one with no state", () => {
    const a = tempDir("meerkat-state-kinds-explicit-");
    write(join(a, "cards.queue.json"), { version: 1, cards: [] });
    assert.deepEqual(
      selectLegacySource({ candidates: [], explicitDir: a }),
      { ok: true, dir: a, kind: null },
    );
    const empty = tempDir("meerkat-state-kinds-explicit-empty-");
    const refused = selectLegacySource({ candidates: [], explicitDir: empty });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /no loop state/);
  });
});

describe("state-dir migration — migrateLoopState", () => {
  it("copies state, sanitizes the pool, excludes logs and stale pid files, keeps a backup", () => {
    const { from, to } = fixture();
    const result = migrateLoopState({ from, to, now: () => Date.parse("2026-01-02T00:00:00.000Z") });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.moved, true);
    assert.ok(existsSync(to), "the new state directory exists");
    assert.ok(existsSync(join(to, "cards.queue.json")), "the queue moved");
    assert.ok(existsSync(join(to, "workspaces.json")), "the registry moved");
    assert.ok(existsSync(join(to, "worker-transcripts")), "the transcripts moved");
    assert.equal(existsSync(join(to, "supervisor.log")), false, "the old log stays behind");
    assert.equal(existsSync(join(to, "subscribe.state.json")), false, "a stale pid is not copied");
    assert.equal(existsSync(join(to, "session.lock")), false, "a stale lock is not copied");
    assert.ok(existsSync(join(to, "loop.id")), "a stable loop id is written");

    const sessions = JSON.parse(readFileSync(join(to, "sessions.state.json"), "utf8"));
    assert.equal("poolPid" in sessions, false, "the dead pool's pid is forgotten");
    assert.equal("heartbeatAt" in sessions, false, "the dead pool's liveness is forgotten");
    assert.equal(sessions.projects["worker:T-1:r1"].sessionId, "sid-1", "the durable record survives");

    assert.equal(existsSync(from), false, "the source path is gone");
    assert.ok(existsSync(result.backup), "the source is kept as a backup");
    assert.ok(existsSync(join(result.backup, "supervisor.log")), "the old log is in the backup");
  });

  it("refuses a live holder and leaves both directories", () => {
    const { from, to } = fixture();
    write(join(from, "sessions.state.json"), { version: 3, poolPid: process.pid });
    const result = migrateLoopState({ from, to });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not quiescent/);
    assert.ok(existsSync(from));
    assert.equal(existsSync(to), false);
  });

  it("refuses a target that already holds state", () => {
    const { from, to } = fixture();
    mkdirSync(to, { recursive: true });
    write(join(to, "cards.queue.json"), { version: 1, cards: [] });
    const result = migrateLoopState({ from, to });
    assert.equal(result.ok, false);
    assert.match(result.reason, /target already holds loop state/);
    assert.ok(existsSync(from));
  });

  it("treats an empty target as absent", () => {
    const { from, to } = fixture();
    mkdirSync(to, { recursive: true });
    const result = migrateLoopState({ from, to });
    assert.equal(result.ok, true, result.reason);
    assert.ok(existsSync(join(to, "cards.queue.json")));
  });

  it("is a no-op when the source has no state", () => {
    const { to } = fixture();
    const from = tempDir("meerkat-state-empty-");
    const result = migrateLoopState({ from, to });
    assert.equal(result.ok, true);
    assert.equal(result.moved, false);
    assert.equal(existsSync(to), false);
  });

  it("dry-run reports without writing", () => {
    const { from, to } = fixture();
    const lines = [];
    const result = migrateLoopState({ from, to, dryRun: true, log: (line) => lines.push(line) });
    assert.equal(result.ok, true);
    assert.equal(result.moved, false);
    assert.ok(existsSync(from));
    assert.equal(existsSync(to), false);
    assert.ok(lines.some((line) => line.includes("would move")));
  });

  it("refuses a symlinked source entry", () => {
    const { from, to } = fixture();
    symlinkSync(join(from, "cards.queue.json"), join(from, "linked.json"));
    const result = migrateLoopState({ from, to });
    assert.equal(result.ok, false);
    assert.match(result.reason, /symlink/);
    assert.equal(existsSync(to), false);
  });
});
