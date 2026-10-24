/**
 * Step 6: the invariants that live in the schema (ARCHITECTURE §4.2, card A5).
 *
 * Everything here talks to SQLite *directly* — no repositories, no commands —
 * because the point is that these hold even for a writer that bypasses the
 * service layer. Whenever a reason code appears, it is the same code the
 * service raises (the mapping lives in `storage/sqlite-errors.mjs`).
 *
 *   I1 claim is atomic                 → exactly one winner, ever
 *   I2 execution uniqueness            → a live claim cannot be taken twice
 *   I3 terminal states reopen to todo  → done/canceled have exactly one exit
 *   I4 comments are append-only        → no UPDATE, no DELETE
 *   I5 human decisions are on record   → readable, and just as immutable
 *   I6 archiving is for finished work  → and does not touch status
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import { openDatabase } from "../../src/core/storage/driver.mjs";
import { createContext } from "../../src/core/commands/index.mjs";
import { addRelation, listRelations } from "../../src/core/commands/relations.mjs";
import { assertBlockEdgeAllowed, blockedPairOnChain, isOnSameParentChain, parentChainOf } from "../../src/core/domain/relation.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import {
  TS,
  TS2,
  cleanupTempDirs,
  countRows,
  createTempBoard,
  ensureActor,
  insertProject,
  insertReport,
  insertTask,
  reasonCode,
  revision,
  withBoard,
} from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DRIVER = resolve(ROOT, "src/core/storage/driver.mjs");

/** The claim CAS, verbatim (repositories/tasks.mjs uses this shape). */
function claimWith(db, { taskId, version, actor, at }) {
  const info = db
    .prepare(
      `UPDATE tasks
          SET status = 'in_progress', claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
              version = version + 1, updated_at = ?, status_changed_at = ?
        WHERE id = ? AND status = 'todo' AND version = ?`,
    )
    .run(actor, at, at, at, at, taskId, version);
  return Number(info.changes);
}

function seedRelationalBoard(db) {
  insertProject(db);
  for (const id of ["a", "b", "c", "d", "e"]) {
    insertTask(db, { id, identifier: `PROJ-${id.toUpperCase()}`, status: "todo", kind: "epic" });
  }
  insertProject(db, { id: "other" });
  insertTask(db, { id: "z", identifier: "OTHER-Z", project_id: "other", status: "todo" });
}

const addParent = (db, source, target) =>
  reasonCode(() =>
    db
      .prepare(
        "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('parent', ?, ?, ?)",
      )
      .run(source, target, TS),
  );

/** The same insert, for fixtures that only need the edge to *exist* (source = parent). */
const addParentEdge = (db, source, target) =>
  db
    .prepare(
      "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('parent', ?, ?, ?)",
    )
    .run(source, target, TS);

describe("contract/invariants — I1/I2 claim atomicity", () => {
  it("eight connections race for one task and exactly one wins", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      // `claimed_by` is a reference since 0020 — the racing actors must exist.
      for (let i = 0; i < 8; i += 1) ensureActor(board.db, `agent-${i}`);
      const path = board.dbPath;
      board.close();

      const connections = [];
      for (let i = 0; i < 8; i += 1) connections.push(await openDatabase({ path }));
      const wins = connections.map((db, i) =>
        claimWith(db, { taskId: "t", version: 1, actor: `agent-${i}`, at: TS2 }),
      );
      for (const db of connections) db.close();

      assert.equal(wins.filter((n) => n === 1).length, 1, `expected one winner, got ${wins}`);
      assert.equal(wins.filter((n) => n === 0).length, 7);
    } finally {
      board.close();
    }
  });

  it("eight real processes race for one task and exactly one wins", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      // `claimed_by` is a reference since 0020 — the racing actors must exist.
      for (let i = 0; i < 8; i += 1) ensureActor(board.db, `proc-${i}`);
      const dbPath = board.dbPath;
      board.close();

      const script = `
        import { openDatabase } from ${JSON.stringify(DRIVER)};
        const db = await openDatabase({ path: process.env.TASKD_TEST_DB });
        const info = db.prepare(
          "UPDATE tasks SET status='in_progress', claimed_by=?, claimed_at=?, heartbeat_at=?, version=version+1, updated_at=?, status_changed_at=? WHERE id=? AND status='todo' AND version=?"
        ).run(process.env.TASKD_TEST_ACTOR, "2026-10-08T00:02:00.000Z", "2026-10-08T00:02:00.000Z", "2026-10-08T00:02:00.000Z", "2026-10-08T00:02:00.000Z", "t", 1);
        db.close();
        process.stdout.write(String(info.changes));
      `;

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          new Promise((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
              env: { ...process.env, TASKD_TEST_DB: dbPath, TASKD_TEST_ACTOR: `proc-${i}` },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.stderr.on("data", (chunk) => (err += chunk));
            child.on("error", rejectPromise);
            child.on("close", (code) =>
              code === 0 ? resolvePromise(out.trim()) : rejectPromise(new Error(err || `exit ${code}`)),
            );
          }),
        ),
      );

      assert.deepEqual(
        results.filter((r) => r === "1").length,
        1,
        `expected one winner across processes, got ${JSON.stringify(results)}`,
      );
      assert.deepEqual(results.filter((r) => r === "0").length, 7);
    } finally {
      board.close();
    }
  });

  it("refuses to take a task that is already being executed (I2)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      ensureActor(db, "linus");
      assert.equal(claimWith(db, { taskId: "t", version: 1, actor: "linus", at: TS }), 1);

      // Same actor, still fresh: the service reuses the claim instead of erroring,
      // but the CAS itself must not hand out a second claim.
      assert.equal(claimWith(db, { taskId: "t", version: 2, actor: "linus", at: TS }), 0);
      assert.equal(claimWith(db, { taskId: "t", version: 2, actor: "someone-else", at: TS }), 0);

      const row = db.prepare("SELECT status, claimed_by, version FROM tasks WHERE id='t'").get();
      assert.deepEqual({ ...row }, { status: "in_progress", claimed_by: "linus", version: 2 });

      // The corrupt shape (`in_progress` with nobody claiming it) must be
      // representable, otherwise the service could never report it.
      db.prepare("UPDATE tasks SET claimed_by = NULL WHERE id = 't'").run();
      const corrupt = db.prepare("SELECT status, claimed_by FROM tasks WHERE id='t'").get();
      assert.equal(corrupt.status, "in_progress");
      assert.equal(corrupt.claimed_by, null);
    });
  });
});

