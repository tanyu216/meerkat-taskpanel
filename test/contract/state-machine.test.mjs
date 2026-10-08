/**
 * Step 6: the state machine, down both paths.
 *
 * `domain/status.mjs` is the fact source and `0002_invariants.sql` re-encodes
 * it as a trigger. This test walks all 49 ordered pairs through the service
 * helper *and* through raw SQL, and requires the two verdicts to agree — so a
 * change to one without the other cannot pass.
 *
 * Two conventions worth stating, because they are the only places where the DB
 * is deliberately more permissive than the JS:
 *
 *   * `x → x` is not a transition. The trigger only speaks when the value
 *     actually changes (a no-op UPDATE must stay legal for ordinary writes);
 *     `assertTransition` still rejects it, because asking for it is a bug.
 *   * entering `in_review` is a *whitelist* question and a *gate* question. To
 *     isolate the whitelist, the DB pass seeds the report the gate wants.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { STATUSES } from "../../src/core/domain/enums.mjs";
import { ALLOWED_TRANSITIONS, canTransition, transitionReasonCode } from "../../src/core/domain/status.mjs";
import { cleanupTempDirs, insertProject, insertReport, insertTask, reasonCode, withBoard } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to]));

/**
 * Prepare a board holding one task in `from`, plus (when the whitelist allows
 * the move) the report the delivery gate demands.
 *
 * Each pair gets its own task: reports are append-only and cannot be cleaned up
 * between iterations, which is itself the invariant under test.
 *
 * @returns {string} the task id
 */
function boardWith(db, from, to, suffix = "") {
  const id = `t_${from}_${to}${suffix}`;
  insertProject(db);
  insertTask(db, { id, identifier: `PROJ-${from}-${to}${suffix}`.toUpperCase(), status: from });
  if (canTransition(from, to) && to === "in_review") {
    insertReport(db, { task_id: id, round: 1 });
  }
  return id;
}

const move = (db, taskId, to) =>
  reasonCode(() =>
    db
      .prepare("UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(to, "2026-10-08T00:05:00.000Z", taskId),
  );

describe("contract/state-machine — 49 pairs, two paths", () => {
  it("the table has 7 statuses and 49 ordered pairs", () => {
    assert.equal(STATUSES.length, 7);
    assert.equal(PAIRS.length, 49);
    assert.equal(
      Object.values(ALLOWED_TRANSITIONS).reduce((sum, list) => sum + list.length, 0),
      17,
      "17 whitelisted pairs",
    );
  });

  it("every pair is allowed or rejected identically by JS and by SQL", async () => {
    await withBoard(({ db }) => {
      const disagreements = [];
      const codeMismatches = [];
      for (const [from, to] of PAIRS) {
        if (from === to) continue; // a no-op is not a transition — asserted below
        const taskId = boardWith(db, from, to);
        const dbVerdict = move(db, taskId, to);
        const dbAllowed = dbVerdict === "NO_ERROR";
        const jsAllowed = canTransition(from, to);

        if (dbAllowed !== jsAllowed) {
          disagreements.push(`${from} → ${to}: js=${jsAllowed ? "allow" : "reject"} sql=${dbVerdict}`);
        }
        if (!jsAllowed) {
          const expected = transitionReasonCode(from, to);
          if (dbVerdict !== expected) {
            codeMismatches.push(`${from} → ${to}: sql=${dbVerdict} js=${expected}`);
          }
        }
      }
      assert.deepEqual(disagreements, [], "service and trigger must agree on every pair");
      assert.deepEqual(codeMismatches, [], "and must report the same reason code");
    });
  });

  it("treats x → x as a no-op, not a transition", async () => {
    await withBoard(({ db }) => {
      for (const status of STATUSES) {
        insertProject(db, { id: `p-${status}` });
        insertTask(db, { id: `t-${status}`, identifier: "PROJ-0001", project_id: `p-${status}`, status });
        assert.equal(move(db, `t-${status}`, status), "NO_ERROR", `${status} → ${status} must be a legal no-op write`);
        assert.equal(canTransition(status, status), false, `${status} → ${status} is not on the whitelist`);
        assert.equal(transitionReasonCode(status, status), status === "done" || status === "canceled" ? "TERMINAL_STATE" : "INVALID_TRANSITION");
      }
    });
  });

  it("makes done reachable only from in_review — down both paths", async () => {
    await withBoard(({ db }) => {
      const viaSql = [];
      for (const from of STATUSES) {
        if (from === "done") continue; // done → done is a no-op, not an entry
        const taskId = boardWith(db, from, "done", "_r");
        const verdict = move(db, taskId, "done");
        if (verdict === "NO_ERROR") viaSql.push(from);
      }
      assert.deepEqual(viaSql, ["in_review"]);
      assert.deepEqual(
        STATUSES.filter((from) => canTransition(from, "done")),
        ["in_review"],
      );
    });
  });

  it("cannot leave a terminal status — down both paths (I3)", async () => {
    await withBoard(({ db }) => {
      for (const terminal of ["done", "canceled"]) {
        for (const to of STATUSES) {
          if (to === terminal) continue;
          const taskId = boardWith(db, terminal, to, "_t");
          assert.equal(
            move(db, taskId, to),
            "TERMINAL_STATE",
            `${terminal} → ${to} must be refused by the trigger`,
          );
          assert.equal(transitionReasonCode(terminal, to), "TERMINAL_STATE");
        }
      }
    });
  });
});

describe("contract/state-machine — delivery rounds (F3)", () => {
  it("bumps the round when a delivery comes back, and not when it is accepted", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_progress" });
      const round = () => db.prepare("SELECT delivery_round AS r FROM tasks WHERE id='t'").get().r;

      assert.equal(round(), 1, "a task starts on its first delivery attempt");
      insertReport(db, { task_id: "t", round: 1 });
      assert.equal(move(db, "t", "in_review"), "NO_ERROR");
      assert.equal(round(), 1, "being reviewed does not move the round");

      assert.equal(move(db, "t", "in_progress"), "NO_ERROR", "rework is allowed");
      assert.equal(round(), 2, "leaving in_review starts attempt 2");

      insertReport(db, { task_id: "t", round: 2 });
      assert.equal(move(db, "t", "in_review"), "NO_ERROR");
      assert.equal(move(db, "t", "done"), "NO_ERROR", "accepted");
      assert.equal(round(), 2, "acceptance does not move the round");
    });
  });

  it("also bumps on in_review → blocked (a blocker found at review time)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_review" });
      assert.equal(move(db, "t", "blocked"), "NO_ERROR");
      assert.equal(db.prepare("SELECT delivery_round AS r FROM tasks WHERE id='t'").get().r, 2);
      assert.equal(db.prepare("SELECT blocked_at IS NULL AS n FROM tasks WHERE id='t'").get().n, 1);
    });
  });
});

describe("contract/state-machine — one move, one revision (plan §3.3.6③)", () => {
  it("costs exactly one global revision even when the nested round bump fires", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_review" });
      const revision = () => Number(db.prepare("SELECT revision AS r FROM global_revision WHERE singleton=1").get().r);

      const before = revision();
      assert.equal(move(db, "t", "in_progress"), "NO_ERROR");
      assert.equal(revision() - before, 1, "status move + nested round bump = 1 revision");
      assert.equal(db.prepare("SELECT delivery_round AS r FROM tasks WHERE id='t'").get().r, 2);
    });
  });
});
