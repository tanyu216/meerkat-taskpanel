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
 *   I3 terminal states are terminal    → done/canceled never move
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
import {
  TS,
  TS2,
  cleanupTempDirs,
  countRows,
  createTempBoard,
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
    insertTask(db, { id, identifier: `PROJ-${id.toUpperCase()}`, status: "todo" });
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

describe("contract/invariants — I1/I2 claim atomicity", () => {
  it("eight connections race for one task and exactly one wins", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t", identifier: "PROJ-0001", status: "todo" });
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
  it("never leaves done/canceled, by direct SQL", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "done", identifier: "PROJ-DONE", status: "done" });
      insertTask(db, { id: "canceled", identifier: "PROJ-CANCEL", status: "canceled" });
      for (const id of ["done", "canceled"]) {
        const other = id === "done" ? "canceled" : "done";
        assert.equal(
          reasonCode(() => db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(other, id)),
          "TERMINAL_STATE",
        );
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
        insertTask(db, { id, identifier: `PROJ-${id.toUpperCase()}` });
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
      assert.equal(
        reasonCode(() => db.prepare("UPDATE tasks SET claimed_by = 'linus' WHERE id = 't'").run()),
        "VALIDATION_FAILED",
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

  it("is a hard gate: no waiver column, no waiver path (F4)", async () => {
    await withBoard(({ db }) => {
      insertProject(db);
      insertTask(db, { id: "t", identifier: "PROJ-0001", status: "in_progress" });
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('tasks')")
        .all()
        .map((r) => r.name);
      assert.equal(
        columns.some((c) => /waiv|no_report|reason/i.test(c)),
        false,
        `a waiver column appeared: ${columns.join(",")}`,
      );
      const ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='tr_deliver_gate'")
        .get().sql;
      assert.equal(/waiv/i.test(ddl), false, "the gate must not have a waiver branch");
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
      const writes = [
        () => db.prepare("INSERT INTO assignees(id,kind,display_name,normalized_name,first_seen_at,last_seen_at) VALUES('as','agent','A','a',?,?)").run(TS, TS),
        () => db.prepare("INSERT INTO reporters(id,kind,display_name,normalized_name,first_seen_at,last_seen_at) VALUES('rp','human','R','r',?,?)").run(TS, TS),
        () => db.prepare("INSERT INTO task_relations(relation_type,source_task_id,target_task_id,created_at) VALUES('blocks','t','t2',?)").run(TS),
        () => db.prepare("INSERT INTO comments(id,task_id,body,kind,author_kind,author_id,created_at) VALUES('c','t','b','note','agent','a',?)").run(TS),
        () => db.prepare("INSERT INTO task_activities(task_id,event,changes_json,created_at) VALUES('t','x','{}',?)").run(TS),
        () => db.prepare("INSERT INTO attachments(id,task_id,filename,kind,created_at) VALUES('at','t','f','attachment',?)").run(TS),
        () => db.prepare("INSERT INTO agent_sessions(id,task_id,seg,owner,backend,session_id,status,ts) VALUES('s','t','seg1','linus','claude','sid','running',?)").run(TS),
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
});