describe("contract/invariants — I3 terminal states", () => {
  it("leaves done/canceled only for todo, by direct SQL", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const forbidden = ["backlog", "in_progress", "in_review", "blocked", "awaiting", "done", "canceled"];
      for (const from of ["done", "canceled"]) {
        for (const to of forbidden) {
          if (to === from) continue;
          const id = `${from}_${to}`;
          insertTask(db, { id, identifier: `PROJ-${id}`, status: from });
          assert.equal(
            reasonCode(() => db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(to, id)),
            "TERMINAL_STATE",
            `${from} → ${to} must be refused`,
          );
        }
        // …and the one exit it has: back to the queue, with a new round.
        const id = `${from}_todo`;
        insertTask(db, { id, identifier: `PROJ-${id}`, status: from });
        const round = () => db.prepare("SELECT delivery_round AS r FROM tasks WHERE id = ?").get(id).r;
        const before = round();
        assert.equal(
          reasonCode(() => db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(id)),
          "NO_ERROR",
          `${from} → todo is the reopen edge`,
        );
        assert.equal(round(), before + 1, "a reopen starts a new delivery round");
      }
    });
  });

  it("still lets a terminal task be edited and archived (I6)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "done", status_changed_at: TS });
      assert.equal(
        reasonCode(() =>
          db.prepare("UPDATE tasks SET title = ?, version = version + 1 WHERE id = 't'").run("renamed"),
        ),
        "NO_ERROR",
      );
      assert.equal(
        reasonCode(() =>
          db
            .prepare("UPDATE tasks SET archived_at = ?, version = version + 1 WHERE id = 't'")
            .run(TS2),
        ),
        "NO_ERROR",
      );
      const row = db.prepare("SELECT status, archived_at FROM tasks WHERE id='t'").get();
      assert.equal(row.status, "done", "archiving must not touch status");
      assert.equal(row.archived_at, TS2);
    });
  });

  it("refuses to archive anything unfinished (I6)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked"]) {
        insertTask(db, { id: status, identifier: `PROJ-${status}`.toUpperCase(), status });
        assert.equal(
          reasonCode(() =>
            db.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(TS2, status),
          ),
          "ARCHIVE_NOT_TERMINAL",
          status,
        );
      }
    });
  });
});

describe("contract/invariants — I4/I5 the record is immutable", () => {
  it("appends a human decision and then refuses to touch it", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001" });
      ensureActor(db, "Terry", "human");
      db.prepare(
        `INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, refs_json, created_at)
         VALUES ('c1', 't', 'go ahead', 'confirm', 'human', 'Terry', '["PROJ-0001"]', ?)`,
      ).run(TS);

      const row = db.prepare("SELECT body, kind, author_id FROM comments WHERE id='c1'").get();
      assert.deepEqual({ ...row }, { body: "go ahead", kind: "confirm", author_id: "Terry" });

      assert.equal(
        reasonCode(() => db.prepare("UPDATE comments SET body = 'rewritten' WHERE id='c1'").run()),
        "COMMENT_APPEND_ONLY",
      );
      assert.equal(
        reasonCode(() => db.prepare("DELETE FROM comments WHERE id='c1'").run()),
        "COMMENT_APPEND_ONLY",
      );
      assert.equal(countRows(db, "comments"), 1, "the record survived both attempts");
    });
  });
});

describe("contract/invariants — relations", () => {
  it("allows at most one parent per child", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      assert.equal(addParent(db, "a", "b"), "NO_ERROR");
      assert.equal(addParent(db, "c", "b"), "SINGLE_PARENT_VIOLATION");
    });
  });

  it("refuses self-references and cross-project edges", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      assert.equal(addParent(db, "a", "a"), "SELF_REFERENCE");
      assert.equal(addParent(db, "a", "z"), "CROSS_PROJECT_RELATION");
      // Every relation type, not just parent.
      for (const type of ["blocks", "related"]) {
        assert.equal(
          reasonCode(() =>
            db
              .prepare(
                "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES (?, ?, 'z', ?)",
              )
              .run(type, type === "related" ? "a" : "b", TS),
          ),
          "CROSS_PROJECT_RELATION",
          type,
        );
      }
    });
  });

  it("refuses a typo'd task id with NOT_FOUND rather than a relation code", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      assert.equal(addParent(db, "a", "nope"), "NOT_FOUND");
    });
  });

  it("detects cycles in three- and four-node chains", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      assert.equal(addParent(db, "a", "b"), "NO_ERROR");
      assert.equal(addParent(db, "b", "c"), "NO_ERROR");
      assert.equal(addParent(db, "c", "a"), "RELATION_CYCLE", "3-node ring");

      assert.equal(addParent(db, "c", "d"), "NO_ERROR");
      assert.equal(addParent(db, "d", "e"), "NO_ERROR");
      assert.equal(addParent(db, "e", "a"), "RELATION_CYCLE", "4-node ring");

      // A second parent for `e` is refused by the index before the cycle guard
      // is even consulted — the reason code must not depend on which fires first.
      assert.equal(addParent(db, "a", "e"), "SINGLE_PARENT_VIOLATION");
    });
  });

  it("caps chain length at 8 nodes", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      for (const id of ["f", "g", "h", "i"]) {
        insertTask(db, { id, identifier: `PROJ-${id.toUpperCase()}`, kind: id === "i" ? "task" : "epic" });
      }
      // a..h is already 8 nodes deep (a→b→c→d→e→f→g→h).
      const chain = ["b", "c", "d", "e", "f", "g", "h"];
      let parent = "a";
      for (const child of chain) {
        assert.equal(addParent(db, parent, child), "NO_ERROR", `${parent} → ${child}`);
        parent = child;
      }
      assert.equal(addParent(db, "h", "i"), "CHAIN_TOO_LONG", "a 9th node is too deep");
    });
  });

  it("caps fan-in at 8 children", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      for (let i = 1; i <= 9; i += 1) {
        insertTask(db, { id: `kid${i}`, identifier: `PROJ-KID${i}` });
      }
      for (let i = 1; i <= 8; i += 1) {
        assert.equal(addParent(db, "a", `kid${i}`), "NO_ERROR", `child ${i}`);
      }
      assert.equal(addParent(db, "a", "kid9"), "FANIN_TOO_HIGH");
    });
  });

  it("normalises the direction of `related` and keeps relations immutable", async () => {
    await withBoard(({ db }) => {
      seedRelationalBoard(db);
      assert.equal(
        reasonCode(() =>
          db
            .prepare(
              "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('related', 'b', 'a', ?)",
            )
            .run(TS),
        ),
        "RELATION_DIRECTION_INVALID",
        "related is stored source < target",
      );
      assert.equal(reasonCode(() => db.prepare("INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('related', 'a', 'b', ?)").run(TS)), "NO_ERROR");
      assert.equal(reasonCode(() => db.prepare("INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('related', 'a', 'b', ?)").run(TS)), "RELATION_DUPLICATE");
      assert.equal(
        reasonCode(() => db.prepare("UPDATE task_relations SET origin = 'x'").run()),
        "RELATION_IMMUTABLE",
      );
    });
  });
});

