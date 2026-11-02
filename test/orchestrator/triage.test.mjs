/**
 * The director's triage decision: the prompt that consumes an accepted card's
 * required handoff and the marker-only completion rule.
 *
 * The producer is `done`, so a triage row must not be judged by the question
 * lane's "left in_progress" rule. The marker is the decision; a linked child is
 * only a hint for the doctor.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readTriageOutcome } from "../../src/orchestrator/runtime.mjs";
import { buildQuestionPrompt } from "../../src/foundation/scheduling.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-triage-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const noopLog = () => {};

function sentinel(dir, task) {
  const script = join(dir, "triage-cli.mjs");
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({ ok: true, data: { task: ${JSON.stringify(task)} } }));`,
  );
  return script;
}

function optsFor(script) {
  return { cli: script, actorKind: "claude", agents: ["alice"], boardLimit: 50 };
}

describe("director triage: the prompt", () => {
  it("asks for the handoff, the idempotent children and the marker — not a release", () => {
    const prompt = buildQuestionPrompt(
      [
        {
          triage: true,
          card: "P-1",
          agent: "alice",
          round: 2,
          title: "design",
          project: "P",
          target_dir: "/tmp/project",
        },
      ],
      {
        actorKind: "claude",
        routing: "| Work shape | Accountable role |\n|---|---|\n| brief | Jobs |",
      },
    );

    assert.match(prompt, /accepted producer, required handoff \(round 2\)/);
    assert.match(prompt, /handoff_of=P-1:r2/);
    assert.match(prompt, /loop-handoff\|P-1\|r2\|<n>/);
    assert.match(prompt, /taskctl issue create/);
    assert.match(prompt, /taskctl relation add/);
    assert.match(prompt, /handoff_consumed_round=2/);
    assert.match(prompt, /handoff_declined_round=2/);
    assert.match(prompt, /must not be reopened or moved/);
    assert.doesNotMatch(prompt, /status is not `in_progress`/);
    assert.doesNotMatch(prompt, /release the card to the queue/);
  });
});

describe("director triage: the marker is the completion", () => {
  it("settles on a numeric or string marker for this round", () => {
    for (const meta of [{ handoff_consumed_round: 2 }, { handoff_consumed_round: "2" }]) {
      const dir = tempDir();
      const result = readTriageOutcome(
        optsFor(sentinel(dir, {
          identifier: "P-1",
          status: "done",
          delivery_round: 2,
          meta,
        })),
        "P-1",
        2,
        noopLog,
      );
      assert.equal(result.ok, true);
      assert.equal(result.settled, true, JSON.stringify(meta));
      assert.equal(result.stale, false);
    }
  });

  it("accepts a declined handoff as a decision", () => {
    const dir = tempDir();
    const result = readTriageOutcome(
      optsFor(sentinel(dir, {
        identifier: "P-1",
        status: "done",
        delivery_round: 2,
        meta: { handoff_declined_round: "2" },
      })),
      "P-1",
      2,
      noopLog,
    );
    assert.equal(result.settled, true);
    assert.equal(result.declined, true);
  });

  it("does not settle without a marker, and does not count a child as proof", () => {
    const dir = tempDir();
    const result = readTriageOutcome(
      optsFor(sentinel(dir, {
        identifier: "P-1",
        status: "done",
        delivery_round: 2,
        meta: {},
      })),
      "P-1",
      2,
      noopLog,
    );
    assert.equal(result.settled, false);
    assert.equal(result.stale, false);
  });

  it("marks a producer that moved off done or past the round stale", () => {
    const dir = tempDir();
    const moved = readTriageOutcome(
      optsFor(sentinel(dir, { identifier: "P-1", status: "todo", delivery_round: 2, meta: {} })),
      "P-1",
      2,
      noopLog,
    );
    assert.equal(moved.stale, true);
    assert.equal(moved.settled, false);

    const later = readTriageOutcome(
      optsFor(sentinel(dir, {
        identifier: "P-1",
        status: "done",
        delivery_round: 3,
        meta: { handoff_consumed_round: "2" },
      })),
      "P-1",
      2,
      noopLog,
    );
    assert.equal(later.stale, true);
  });
});
