/**
 * `readBoard` — the one board read behind the deterministic passes.
 *
 * It is a small contract on purpose: one `issue list` for the whole board, a
 * `truncated` flag so a caller never mistakes a capped read for a complete one,
 * and the failure message on the result rather than only in the caller's log.
 * The console and the doctor build on it, so the shape is asserted here.
 *
 * The board is a sentinel CLI: no database, and every assertion is about the
 * call the loop makes and what it hands back.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  boardRefusal,
  readBoard,
  readHandoffTriage,
  readUnownedTodos,
} from "../../src/orchestrator/board.mjs";
import { taskToWire } from "../../src/foundation/wire.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-board-read-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const noopLog = () => {};

/**
 * A stand-in `taskctl` that records what it was called with and answers the
 * read with `tasks` (or with a failure envelope).
 */
function sentinel(dir, { tasks = [], fail = false } = {}) {
  const record = join(dir, "record.json");
  const script = join(dir, "sentinel-cli.mjs");
  const answer = fail
    ? 'process.stdout.write(JSON.stringify({ ok: false, error: { message: "board down" } }));'
    : `process.stdout.write(JSON.stringify({ ok: true, data: { tasks: ${JSON.stringify(tasks)} } }));`;
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  noAutostart: process.env.TASKD_NO_AUTOSTART ?? null,",
      "  token: process.env.TASKD_TOKEN ?? null,",
      "}));",
      answer,
    ].join("\n"),
  );
  return { script, record };
}

function optsFor(script, overrides = {}) {
  return {
    cli: script,
    actorKind: "claude",
    agents: ["alice"],
    boardLimit: 50,
    envFile: null,
    url: null,
    token: null,
    ...overrides,
  };
}

describe("loop/readBoard — one read, and the shape callers rely on", () => {
  it("returns the tasks and reads the whole board in one call", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir, {
      tasks: [
        { identifier: "T-1", status: "in_progress" },
        { identifier: "T-2", status: "in_review" },
      ],
    });

    const result = readBoard(optsFor(script), noopLog);

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.data.tasks.map((task) => task.identifier),
      ["T-1", "T-2"],
    );
    assert.equal(result.truncated, false);
    const calls = JSON.parse(readFileSync(record, "utf8")).argv;
    assert.deepEqual(
      calls.slice(calls.indexOf("issue")),
      ["issue", "list", "--limit", "50"],
      "one read, no status filter: the caller filters the same snapshot",
    );
  });

  it("marks a read that filled the limit as truncated", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-1", status: "todo" },
        { identifier: "T-2", status: "todo" },
      ],
    });

    const result = readBoard(optsFor(script, { boardLimit: 2 }), noopLog);

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true, "a full page may have cut cards off");
  });

  it("carries the failure message on the result, not only into the log", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, { fail: true });

    const result = readBoard(optsFor(script), noopLog);

    assert.equal(result.ok, false);
    assert.equal(result.error, "board down");
  });

  it("lets the caller forbid autostart, without the token losing to it", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir, { tasks: [] });

    readBoard(
      optsFor(script, {
        token: "td_from_opts",
        cliEnv: { TASKD_NO_AUTOSTART: "1", TASKD_TOKEN: "from_cli_env" },
      }),
      noopLog,
    );

    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(seen.noAutostart, "1", "the child must not be allowed to start a board");
    assert.equal(seen.token, "td_from_opts", "the real token still wins over the injected env");
  });
});

describe("boardRefusal — the code survives the seam", () => {
  it("keeps the board's code, details and hint beside the readable message", () => {
    assert.deepEqual(
      boardRefusal({
        ok: false,
        error: "PROJ-0001: 1 blocking",
        code: "ACCEPTANCE_INCOMPLETE",
        details: { blocking: [{ text: "b", status: "partial" }] },
        hint: { fix: "REJECT instead" },
      }),
      {
        ok: false,
        error: "PROJ-0001: 1 blocking",
        code: "ACCEPTANCE_INCOMPLETE",
        details: { blocking: [{ text: "b", status: "partial" }] },
        hint: { fix: "REJECT instead" },
      },
      "the executor classifies on `code`; a message alone is not enough",
    );
  });

  it("passes a success through untouched, and adds nothing to a bare failure", () => {
    assert.deepEqual(boardRefusal({ ok: true }), { ok: true });
    assert.deepEqual(boardRefusal({ ok: false, error: "exit 1" }), { ok: false, error: "exit 1" });
  });
});

describe("director lanes — read the wire projection the board actually sends", () => {
  it("reads `project_id`, not the absent `project`, on an unowned todo", () => {
    const dir = tempDir();
    // The wire projection is `taskToWire`'s: `project_id`, never `project`.
    // The question/route lanes used to read `task.project` and silently skip
    // every real row; this pins the real shape.
    const wire = taskToWire({
      id: "uuid-1",
      identifier: "T-1",
      projectId: "P",
      title: "unowned",
      status: "todo",
      kind: "task",
      priority: "P2",
      assigneeId: null,
      assigneeKind: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      statusChangedAt: "2020-01-01T00:00:00Z",
      deliveryRound: 1,
      version: 1,
      meta: {},
    });
    assert.equal(wire.project_id, "P");
    assert.equal("project" in wire, false, "the wire row has no `project` field");

    const { script } = sentinel(dir, { tasks: [wire] });
    const result = readUnownedTodos(
      optsFor(script),
      noopLog,
      undefined,
      () => Date.parse("2026-01-02T00:00:00Z"),
    );

    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1, "a real wire row is routed, not skipped");
    assert.equal(result.rows[0].project, "P");
  });

  it("reads the triage markers with the wire's numeric delivery round", () => {
    const dir = tempDir();
    const doneCard = (identifier, meta, extra = {}) => taskToWire({
      id: identifier,
      identifier,
      projectId: "P",
      title: identifier,
      status: "done",
      kind: "task",
      priority: "P2",
      assigneeId: "alice",
      assigneeKind: "agent",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      statusChangedAt: "2026-01-01T00:00:00Z",
      deliveryRound: 2,
      version: 1,
      meta,
      ...extra,
    });
    const tasks = [
      doneCard("T-1", { stage_handoff: "required" }),
      doneCard("T-2", { stage_handoff: "required", handoff_consumed_round: "2" }),
      doneCard("T-3", { stage_handoff: "required", handoff_declined_round: 2 }),
      doneCard("T-4", { stage_handoff: "required", handoff_consumed_round: "1" }),
      taskToWire({
        id: "T-5", identifier: "T-5", projectId: "P", title: "old", status: "done",
        kind: "task", priority: "P2", assigneeId: "alice", assigneeKind: "agent",
        createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
        statusChangedAt: "2020-01-01T00:00:00Z", deliveryRound: 1, version: 1,
        meta: { stage_handoff: "required" },
      }),
    ];
    const { script } = sentinel(dir, { tasks });
    const result = readHandoffTriage(
      optsFor(script),
      noopLog,
      undefined,
      () => Date.parse("2026-01-02T00:00:00Z"),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.rows.map((row) => row.ref), ["T-1", "T-4"]);
    assert.equal(result.rows[0].project_id, "P");
    assert.equal(result.rows[0].round, 2);
    assert.equal(result.truncated, false);
  });
});