describe("contract/invariants — enum CHECKs", () => {
  it("refuses out-of-vocabulary values at the database", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const task = (extra) =>
        reasonCode(() =>
          db
            .prepare(
              `INSERT INTO tasks(id, identifier, project_id, title, status, priority, kind, created_at, updated_at)
               VALUES (?, ?, 'proj', 't', ?, ?, ?, ?, ?)`,
            )
            .run(...extra),
        );
      assert.equal(task(["x1", "X1", "ready", "medium", "task", TS, TS]), "VALIDATION_FAILED", "v1 word in status");
      assert.equal(task(["x2", "X2", "todo", "blocker", "task", TS, TS]), "VALIDATION_FAILED", "priority");
      assert.equal(task(["x3", "X3", "todo", "medium", "story", TS, TS]), "VALIDATION_FAILED", "kind");

      insertTask(db, { id: "t", identifier: "PROJ-0001" });
      insertTask(db, { id: "t2", identifier: "PROJ-0002" });
      assert.equal(
        reasonCode(() =>
          db
            .prepare(
              "INSERT INTO comments(id, task_id, body, kind, author_kind, author_id, created_at) VALUES ('c','t','b','shout','human','T',?)",
            )
            .run(TS),
        ),
        "VALIDATION_FAILED",
        "comment kind",
      );
      assert.equal(
        reasonCode(() =>
          db
            .prepare(
              "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('depends_on','t','t2',?)",
            )
            .run(TS),
        ),
        "VALIDATION_FAILED",
        "relation type",
      );
    });
  });

  it("refuses a backlog task that claims to be claimed", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "backlog" });
      // T-20261014-152924 — this CHECK names itself now. It is the constraint
      // Terry's drag tripped, and it used to arrive as a generic
      // `VALIDATION_FAILED` still carrying the raw SQLite sentence
      // (`CHECK constraint failed: claimed_by IS NULL OR status <> 'backlog'`).
      // The service releases the claim on the way out of the work cycle
      // (`domain/status.mjs#CLAIM_HOLDING_STATUSES`), so reaching this line means
      // a foreign writer wrote the row; `CLAIM_ON_BACKLOG` says which rule it
      // broke, and the message says it in words.
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET claimed_by = 'linus' WHERE id = 't'").run()),
        "CLAIM_ON_BACKLOG",
      );
    });
  });
});

describe("contract/invariants — the delivery gate, straight to SQL (A7)", () => {
  const deliver = (db, taskId) =>
    reasonCode(() =>
      db
        .prepare("UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ? WHERE id = ?")
        .run(TS2, taskId),
    );

  it("refuses in_progress → in_review with no report at all", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_progress" });
      assert.equal(deliver(db, "t"), "REPORT_REQUIRED");
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id='t'").get().status, "in_progress");
    });
  });

  it("refuses a report from a previous round (the report must be current)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_progress" });
      const rework = () =>
        reasonCode(() =>
          db
            .prepare("UPDATE tasks SET status = 'in_progress', version = version + 1 WHERE id = 't'")
            .run(),
        );

      insertReport(db, { task_id: "t", round: 1 });
      assert.equal(deliver(db, "t"), "NO_ERROR");
      assert.equal(rework(), "NO_ERROR");
      assert.equal(
        db.prepare("SELECT delivery_round r FROM tasks WHERE id='t'").get().r,
        2,
        "rework starts round 2",
      );
      assert.equal(deliver(db, "t"), "REPORT_REQUIRED", "R1 cannot deliver round 2");

      insertReport(db, { task_id: "t", round: 2 });
      assert.equal(deliver(db, "t"), "NO_ERROR");
    });
  });

  it("refuses to enter in_review from a status that cannot reach it", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "todo" });
      insertReport(db, { task_id: "t", round: 1 });
      assert.equal(deliver(db, "t"), "INVALID_TRANSITION", "the whitelist speaks first");
    });
  });

  // M2 (F-B1) replaced M1's "there is no waiver at all": the gate is still the
  // gate, but it now has exactly one extra way through, and the *trigger* is
  // where that has to be true — this test writes SQL directly, bypassing
  // `domain/delivery-gate.mjs` entirely. The two must agree, so this case and
  // `test/core/domain/delivery-gate.test.mjs` assert the same boundaries.
  it("lets a round-scoped, reasoned waiver through the trigger — and nothing weaker", async () => {
    const REASON = "hotfix: report follows in a change comment";
    const waive = (db, taskId, round, reason) =>
      reasonCode(() =>
        db
          .prepare(
            "UPDATE tasks SET status = 'in_review', report_waiver_round = ?, report_waiver_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(round, reason, TS2, taskId),
      );

    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_progress" });
      assert.equal(deliver(db, "t"), "REPORT_REQUIRED", "no waiver at all is still refused");

      assert.equal(waive(db, "t", 9, REASON), "REPORT_REQUIRED", "a waiver for another round does not count");
      assert.equal(waive(db, "t", 1, "short"), "REPORT_REQUIRED", "a one-word reason is not a reason");
      assert.equal(waive(db, "t", 1, "        "), "REPORT_REQUIRED", "whitespace is not a reason");
      assert.equal(waive(db, "t", 1, null), "REPORT_REQUIRED", "no reason, no waiver");
      assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 't'").get().status, "in_progress");

      assert.equal(waive(db, "t", 1, REASON), "NO_ERROR", "the current round with a real reason gets through");
      const row = db.prepare("SELECT status, report_waiver_round FROM tasks WHERE id = 't'").get();
      assert.equal(row.status, "in_review");
      assert.equal(Number(row.report_waiver_round), 1);

      // Coming back for rework bumps the round (0003), so the waiver is spent.
      db.prepare("UPDATE tasks SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = 't'").run(TS2);
      assert.equal(Number(db.prepare("SELECT delivery_round FROM tasks WHERE id = 't'").get().delivery_round), 2);
      assert.equal(waive(db, "t", 1, REASON), "REPORT_REQUIRED", "round 1's waiver is dead");
      assert.equal(waive(db, "t", 2, REASON), "NO_ERROR");
    });
  });

  it("keeps report_latest_id pointing at a report that belongs to the task", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_progress" });
      insertTask(db, { id: "u", identifier: "PROJ-0002", status: "todo" });
      const reportId = insertReport(db, { task_id: "t", round: 1 });

      assert.equal(
        reasonCode(() =>
          db.prepare("UPDATE tasks SET report_latest_id = ? WHERE id = 'u'").run(reportId),
        ),
        "REPORT_TASK_MISMATCH",
      );
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET report_latest_id = 99999 WHERE id = 'u'").run()),
        "REPORT_TASK_MISMATCH",
        "a bogus id must not be silently accepted",
      );
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET report_latest_id = ? WHERE id = 't'").run(reportId)),
        "NO_ERROR",
      );
    });
  });
});

