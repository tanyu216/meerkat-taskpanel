/**
 * Step 6: the state machine, down both paths.
 *
 * `domain/status.mjs` is the fact source and `0013_awaiting_status.sql`
 * re-encodes it as a trigger (0002's, rebuilt with M1's `awaiting` clause). This
 * test walks **every ordered pair** — `statuses²`, so 64 today and 81 the day a
 * ninth status lands — through the service helper *and* through raw SQL, and
 * requires the two verdicts to agree. No count is written out by hand: the pair
 * set is derived from `STATUSES` and the whitelist total from the table itself,
 * so adding a status extends the walk automatically instead of quietly leaving
 * a stale `49` behind.
 *
 * Two conventions worth stating, because they are the only places where the DB
 * is deliberately more permissive than the JS:
 *
 *   * `x → x` is not a transition. The trigger only speaks when the value
 *     actually changes (a no-op UPDATE must stay legal for ordinary writes);
 *     `assertTransition` still rejects it, because asking for it is a bug.
 *   * entering `in_review` is a *whitelist* question and a *gate* question. To
 *     isolate the whitelist, the DB pass seeds the report the gate wants.
 *
 * M1 adds the `awaiting` invariants below: one entry, one exit back into the
 * work, no delivery-gate bypass, and "every road to `done` goes through
 * `in_review`" as a graph property rather than a spot check.
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { STATUSES } from "../../src/core/domain/enums.mjs";
import {
  ALLOWED_TRANSITIONS,
  allowedTargets,
  canTransition,
  holdsClaim,
  isTerminalStatus,
  transitionReasonCode,
} from "../../src/core/domain/status.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { TS, TS2, cleanupTempDirs, ensureActor, insertProject, insertReport, insertTask, reasonCode, withBoard } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to]));

/** The whitelist, counted from the fact source — never a literal. */
const WHITELISTED = Object.values(ALLOWED_TRANSITIONS).reduce((sum, list) => sum + list.length, 0);

/** How many statuses the machine has. Written once, from `STATUSES`. */
const STATUS_COUNT = STATUSES.length;

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

