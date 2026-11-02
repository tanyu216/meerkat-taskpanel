/**
 * The loop's admission-deferral ledger: the durable count that turns a card
 * "deferring again" into one board-visible escalation instead of a log line.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import * as d from "../../src/orchestrator/deferrals.mjs";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-deferrals-"));
  dirs.push(dir);
  return dir;
}

describe("orchestrator/deferrals — the ledger", () => {
  it("increments a card's consecutive count and keeps the first timestamp", () => {
    const dir = stateDir();
    const one = d.recordCardDeferral(dir, {
      identifier: "T-1",
      code: "WORKSPACE_CREATE_FAILED",
      reason: "a",
      round: 1,
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(one.ok, true);
    const two = d.recordCardDeferral(dir, {
      identifier: "T-1",
      code: "WORKSPACE_CREATE_FAILED",
      reason: "b",
      round: 1,
      now: "2026-01-01T00:10:00.000Z",
    });
    assert.equal(two.entry.count, 2);
    assert.equal(two.entry.first_at, "2026-01-01T00:00:00.000Z");
    assert.equal(two.entry.last_at, "2026-01-01T00:10:00.000Z");
    assert.equal(two.entry.reason, "b");
  });

  it("clears only the named card", () => {
    const dir = stateDir();
    d.recordCardDeferral(dir, { identifier: "T-1", code: "X", reason: "a", round: 1 });
    d.recordCardDeferral(dir, { identifier: "T-2", code: "X", reason: "a", round: 1 });
    assert.equal(d.clearCardDeferral(dir, "T-1").cleared, true);
    assert.equal(d.readDeferralLedger(dir).value.cards["T-1"], undefined);
    assert.notEqual(d.readDeferralLedger(dir).value.cards["T-2"], undefined);
    assert.equal(d.clearCardDeferral(dir, "NOPE").cleared, false);
  });

  it("treats a missing file as fresh and a corrupt one as an error", () => {
    const dir = stateDir();
    const missing = d.readDeferralLedger(dir);
    assert.deepEqual(missing.value.cards, {});
    assert.equal(missing.error, null, "a fresh install is not an error");

    writeFileSync(d.deferralLedgerPath(dir), "{not json");
    const corrupt = d.readDeferralLedger(dir);
    assert.deepEqual(corrupt.value.cards, {});
    assert.notEqual(corrupt.error, null);
  });

  it("prunes terminal cards but keeps an unknown card and an active one", () => {
    const ledger = {
      version: 1,
      cards: {
        A: { identifier: "A", last_at: "2026-01-01T00:00:00.000Z" },
        B: { identifier: "B", last_at: "2026-01-01T00:00:00.000Z" },
        C: { identifier: "C", last_at: "2026-01-01T00:00:00.000Z" },
      },
    };
    const pruned = d.pruneDeferrals(ledger, {
      tasks: [
        { identifier: "A", status: "done" },
        { identifier: "B", status: "todo" },
      ],
      nowMs: Date.parse("2026-01-02T00:00:00.000Z"),
    });
    assert.deepEqual(Object.keys(pruned.ledger.cards).sort(), ["B", "C"]);
    assert.deepEqual(pruned.dropped.map((drop) => drop.identifier), ["A"]);
  });

  it("drops an entry past the retention window", () => {
    const ledger = {
      version: 1,
      cards: { A: { identifier: "A", last_at: "2026-01-01T00:00:00.000Z" } },
    };
    const pruned = d.pruneDeferrals(ledger, {
      tasks: [],
      nowMs: Date.parse("2026-01-10T00:00:00.000Z"),
    });
    assert.deepEqual(pruned.ledger.cards, {});
    assert.deepEqual(pruned.dropped, [{ identifier: "A", why: "stale" }]);
  });
});

describe("orchestrator/deferrals — escalation", () => {
  it("posts one comment per (streak, code) at the threshold", () => {
    const dir = stateDir();
    const comments = [];
    const alerts = [];
    const recorder = d.createDeferralRecorder({
      stateDir: dir,
      postComment: (ref, body) => {
        comments.push({ ref, body });
        return { ok: true };
      },
      notify: (alert) => alerts.push(alert),
      log: () => {},
      now: () => "2026-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 2; index += 1) {
      recorder.record("T-1", { code: "WORKSPACE_CREATE_FAILED", reason: "x", round: 1 });
    }
    assert.equal(comments.length, 0, "below the threshold");

    recorder.record("T-1", { code: "WORKSPACE_CREATE_FAILED", reason: "x", round: 1 });
    assert.equal(comments.length, 1);
    assert.equal(alerts.length, 1);
    assert.match(comments[0].body, /WORKSPACE_CREATE_FAILED/);

    recorder.record("T-1", { code: "WORKSPACE_CREATE_FAILED", reason: "x", round: 1 });
    assert.equal(comments.length, 1, "the same cause does not repeat");

    recorder.record("T-1", { code: "ADMISSION_BRIEF_WATCH_FAILED", reason: "y", round: 1 });
    assert.equal(comments.length, 2, "a new cause alerts");
  });

  it("retries the comment when it fails", () => {
    const dir = stateDir();
    let attempts = 0;
    const recorder = d.createDeferralRecorder({
      stateDir: dir,
      postComment: () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: "board down" } : { ok: true };
      },
      log: () => {},
      now: () => "2026-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 3; index += 1) {
      recorder.record("T-1", { code: "X", reason: "x", round: 1 });
    }
    assert.equal(attempts, 1, "the threshold crossing tried");
    recorder.record("T-1", { code: "X", reason: "x", round: 1 });
    assert.equal(attempts, 2, "the next deferral retries");
  });

  it("clearing a streak lets the same cause alert again", () => {
    const dir = stateDir();
    let comments = 0;
    const recorder = d.createDeferralRecorder({
      stateDir: dir,
      postComment: () => {
        comments += 1;
        return { ok: true };
      },
      log: () => {},
      now: () => "2026-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 3; index += 1) {
      recorder.record("T-1", { code: "X", reason: "x", round: 1 });
    }
    recorder.clear("T-1");
    for (let index = 0; index < 3; index += 1) {
      recorder.record("T-1", { code: "X", reason: "x", round: 1 });
    }
    assert.equal(comments, 2);
  });
});

describe("orchestrator/deferrals — backoff and the hold bound", () => {
  it("backs off once a streak becomes a pattern, then releases the card", () => {
    const dir = stateDir();
    const at = "2026-01-01T00:00:00.000Z";
    const first = d.recordCardDeferral(dir, {
      identifier: "T-1",
      code: "ADMISSION_FAILED",
      reason: "no project directory",
      now: at,
    });
    assert.equal(first.entry.retry_at, null, "a one-off failure is not punished");

    d.recordCardDeferral(dir, { identifier: "T-1", code: "ADMISSION_FAILED", reason: "x", now: at });
    const third = d.recordCardDeferral(dir, {
      identifier: "T-1",
      code: "ADMISSION_FAILED",
      reason: "x",
      now: at,
    });
    assert.equal(third.entry.count, 3);
    assert.ok(third.entry.retry_at, "the pattern starts a backoff");
    assert.equal(d.deferralGate(third.entry, Date.parse(at)).blocked, true);
    assert.equal(
      d.deferralGate(third.entry, Date.parse(third.entry.retry_at) + 1).blocked,
      false,
      "the card is re-offered when the backoff expires",
    );
  });

  it("caps the backoff at one hour", () => {
    assert.equal(d.deferralBackoffMs(3), 30_000);
    assert.equal(d.deferralBackoffMs(4), 60_000);
    assert.equal(d.deferralBackoffMs(50), 60 * 60_000);
  });

  it("parks after five consecutive failures, not three", () => {
    assert.equal(d.DEFERRAL_HOLD, 5);
    assert.ok(d.DEFERRAL_HOLD > d.DEFERRAL_THRESHOLD, "the alert comes before the hold");
  });
});

describe("orchestrator/deferrals — a human edit gives one try", () => {
  it("resets the streak when the board version changed", () => {
    const dir = stateDir();
    const at = "2026-01-01T00:00:00.000Z";
    let entry;
    for (let index = 0; index < 3; index += 1) {
      entry = d.recordCardDeferral(dir, {
        identifier: "T-1",
        code: "ADMISSION_FAILED",
        reason: "no project directory",
        version: 7,
        now: at,
      }).entry;
    }
    assert.equal(entry.count, 3);
    assert.equal(d.deferralGate(entry, Date.parse(at), 7).blocked, true);

    const edited = d.recordCardDeferral(dir, {
      identifier: "T-1",
      code: "ADMISSION_FAILED",
      reason: "no project directory",
      version: 8,
      now: at,
    }).entry;
    assert.equal(edited.count, 1, "the human's edit starts a fresh, still-bounded run");
    assert.equal(edited.retry_at, null);
    assert.equal(d.deferralGate(entry, Date.parse(at), 8).blocked, false, "the backoff yields to the edit");
  });
});