describe("contract/invariants — global_revision covers every write table", () => {
  it("bumps the cursor once per row written, for every table", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001" });
      insertTask(db, { id: "t2", identifier: "PROJ-0002" });
      // `author_id` is a reference since 0020 — the report author must exist.
      ensureActor(db, "linus");
      const writes = [
        // 0019: one actor table, not two dictionary tables.
        () => db.prepare("INSERT INTO actors(id,display_name,normalized_name,first_seen_at,last_seen_at) VALUES('as','A','a',?,?)").run(TS, TS),
        () => db.prepare("INSERT INTO task_relations(relation_type,source_task_id,target_task_id,created_at) VALUES('blocks','t','t2',?)").run(TS),
        () => db.prepare("INSERT INTO comments(id,task_id,body,kind,author_kind,author_id,created_at) VALUES('c','t','b','note','agent','as',?)").run(TS),
        () => db.prepare("INSERT INTO task_activities(task_id,event,changes_json,created_at) VALUES('t','x','{}',?)").run(TS),
        () => db.prepare("INSERT INTO attachments(id,task_id,filename,kind,created_at) VALUES('at','t','f','attachment',?)").run(TS),
        () => db.prepare("INSERT INTO agent_sessions(id,task_id,seg,owner,owner_kind,session_id,status,ts) VALUES('s','t','seg1','linus','claude','sid','running',?)").run(TS),
        () => db.prepare("INSERT INTO task_reports(task_id,round,conclusion,acceptance_json,evidence_json,author_kind,author_id,created_at) VALUES('t',1,'c','[]','[]','agent','linus',?)").run(TS),
        () => db.prepare("UPDATE projects SET name = 'renamed' WHERE id = 'proj'").run(),
        () => db.prepare("UPDATE tasks SET title = 'renamed' WHERE id = 't'").run(),
      ];
      let expected = revision(db);
      for (const [index, write] of writes.entries()) {
        write();
        expected += 1;
        assert.equal(revision(db), expected, `write #${index + 1} must bump the cursor exactly once`);
      }
    });
  });
});