describe("contract/state-machine — every pair, two paths", () => {
  it("covers statuses² ordered pairs, with exactly one row per status", () => {
    assert.equal(PAIRS.length, STATUS_COUNT ** 2, "every ordered pair is walked");
    assert.deepEqual(
      Object.keys(ALLOWED_TRANSITIONS).sort(),
      [...STATUSES].sort(),
      "the whitelist must have exactly one row per status",
    );
    assert.equal(WHITELISTED < PAIRS.length, true, "the whitelist is a proper subset of the pairs");
    for (const status of STATUSES) {
      const targets = allowedTargets(status);
      assert.equal(targets.includes(status), false, `${status} → ${status} must not be whitelisted`);
      assert.equal(
        targets.length === 0,
        isTerminalStatus(status),
        `${status}: a terminal status has no exit and a non-terminal one has at least one`,
      );
    }
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

describe("contract/state-machine — the `awaiting` invariants (M1)", () => {
  it("has in_progress → awaiting as the only entry, down both paths", async () => {
    await withBoard(({ db }) => {
      const viaSql = [];
      for (const from of STATUSES) {
        if (from === "awaiting") continue; // a no-op is not an entry
        const taskId = boardWith(db, from, "awaiting");
        if (move(db, taskId, "awaiting") === "NO_ERROR") viaSql.push(from);
      }
      assert.deepEqual(viaSql, ["in_progress"], "the trigger must admit exactly one entry");
      assert.deepEqual(
        STATUSES.filter((from) => canTransition(from, "awaiting")),
        ["in_progress"],
        "and the service helper must agree",
      );
    });
  });

  it("has awaiting → in_progress as the only way back into the work", async () => {
    await withBoard(({ db }) => {
      const taskId = boardWith(db, "awaiting", "in_progress");
      assert.equal(move(db, taskId, "in_progress"), "NO_ERROR");
      assert.deepEqual(allowedTargets("awaiting"), ["in_progress", "canceled"]);
    });
  });

  it("refuses awaiting → in_review / done / blocked — the delivery-gate bypass (M1)", async () => {
    await withBoard(({ db }) => {
      for (const to of ["in_review", "done", "blocked"]) {
        // A report is seeded so the *only* thing that can refuse this is the
        // whitelist: were the pair allowed, the gate would be satisfied and the
        // move would succeed.
        const id = `t_awaiting_${to}`;
        insertProject(db, { id: `p-awaiting-${to}` });
        insertTask(db, { id, identifier: `AWAIT-${to}`.toUpperCase(), project_id: `p-awaiting-${to}`, status: "awaiting" });
        insertReport(db, { task_id: id, round: 1 });
        assert.equal(move(db, id, to), "INVALID_TRANSITION", `awaiting → ${to} must be refused by the trigger`);
        assert.equal(transitionReasonCode("awaiting", to), "INVALID_TRANSITION");
        assert.equal(canTransition("awaiting", to), false);
      }
      // ...and the allowed exit really is allowed.
      assert.equal(move(db, "t_awaiting_in_review", "canceled"), "NO_ERROR");
    });
  });

  it("keeps awaiting non-terminal and done/canceled terminal, down both paths", async () => {
    await withBoard(({ db }) => {
      assert.equal(isTerminalStatus("awaiting"), false);
      for (const to of STATUSES) {
        if (to === "awaiting") continue;
        const taskId = boardWith(db, "awaiting", to, "_term");
        assert.notEqual(move(db, taskId, to), "TERMINAL_STATE", `awaiting → ${to} is not a terminal refusal`);
      }
      for (const terminal of ["done", "canceled"]) {
        assert.equal(isTerminalStatus(terminal), true);
        const id = `t_${terminal}_from_awaiting`;
        insertProject(db, { id: `p-${terminal}-fa` });
        insertTask(db, { id, identifier: `FA-${terminal}`.toUpperCase(), project_id: `p-${terminal}-fa`, status: terminal });
        assert.equal(move(db, id, "awaiting"), "TERMINAL_STATE");
      }
    });
  });

  it("reaches done only through in_review — exhaustively, over the whole graph", () => {
    // Not a spot check: from every status, the whole reachable set is expanded
    // **without ever stepping through `in_review`**, and `done` must never be in
    // it. This is "no delivery without review" stated as reachability rather
    // than as a list of edges, so a future status cannot open a side door.
    //
    // `in_review` itself is exempt from the start set — it *is* the review, and
    // `in_review → done` is precisely the exit the invariant is built on.
    for (const start of STATUSES) {
      if (start === "in_review") continue;
      const seen = new Set();
      const queue = [...allowedTargets(start)];
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === "in_review" || seen.has(next)) continue;
        seen.add(next);
        queue.push(...allowedTargets(next));
      }
      assert.equal(seen.has("done"), false, `${start} reaches done without passing in_review`);
    }
    // And the direct-predicate form, down both paths.
    assert.deepEqual(
      STATUSES.filter((from) => canTransition(from, "done")),
      ["in_review"],
    );
  });

  it("does not start a delivery round on awaiting → in_progress (M1)", async () => {
    await withBoard(({ db }) => {
      const id = "t_awaiting_round";
      insertProject(db, { id: "p-awaiting-round" });
      insertTask(db, { id, identifier: "AWAIT-ROUND", project_id: "p-awaiting-round", status: "in_progress" });
      const round = () => db.prepare("SELECT delivery_round AS r FROM tasks WHERE id = ?").get(id).r;

      assert.equal(round(), 1);
      assert.equal(move(db, id, "awaiting"), "NO_ERROR");
      assert.equal(round(), 1, "asking a human is not a new delivery attempt");
      assert.equal(move(db, id, "in_progress"), "NO_ERROR");
      assert.equal(round(), 1, "resuming continues the same round — the round's report still counts");

      // The contrast that proves the counter is not simply stuck: leaving
      // in_review is what bumps it (F3).
      insertReport(db, { task_id: id, round: 1 });
      assert.equal(move(db, id, "in_review"), "NO_ERROR");
      assert.equal(round(), 1);
      assert.equal(move(db, id, "in_progress"), "NO_ERROR");
      assert.equal(round(), 2, "in_review → in_progress is the F3 bump");
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

/**
 * The execution claim, walked over the whole whitelist (T-20261014-152924 ①).
 *
 * `holdsClaim` is the domain fact — the claim lives while the card is inside the
 * work cycle and is released by the very UPDATE that takes it out — and this
 * test is the storage half of it: one claimed card per whitelisted pair, moved
 * through `repos.tasks.moveCas`, then the **row** is read back and compared with
 * the predicate. A pair the trigger refuses (there are several: `done` only from
 * `in_review`, `in_review` only with a report, terminal states not at all) is
 * recorded as not-exercised rather than counted as a pass — the assertion at the
 * end requires every destination status to have been reached by at least one
 * pair, so "the move was refused" can never quietly become "the claim was fine".
 */
describe("contract/state-machine — the execution claim follows the work cycle", () => {
  it("releases the claim on every destination outside the cycle, keeps it inside", async () => {
    await withBoard(({ db }) => {
      const repos = createRepositories(db);
      const wrong = [];
      const refused = [];
      const reached = new Set();

      for (const from of STATUSES) {
        for (const to of allowedTargets(from)) {
          const id = `t_${from}_${to}`;
          insertProject(db, { id: `p-${from}-${to}` });
          insertTask(db, {
            id,
            identifier: `${from}-${to}`.toUpperCase(),
            project_id: `p-${from}-${to}`,
            status: from,
            // A `backlog` card may not hold a claim (the CHECK this card fixes);
            // every other status seeds the claim the move must carry.
            ...(from === "backlog" ? {} : { claimed_by: "linus", claimed_at: TS, heartbeat_at: TS }),
          });
          if (to === "in_review") insertReport(db, { task_id: id, round: 1 });

          try {
            repos.tasks.moveCas({ id, to, now: TS2 });
          } catch (err) {
            refused.push(`${from} → ${to}: ${err.code}`);
            continue;
          }
          reached.add(to);
          const after = db.prepare("SELECT status, claimed_by FROM tasks WHERE id = ?").get(id);
          assert.equal(after.status, to);
          const expected = holdsClaim(to) ? "linus" : null;
          if (after.claimed_by !== expected) {
            wrong.push(`${from} → ${to}: claimed_by=${JSON.stringify(after.claimed_by)}, expected ${JSON.stringify(expected)}`);
          }
        }
      }

      assert.deepEqual(wrong, [], "the row must agree with holdsClaim on every move");
      // Coverage: a destination no pair could reach would make the walk vacuous
      // for that status. Every one of the eight is reachable — `backlog` from
      // `todo`, which is also the leg the reported bug travelled.
      assert.deepEqual(
        STATUSES.filter((to) => !reached.has(to)),
        [],
        "every destination must be reached by some pair",
      );
      assert.ok(reached.size === STATUSES.length);
      // ...and the refusals are the whitelist's own gate, never a claim:
      // a `VERSION_CONFLICT`/`CLAIM_LOST`/`VALIDATION_FAILED` here would mean
      // this walk measured something other than the release.
      for (const entry of refused) {
        assert.match(entry, /: (REPORT_REQUIRED|INVALID_TRANSITION|TERMINAL_STATE)$/, entry);
      }
    });
  });

  it("leaves the backlog CHECK unreachable from the release's own paths", async () => {
    await withBoard(({ db }) => {
      const repos = createRepositories(db);
      // The reported bug, at the storage layer: claim a card, walk it out of the
      // work cycle into `todo`, then to `backlog`. Before the release, the second
      // leg hit `CHECK constraint failed: claimed_by IS NULL OR status <>
      // 'backlog'`; now the first leg has already dropped the claim.
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      ensureActor(db, "linus"); // claimed_by is a reference since 0020
      repos.tasks.claimCas({ id: "t", actor: "linus", now: TS });
      assert.equal(db.prepare("SELECT claimed_by FROM tasks WHERE id='t'").get().claimed_by, "linus");

      repos.tasks.moveCas({ id: "t", to: "todo", now: TS2 });
      assert.equal(
        db.prepare("SELECT claimed_by FROM tasks WHERE id='t'").get().claimed_by,
        null,
        "in_progress → todo releases the lock in the same write",
      );
      repos.tasks.moveCas({ id: "t", to: "backlog", now: TS2 });
      assert.equal(db.prepare("SELECT status, claimed_by FROM tasks WHERE id='t'").get().status, "backlog");

      // The CHECK is still there, and still refuses a claim on a backlog card
      // written by anything else — the release closes the path, it does not
      // weaken the guarantee (`test/contract/invariants.test.mjs`).
      const verdict = reasonCode(() => db.prepare("UPDATE tasks SET claimed_by = 'linus' WHERE id = 't'").run());
      assert.equal(verdict, "CLAIM_ON_BACKLOG");
    });
  });
});
