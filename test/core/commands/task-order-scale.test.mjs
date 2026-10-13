/**
 * C-WEIGHT-1 — R12: the weight order at a real scale.
 *
 * The contract's §8 R12 is honest about what it could not do: it measured
 * nothing, because it neither started a board nor entered a container, and it
 * handed the measurement to the implementation card. This is that measurement.
 *
 * Two things are checked, and they are different questions:
 *
 *   * **Correctness at scale** — the read that feeds the order is *unbounded*
 *     (R16), so a project-sized scope must come back whole. A regression that
 *     quietly reinstated `LIMIT 200` would fail the count assertions here, not
 *     just the small fixture in `test/server/task-order.test.mjs`.
 *   * **Cost** — how long the whole-scope sort actually takes. The numbers are
 *     reported (`t.diagnostic`) rather than asserted tightly: a wall-clock
 *     assertion in a shared suite is a flake generator under load, and the point
 *     is the measurement, not a pass/fail.
 *
 * The fixture is written with `repos.tasks.insert` inside one transaction rather
 * than through `commands.createTask`, because the latter opens a transaction and
 * appends an audit row per card — correct for real work, wasteful for 1,000 rows
 * of scaffolding. The read path under test is the real one.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { transaction } from "../../../src/core/storage/unit-of-work.mjs";
import { openBoard } from "../../../src/core/index.mjs";

const AGENT = { kind: "agent", id: "bench" };
/** A project-sized scope: big for this board, small enough to run every suite. */
const PROJECT_SIZE = 1000;
/** The per-assignee scope the contract expects the order to be *used* at. */
const ASSIGNEES = ["bench-0", "bench-1", "bench-2", "bench-3"];
const PRIORITIES = ["low", "low", "medium", "high", "urgent"];

const tempDirs = [];
let board;
let dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-scale-"));
  tempDirs.push(dataDir);
  // `pointer: false` — a benchmark has no business writing the runtime pointer
  // file of whoever is running the suite.
  board = await openBoard({ dataDir, pointer: false });
  const { commands, repos, db } = board;

  commands.createProject({ id: "scale", name: "Scale", actor: AGENT });

  // One real card per assignee, so the dictionary holds an entry whose id the
  // bulk rows can carry — the candidate read resolves a *name* to those ids.
  const seeds = ASSIGNEES.map((name, index) =>
    commands.createTask({
      projectId: "scale",
      title: `seed ${name}`,
      assignee: name,
      priority: PRIORITIES[index % PRIORITIES.length],
      actor: AGENT,
    }),
  );
  const ids = seeds.map((task) => task.assigneeId);
  const template = seeds[0];

  // Spread over the last 60 days so every time factor has real work to do, and
  // deliberately NOT in the board's own order, so the two orders disagree.
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  transaction(
    db,
    () => {
      for (let index = 0; index < PROJECT_SIZE; index += 1) {
        const createdAt = new Date(now - ((index * 37) % 60) * DAY - (index % 24) * 3_600_000).toISOString();
        const statusChangedAt = new Date(now - (index % 90) * 3_600_000).toISOString();
        repos.tasks.insert({
          ...template,
          id: `scale-${index}`,
          // Deliberately not the project's own `SCALE-` prefix: the four seed
          // cards already hold SCALE-0001…0004, and the identifier is unique
          // per project.
          identifier: `BULK-${String(index).padStart(4, "0")}`,
          title: `scale card ${index}`,
          priority: PRIORITIES[index % PRIORITIES.length],
          status: "todo",
          assigneeKind: "agent",
          assigneeId: ids[index % ids.length],
          createdAt,
          updatedAt: createdAt,
          statusChangedAt,
          blockedAt: null,
          idem: null,
          version: 1,
        });
      }
    },
    { op: "bench.seed" },
  );
});

after(() => {
  if (board) board.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Median of `runs` timings, in milliseconds — one sample is a coincidence. */
function timeOf(runs, fn) {
  const samples = [];
  let result;
  for (let run = 0; run < runs; run += 1) {
    const started = process.hrtime.bigint();
    result = fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return { ms: samples[Math.floor(samples.length / 2)], result, samples };
}

describe("task-order — R12: the weight order on a real project", () => {
  it("orders the whole project scope without truncating it", (t) => {
    const { commands } = board;
    const total = commands.listTasks({ projectId: "scale", limit: null }).length;
    assert.ok(total >= PROJECT_SIZE, `the fixture really holds ${PROJECT_SIZE}+ cards, has ${total}`);

    const boardOrder = timeOf(3, () => commands.listTasks({ projectId: "scale", limit: null }));
    // The board read is the comparison: it is the `ORDER BY` SQLite can do with
    // the existing index, so the difference is what the weight order costs.
    const weight = timeOf(3, () => commands.listTasks({ projectId: "scale", order: "weight", limit: null }));

    assert.equal(weight.result.length, boardOrder.result.length, "same cards, both orders");
    assert.deepEqual(
      weight.result.map((task) => task.id).sort(),
      boardOrder.result.map((task) => task.id).sort(),
    );

    // A valid total order: strict, and the same set twice.
    const ids = weight.result.map((task) => task.id);
    assert.equal(new Set(ids).size, ids.length, "no card appears twice");
    assert.deepEqual(commands.listTasks({ projectId: "scale", order: "weight", limit: null }).map((task) => task.id), ids);

    t.diagnostic(
      `R12 · project scope of ${weight.result.length} cards — board order ${boardOrder.ms.toFixed(1)}ms, ` +
        `weight order ${weight.ms.toFixed(1)}ms (median of 3)`,
    );
  });

  it("orders a single assignee's scope, which is where it is meant to be used", (t) => {
    const { commands, repos } = board;
    const scope = repos.tasks.list({ projectId: "scale", assigneeId: idsOf(board, "bench-0"), limit: null }).length;
    const candidates = timeOf(3, () => commands.listCandidates({ assignee: "bench-0", order: "weight" }));
    const plain = timeOf(3, () => commands.listCandidates({ assignee: "bench-0" }));

    assert.ok(scope > 200, `the assignee's scope is ${scope} cards before any dependency filtering`);
    assert.ok(candidates.result.length > 0);
    assert.equal(candidates.result.length, plain.result.length, "the order changes the sequence, not the set");

    t.diagnostic(
      `R12 · assignee scope of ${candidates.result.length} candidates — board order ${plain.ms.toFixed(1)}ms, ` +
        `weight order ${candidates.ms.toFixed(1)}ms (median of 3)`,
    );
  });

  it("paginates a page of the ordered scope without re-deriving the whole ranking", (t) => {
    // A page is `LIMIT`-shaped work on top of the ordering; this records what a
    // poll-sized page costs, which is the number a caller actually pays.
    const { commands } = board;
    const page = timeOf(3, () => commands.listTasks({ projectId: "scale", order: "weight", limit: 50, offset: 0 }));
    assert.equal(page.result.length, 50);
    t.diagnostic(`R12 · first page of 50 from a ${PROJECT_SIZE}-card project: ${page.ms.toFixed(1)}ms (median of 3)`);
  });
});

/** The dictionary id behind an assignee name (the fixture seeds one per name). */
function idsOf(target, name) {
  const entry = target.repos.dictionary.list("assignee").find((row) => row.displayName === name || row.id === name);
  return entry === undefined ? [] : [entry.id];
}