describe("contract/invariants — indexes are actually used", () => {
  it("plans the identifier lookup through ux_tasks_identifier", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE project_id = ? AND identifier = ?")
        .all("proj", "PROJ-0001")
        .map((row) => String(row.detail))
        .join(" | ");
      assert.match(plan, /ux_tasks_identifier/, plan);
    });
  });

  it("plans the board query through ix_tasks_board", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE project_id = ? AND status = ? ORDER BY sort_order")
        .all("proj", "todo")
        .map((row) => String(row.detail))
        .join(" | ");
      assert.match(plan, /ix_tasks_board/, plan);
    });
  });

  it("plans the report lookup through an index, not a scan", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM task_reports WHERE task_id = ? AND round = ?")
        .all("t", 1)
        .map((row) => String(row.detail))
        .join(" | ");
      assert.match(plan, /USING (COVERING )?INDEX/, plan);
      assert.equal(/SCAN task_reports/.test(plan), false, plan);
    });
  });

  it("plans the event cursor through ix_activities_revision, not a scan", async () => {
    await withBoard(({ db }) => {
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM task_activities WHERE revision > ? ORDER BY revision, id LIMIT 500")
        .all(0)
        .map((row) => String(row.detail))
        .join(" | ");
      assert.match(plan, /ix_activities_revision/, plan);
    });
  });

  it("plans the project activity window through ix_activities_created", async () => {
    await withBoard(({ db }) => {
      // The real aggregation from `projects.mjs#activityByProject`: if this
      // stops using the index, the project list is scanning the audit trail.
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT t.project_id AS project_id,
                    SUM(CASE WHEN a.created_at >= ? THEN 1 ELSE 0 END) AS a7,
                    COUNT(*) AS a30,
                    MAX(a.created_at) AS last_activity
               FROM task_activities a
               JOIN tasks t ON t.id = a.task_id
              WHERE a.event NOT IN (?) AND a.created_at >= ?
              GROUP BY t.project_id`,
        )
        .all("2026-01-01T00:00:00.000Z", "task_heartbeat", "2025-01-01T00:00:00.000Z")
        .map((row) => String(row.detail))
        .join(" | ");
      assert.match(plan, /ix_activities_created/, plan);
    });
  });
});

/**
 * T-20261015-063755 — a `blocks` edge may not join an ancestor and a descendant
 * (`0019_block_chain.sql`; Elon's reading 乙 of the "ancestor" ruling on
 * T-20261014-212017). The defect: a descendant could `depends_on` its own parent
 * epic and an epic could `depends_on` its own child, both HTTP 200.
 *
 * Unlike the rest of this file, which talks to SQLite and nothing else, this
 * section walks **both** paths — the card asks for exactly that — because the
 * whole point is that they agree. The trigger is the guarantee; the service
 * layer repeats it only to phrase it. `test/contract/block-cycle.test.mjs` is
 * the 0017 counterpart of the same shape.
 *
 *   N10a  a cycle in the parent chain is refused        (0002/0010, already)
 *   N10b  `D depends_on E`, E the parent of D           → RELATION_CYCLE / 422
 *   N10c  `E depends_on D`, D a child of E              → RELATION_CYCLE / 422
 *   N10d  the picker never offers an ancestor           → the board *says which*
 *                                                         (`parentChain`, below)
 *   —     two siblings may still be ordered             → accepted, both paths
 *
 * N10d is a UI reading, and this layer cannot make it: what this layer can do —
 * and what T-20261015-104813 added — is answer the question the UI asks. The
 * drawer's prerequisite picker filters its candidate roster by
 * `listRelations().parentChain`, the same two walks the guard above uses, so the
 * picker and the refusal cannot disagree. The readings below are that answer:
 * the ancestor and the descendant in it, the sibling and the stranger out.
 */
describe("contract/invariants — a blocks edge may not join an ancestor and a descendant", () => {
  /** `e → d → g`, plus siblings `s1`/`s2` under `e` and an unrelated `u`. */
  function seedChain(db) {
    insertProject(db);
    insertProject(db, { id: "other", name: "Other" });
    insertTask(db, { id: "e", identifier: "PROJ-E", kind: "epic" });
    insertTask(db, { id: "d", identifier: "PROJ-D", kind: "epic" });
    insertTask(db, { id: "g", identifier: "PROJ-G" });
    insertTask(db, { id: "s1", identifier: "PROJ-S1" });
    insertTask(db, { id: "s2", identifier: "PROJ-S2" });
    insertTask(db, { id: "u", identifier: "PROJ-U" });
    insertTask(db, { id: "z", identifier: "OTHER-Z", project_id: "other" });
    for (const [parent, child] of [["e", "d"], ["d", "g"], ["e", "s1"], ["e", "s2"]]) {
      addParentEdge(db, parent, child);
    }
  }

  // `id` is an INTEGER PRIMARY KEY, so the row names only what the edge *is*.
  const insertEdge = (db, type, source, target) => () =>
    db
      .prepare("INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES (?, ?, ?, ?)")
      .run(type, source, target, TS);

  it("reads the parent chain in both directions, and leaves siblings off it", () => {
    const edges = [
      { source: "e", target: "d" },
      { source: "d", target: "g" },
      { source: "e", target: "s1" },
      { source: "e", target: "s2" },
    ];
    assert.equal(isOnSameParentChain(edges, "e", "d"), true, "the parent");
    assert.equal(isOnSameParentChain(edges, "d", "e"), true, "the same pair, read the other way");
    assert.equal(isOnSameParentChain(edges, "e", "g"), true, "two generations above");
    assert.equal(isOnSameParentChain(edges, "g", "e"), true);
    assert.equal(isOnSameParentChain(edges, "d", "g"), true);
    assert.equal(isOnSameParentChain(edges, "x", "x"), true, "itself is trivially on its own chain");
    assert.equal(isOnSameParentChain(edges, "s1", "s2"), false, "siblings share a parent, not a chain");
    assert.equal(isOnSameParentChain(edges, "d", "u"), false, "no shared chain at all");
    assert.equal(isOnSameParentChain([], "a", "b"), false, "an empty board has no chain");
  });

  it("hands the drawer both directions of the chain — and only the chain", () => {
    const edges = [
      { source: "e", target: "d" },
      { source: "d", target: "g" },
      { source: "e", target: "s1" },
      { source: "e", target: "s2" },
    ];
    // `d` sits between `e` and `g`: one ancestor above it, one descendant below.
    assert.deepEqual(parentChainOf(edges, "d").sort(), ["e", "g"]);
    // A leaf's chain runs only upward; the root's only downward.
    assert.deepEqual(parentChainOf(edges, "g").sort(), ["d", "e"]);
    assert.deepEqual(parentChainOf(edges, "e").sort(), ["d", "g", "s1", "s2"]);
    // The card itself is not in its own chain: a self-edge has its own code
    // (`SELF_REFERENCE`), and a picker row that cannot be chosen is a worse
    // answer than an absent one.
    assert.equal(parentChainOf(edges, "d").includes("d"), false);
    // Off the chain: a sibling, and a card the chain does not reach.
    assert.equal(parentChainOf(edges, "s1").includes("s2"), false, "siblings are orderable");
    assert.equal(parentChainOf(edges, "u").includes("e"), false);
    assert.deepEqual(parentChainOf([], "a"), []);
  });

  it("answers that question over the real board, from the card's own relation read", async () => {
    const board = await createTempBoard();
    try {
      seedChain(board.db);
      const ctx = createContext({ db: board.db, repos: createRepositories(board.db), clock: () => TS });
      const ids = new Map(
        board.db
          .prepare("SELECT id, identifier FROM tasks")
          .all()
          .map((row) => [String(row.identifier), String(row.id)]),
      );
      const chainOf = (ref) => new Set(listRelations(ctx, { taskId: ref }).parentChain);
      const has = (chain, identifier) => chain.has(ids.get(identifier));

      // The leaf reads its two ancestors; the root reads everything under it.
      const leaf = chainOf("PROJ-G");
      assert.equal(has(leaf, "PROJ-D"), true);
      assert.equal(has(leaf, "PROJ-E"), true, "the walk is the chain, not the immediate parent");
      assert.equal(has(leaf, "PROJ-G"), false, "a card is not on its own chain");
      assert.equal(has(leaf, "PROJ-S1"), false, "an uncle is not on it");

      const root = chainOf("PROJ-E");
      for (const under of ["PROJ-D", "PROJ-G", "PROJ-S1", "PROJ-S2"]) {
        assert.equal(has(root, under), true, `${under} is under PROJ-E`);
      }
      assert.equal(has(root, "PROJ-U"), false, "a stranger is not");

      // The point of the field: filtering the picker's roster by it takes out
      // the two ancestors. What is left is the sibling and the stranger — plus
      // the card's own row, which this set deliberately keeps, because a
      // self-edge is `SELF_REFERENCE`, a different code this walk does not own.
      // The drawer subtracts that row separately
      // (`web/src/stores/board.js#dependsCandidates`, T-20261015-132952), so
      // this reading pins the chain half alone: folding the two exclusions
      // together — widening `parent_chain` to carry the card's own id, say —
      // would drop `PROJ-G` from the list below and show up right here.
      const roster = board.db.prepare("SELECT id, identifier FROM tasks WHERE project_id = 'proj'").all();
      const candidates = roster.filter((task) => !leaf.has(String(task.id))).map((task) => String(task.identifier));
      assert.deepEqual(candidates.sort(), ["PROJ-G", "PROJ-S1", "PROJ-S2", "PROJ-U"]);
    } finally {
      board.close();
    }
  });

  it("refuses the edge in the service layer, with the code and the words the caller sees", () => {
    const parentEdges = [{ source: "e", target: "d" }];
    for (const edge of [{ source: "d", target: "e" }, { source: "e", target: "d" }]) {
      assert.throws(
        () => assertBlockEdgeAllowed(edge, { edges: [], parentEdges }),
        (err) => {
          assert.equal(err.code, "RELATION_CYCLE");
          assert.equal(err.http, 422, "the ruling asks for a rejection the client can read as 422");
          assert.equal(err.details.type, "blocks");
          assert.equal(err.details.chain, "ancestor", "the chain reason is distinguishable from a loop");
          assert.match(err.message, /ancestor and a descendant cannot depend on each other/, err.message);
          assert.ok(err.message.includes(edge.source) && err.message.includes(edge.target), err.message);
          return true;
        },
      );
    }
    // "含自身": a card is trivially on its own chain, so the guard refuses the
    // identity edge with this code too. The command never gets here — normalization
    // raises SELF_REFERENCE before the shape rules run, and the trigger's
    // `source <> target` clause keeps it off SELF_REFERENCE's row — which is why
    // this is asserted on the pure rule rather than through the use-case.
    assert.throws(
      () => assertBlockEdgeAllowed({ source: "x", target: "x" }, { edges: [], parentEdges }),
      (err) => err.code === "RELATION_CYCLE",
    );
    // No `parentEdges` at all still gets the cycle rule rather than a crash — a
    // caller that has no chain to offer is not a caller with a broken context.
    assert.doesNotThrow(() => assertBlockEdgeAllowed({ source: "a", target: "b" }, { edges: [] }));
  });

  it("refuses it in the database too: parent depends_on child, and child depends_on parent", async () => {
    await withBoard(({ db }) => {
      seedChain(db);

      // N10c — the epic depends on its own child.
      assert.equal(reasonCode(insertEdge(db, "blocks", "e", "d")), "RELATION_CYCLE");
      // N10b — the child depends on its own parent.
      assert.equal(reasonCode(insertEdge(db, "blocks", "d", "e")), "RELATION_CYCLE");
      // Two generations, both ways: the walk is the chain, not the immediate parent.
      assert.equal(reasonCode(insertEdge(db, "blocks", "g", "e")), "RELATION_CYCLE");
      assert.equal(reasonCode(insertEdge(db, "blocks", "e", "g")), "RELATION_CYCLE");

      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM task_relations WHERE relation_type = 'blocks'").get().n,
        0,
        "a refused edge must leave no row behind",
      );
    });
  });

  it("does not touch siblings, or cards with no chain between them", async () => {
    await withBoard(({ db }) => {
      seedChain(db);

      // The non-regression that matters: a card and its sibling are ordered all
      // the time, and a guard that also refused these would be a different,
      // wrong guard.
      assert.equal(reasonCode(insertEdge(db, "blocks", "s1", "s2")), "NO_ERROR");
      assert.equal(reasonCode(insertEdge(db, "blocks", "s2", "s1")), "RELATION_CYCLE", "that pair is now a loop");
      assert.equal(reasonCode(insertEdge(db, "blocks", "u", "s1")), "NO_ERROR");
      assert.equal(reasonCode(insertEdge(db, "blocks", "g", "u")), "NO_ERROR", "a descendant may depend on a stranger");
    });
  });

  it("leaves SELF_REFERENCE and CROSS_PROJECT_RELATION owning their own rows", async () => {
    await withBoard(({ db }) => {
      seedChain(db);
      // The determinism rule (0002): `source = target` and the cross-project row
      // each report one code, and it is not this guard's — the clauses that keep
      // this trigger off those rows are what make a reason code reproducible.
      assert.equal(reasonCode(insertEdge(db, "blocks", "e", "e")), "SELF_REFERENCE");
      assert.equal(reasonCode(insertEdge(db, "blocks", "z", "e")), "CROSS_PROJECT_RELATION");
    });
  });

  it("reports one code for a row that is both a loop and an ancestor join", async () => {
    await withBoard(({ db }) => {
      seedChain(db);
      // `tr_rel_block_cycle` and `tr_rel_block_chain` are the one pair on this
      // event that can both apply to one row, and SQLite does not promise which
      // fires first. They raise the *same* code, so the row reports one answer
      // whichever wins — which is all the determinism rule asks for. The row
      // below is genuinely both: `e → d` is a parent chain, and `e → u → d`
      // makes `d → e` close a loop.
      assert.equal(reasonCode(insertEdge(db, "blocks", "e", "u")), "NO_ERROR");
      assert.equal(reasonCode(insertEdge(db, "blocks", "u", "d")), "NO_ERROR");
      assert.equal(reasonCode(insertEdge(db, "blocks", "d", "e")), "RELATION_CYCLE");
    });
  });

  it("reaches the caller through the use-case, over the same code and status", async () => {
    const board = await createTempBoard();
    try {
      seedChain(board.db);
      const ctx = () =>
        createContext({ db: board.db, repos: createRepositories(board.db), clock: () => TS });
      const actor = { kind: "agent", id: "linus" };

      for (const [source, target] of [["d", "e"], ["e", "d"], ["g", "e"]]) {
        assert.throws(
          () => addRelation(ctx(), { type: "blocks", source, target, actor }),
          (err) => {
            assert.equal(err.code, "RELATION_CYCLE", `${source} → ${target}`);
            assert.equal(err.http, 422, `${source} → ${target}`);
            assert.match(err.message, /parent chain/, err.message);
            return true;
          },
        );
      }

      // …and the sibling edge the same path must still accept.
      const accepted = addRelation(ctx(), { type: "blocks", source: "s1", target: "s2", actor });
      assert.equal(accepted.type, "blocks");
      assert.equal(accepted.source, "s1");
      assert.equal(accepted.target, "s2");
    } finally {
      board.close();
    }
  });
});

/**
 * T-20261015-075826 — the ancestor/descendant rule is asked at **both** insert
 * points, so the verdict stops depending on arrival order.
 *
 * `0019` refused the `blocks` edge joining an ancestor and a descendant, but
 * only at the `blocks` insert. With the `blocks` edge already down, the *parent*
 * edge that puts the two cards on one chain went in unchallenged, because
 * `tr_rel_parent_guard` (0002) never reads the `blocks` graph. That is the order
 * `storage/md/import.mjs` writes — `depends_on` (→ `blocks`) before `parent`,
 * for every card — so it is the order a real import uses, not a theoretical one.
 *
 *   order 1  parent P → C, then the `blocks` edge   → refused by `0019`  (unchanged)
 *   order 2  the `blocks` edge, then parent P → C   → refused by `0020`  (this card)
 *
 * Both orders report the **same code** (`RELATION_CYCLE`), which is what
 * "order-independent" has to mean: not merely that both refuse, but that the
 * caller cannot tell which edge happened to land second.
 *
 * Three readings are asserted, and they are the three ways this guard could be
 * wrong:
 *
 *   * the **closure** — the offending `blocks` edge need not touch either end of
 *     the new parent edge (`seedStrandedPair` strands `x depends_on y` with a
 *     `p → c` two generations away), so a test of the direct pair `(P, C)` is
 *     not this guard;
 *   * the **precedence** — a row that is both a chain overflow and an
 *     ancestor/descendant join has one code and it is the cap's. SQLite would
 *     otherwise pick by firing order; `0020`'s trigger is `AFTER INSERT` so the
 *     `BEFORE` caps always speak first;
 *   * the **non-regression** — siblings, strangers, and the two codes that own
 *     their own rows (`SELF_REFERENCE`, `CROSS_PROJECT_RELATION`).
 */
describe("contract/invariants — the ancestor/descendant rule is order-independent", () => {
  /** `a` is an epic so it can parent; `task` is not. */
  const epic = (db, id) => insertTask(db, { id, identifier: `PROJ-${id.toUpperCase()}`, kind: "epic" });
  const plain = (db, id) => insertTask(db, { id, identifier: `PROJ-${id.toUpperCase()}` });

  /**
   * `x → p` and `c → y`, with `x blocks y` already down. Adding `p → c` puts
   * `x` above `y`, so the pre-existing `blocks` edge becomes an
   * ancestor/descendant join — two generations from either end of the new edge,
   * which is exactly what a direct-pair check misses.
   */
  function seedStrandedPair(db) {
    insertProject(db);
    epic(db, "x");
    epic(db, "p");
    epic(db, "c");
    plain(db, "y");
    addParentEdge(db, "x", "p");
    addParentEdge(db, "c", "y");
    db.prepare(
      "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('blocks', ?, ?, ?)",
    ).run("x", "y", TS);
  }

  /** `a` (epic) and `b`, with `b blocks a` down — the order-2 arrival. */
  function seedBlockFirst(db, a = "a", b = "b") {
    insertProject(db);
    epic(db, a);
    plain(db, b);
    db.prepare(
      "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('blocks', ?, ?, ?)",
    ).run(b, a, TS);
  }

  /** `addParentEdge` as a thunk — `reasonCode` takes a function, not a call. */
  const tryAddParent = (db, source, target) => () => addParentEdge(db, source, target);

  // `node:sqlite` hands back null-prototype rows; `deepEqual` wants plain ones.
  const edgesOf = (db, type) =>
    db
      .prepare("SELECT source_task_id AS source, target_task_id AS target FROM task_relations WHERE relation_type = ?")
      .all(type)
      .map((row) => ({ source: String(row.source), target: String(row.target) }));
  const parentEdgesOf = (db) => edgesOf(db, "parent");
  const blockEdgesOf = (db) => edgesOf(db, "blocks");

  it("reads the closure, not just the pair, and leaves siblings and strangers alone", () => {
    const parentEdges = [
      { source: "x", target: "p" },
      { source: "c", target: "y" },
    ];
    const blockEdges = [{ source: "x", target: "y" }];
    // The stranded pair: neither end of the prospective `p → c` is on the edge.
    assert.deepEqual(blockedPairOnChain(parentEdges, blockEdges, "p", "c"), { source: "x", target: "y" });
    // The other direction of the same pair is the same defect.
    assert.deepEqual(blockedPairOnChain(parentEdges, [{ source: "y", target: "x" }], "p", "c"), { source: "y", target: "x" });
    // The direct pair, for contrast: `blocks` between `p` and `c` is caught by
    // the same walk that catches the stranded one.
    assert.deepEqual(blockedPairOnChain(parentEdges, [{ source: "c", target: "p" }], "p", "c"), { source: "c", target: "p" });
    // A `blocks` edge wholly inside one closure is *not* this rule's business:
    // `x` and `p` are already on one chain, and `0019`/`0020` would each have
    // refused it when it landed. Neither closure reaches the other's side.
    assert.equal(blockedPairOnChain(parentEdges, [{ source: "x", target: "p" }], "p", "c"), null);
    assert.equal(blockedPairOnChain(parentEdges, [{ source: "c", target: "y" }], "p", "c"), null);
    // Off the chain entirely — a stranger, and an empty board.
    assert.equal(blockedPairOnChain(parentEdges, [{ source: "u", target: "u2" }], "p", "c"), null);
    assert.equal(blockedPairOnChain([], [], "a", "b"), null);
  });

  it("refuses the parent edge when the blocks edge landed first — both paths, one code", async () => {
    const board = await createTempBoard();
    try {
      seedBlockFirst(board.db);
      const ctx = () => createContext({ db: board.db, repos: createRepositories(board.db), clock: () => TS });
      const actor = { kind: "agent", id: "linus" };

      // Order 2 — the order the repro (`repro-order-gap.mjs`) and `md` import use.
      assert.throws(
        () => addRelation(ctx(), { type: "parent", source: "PROJ-A", target: "PROJ-B", actor }),
        (err) => {
          assert.equal(err.code, "RELATION_CYCLE", "the same code order 1 reports");
          assert.equal(err.http, 422);
          assert.equal(err.details.type, "parent");
          assert.equal(err.details.chain, "ancestor", "distinguishable from a parent cycle");
          assert.match(err.message, /ancestor and a descendant cannot depend on each other/, err.message);
          return true;
        },
      );
      // …and the database refuses it too, on its own.
      assert.equal(reasonCode(tryAddParent(board.db, "a", "b")), "RELATION_CYCLE");
      assert.deepEqual(
        parentEdgesOf(board.db),
        [],
        "the AFTER-INSERT abort backs the row out — a refused edge leaves nothing behind",
      );
      assert.equal(blockEdgesOf(board.db).length, 1, "the edge that landed first is untouched");
    } finally {
      board.close();
    }
  });

  it("refuses it when the blocks edge is stranded two generations away", async () => {
    const board = await createTempBoard();
    try {
      seedStrandedPair(board.db);
      assert.equal(
        reasonCode(tryAddParent(board.db, "p", "c")),
        "RELATION_CYCLE",
        "the closure — a direct-pair test would have admitted this row",
      );
      assert.deepEqual(parentEdgesOf(board.db).map((e) => `${e.source}->${e.target}`).sort(), ["c->y", "x->p"]);
      assert.deepEqual(blockEdgesOf(board.db), [{ source: "x", target: "y" }]);
    } finally {
      board.close();
    }
  });

  it("reaches the closure through the use-case, over the same code and status", async () => {
    const board = await createTempBoard();
    try {
      seedStrandedPair(board.db);
      const ctx = createContext({ db: board.db, repos: createRepositories(board.db), clock: () => TS });
      assert.throws(
        () => addRelation(ctx, { type: "parent", source: "PROJ-P", target: "PROJ-C", actor: { kind: "agent", id: "linus" } }),
        (err) => {
          assert.equal(err.code, "RELATION_CYCLE");
          assert.equal(err.http, 422);
          assert.deepEqual(err.details.blocks, { source: "x", target: "y" }, "the message names the offending edge");
          return true;
        },
      );
    } finally {
      board.close();
    }
  });

  it("reports the cap's code, not this one, when a row is both", async () => {
    // `r1 → … → r8` is the deepest chain the shape rules allow (8 nodes); `c
    // blocks r1` is legal while it lands, because `c` is on no chain yet.
    const seed = (db, depth) => {
      insertProject(db);
      for (let i = 1; i <= depth; i += 1) epic(db, `r${i}`);
      plain(db, "c");
      for (let i = 1; i < depth; i += 1) addParentEdge(db, `r${i}`, `r${i + 1}`);
      db.prepare(
        "INSERT INTO task_relations(relation_type, source_task_id, target_task_id, created_at) VALUES ('blocks', ?, ?, ?)",
      ).run("c", "r1", TS);
    };

    await withBoard(({ db }) => {
      seed(db, 2);
      // A short chain: the join is the only defect, so this guard owns the row.
      assert.equal(reasonCode(tryAddParent(db, "r2", "c")), "RELATION_CYCLE");
    });

    await withBoard(({ db }) => {
      seed(db, 8);
      // The same join, on a chain that `tr_rel_parent_guard` also refuses as
      // CHAIN_TOO_LONG. `0020` runs AFTER INSERT, so the cap's code is the one
      // the caller reads — one row, one code, whatever order SQLite fires the
      // triggers in.
      assert.equal(reasonCode(tryAddParent(db, "r8", "c")), "CHAIN_TOO_LONG");
      assert.deepEqual(parentEdgesOf(db).length, 7, "the refused edge left nothing behind");
    });
  });

  it("does not touch siblings, strangers, or the codes that own their own rows", async () => {
    await withBoard(({ db }) => {
      seedStrandedPair(db);
      insertProject(db, { id: "other", name: "Other" });
      insertTask(db, { id: "z", identifier: "OTHER-Z", project_id: "other" });
      plain(db, "y2");

      // A sibling of `y` under the same epic: on no shared chain with the
      // stranded pair, so the edge the guard must keep admitting is admitted.
      assert.equal(reasonCode(tryAddParent(db, "c", "y2")), "NO_ERROR", "siblings are orderable");
      // The clauses that keep this trigger off the rows two other codes own —
      // the same three clauses `tr_rel_parent_guard` carries.
      assert.equal(reasonCode(tryAddParent(db, "c", "c")), "SELF_REFERENCE");
      assert.equal(reasonCode(tryAddParent(db, "z", "y")), "CROSS_PROJECT_RELATION");
    });
  });
});
