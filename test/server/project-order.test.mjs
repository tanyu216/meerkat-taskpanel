/**
 * M6a — the §4.6 project ranking, as pure maths and as an HTTP response.
 *
 * Two layers, tested separately for a reason: the *algorithm* (rank
 * normalization, weights, tie-breaks) is arithmetic and belongs in unit cases
 * with hand-written numbers; the *aggregation* (which activities count, in which
 * window) is SQL and belongs in a case that drives the real route against a real
 * SQLite board.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { PROJECT_ORDER_WEIGHTS } from "../../src/shared/constants.mjs";
import { normalise, orderDebugEntry, rankProjects } from "../../src/shared/project-order.mjs";
import { createTaskd } from "../../src/server/index.mjs";

const AGENT = { kind: "agent", id: "linus" };
const tempDirs = [];
let taskd;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-order-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;

  const { commands, db } = taskd.board;
  const create = (id, name) => commands.createProject({ id, name, workspacePath: `/tmp/${id}`, actor: AGENT });
  create("busy", "Busy");
  create("quiet", "Quiet");
  create("old", "Old");

  // 3 recent activities in `busy`, 1 in `quiet`, 5 but all outside both windows
  // in `old` (which is the case the window bound exists for).
  for (let i = 1; i <= 3; i += 1) createTask(commands, { projectId: "busy", title: `b${i}` });
  createTask(commands, { projectId: "quiet", title: "q1" });
  for (let i = 1; i <= 5; i += 1) createTask(commands, { projectId: "old", title: `o${i}` });

  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE task_activities SET created_at = ? WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 'old')",
  ).run(longAgo);
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function createTask(commands, input) {
  return commands.createTask({ ...input, actor: AGENT });
}

describe("project-order — the pure ranking", () => {
  it("normalises by rank, not by magnitude", () => {
    // 900 events must not dwarf 3: both are "best" and "worst" respectively.
    assert.deepEqual(normalise([900, 3], (a, b) => b - a).scores, [1, 0.5]);
    assert.deepEqual(normalise([], (a, b) => b - a), { scores: [], ranks: [] });
    assert.deepEqual(normalise([5], (a, b) => b - a).scores, [1]);
    // Ties share the best rank.
    assert.deepEqual(normalise([7, 7, 2], (a, b) => b - a).scores, [1, 1, 1 / 3]);
  });

  it("combines the three factors with the published weights", () => {
    assert.deepEqual(PROJECT_ORDER_WEIGHTS, { a7: 0.5, a30: 0.3, created: 0.2 });
    const ranked = rankProjects([
      { id: "a", name: "A", a7: 10, a30: 10, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", name: "B", a7: 0, a30: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    assert.deepEqual(ranked.map((item) => item.entry.id), ["a", "b"]);
    assert.ok(Math.abs(ranked[0].total - 1) < 1e-9, "best on every factor");
    // Worst on A7/A30 (0.5·0.5 + 0.3·0.5 = 0.4) plus a tied created score (0.2).
    assert.ok(Math.abs(ranked[1].total - 0.6) < 1e-9, `got ${ranked[1].total}`);
  });

  it("breaks a total tie by last activity, then by name", () => {
    const ranked = rankProjects([
      { id: "z", name: "Zeta", a7: 1, a30: 1, createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-02-01T00:00:00.000Z" },
      { id: "a", name: "Alpha", a7: 1, a30: 1, createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-02-01T00:00:00.000Z" },
      { id: "n", name: "Newer", a7: 1, a30: 1, createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-03-01T00:00:00.000Z" },
    ]);
    assert.deepEqual(ranked.map((item) => item.entry.id), ["n", "a", "z"]);
    assert.deepEqual(ranked.map((item) => item.order), [1, 2, 3]);
  });

  it("fixes archived projects to the bottom and survives an empty list", () => {
    const ranked = rankProjects([
      { id: "gone", name: "Gone", a7: 99, a30: 99, createdAt: "2026-09-01T00:00:00.000Z", archivedAt: "2026-09-02T00:00:00.000Z" },
      { id: "live", name: "Live", a7: 0, a30: 0, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    assert.deepEqual(ranked.map((item) => item.entry.id), ["live", "gone"]);
    assert.deepEqual(rankProjects([]), []);
  });

  it("projects a debug view with the raw factors, ranks and scores", () => {
    const [item] = rankProjects([{ id: "a", name: "A", a7: 4, a30: 9, createdAt: "2026-01-01T00:00:00.000Z" }]);
    const debug = orderDebugEntry(item);
    assert.equal(debug.id, "a");
    assert.equal(debug.factors.a7.raw, 4);
    assert.equal(debug.factors.a7.rank, 1);
    assert.equal(debug.factors.a7.score, 1);
    assert.equal(debug.total, 1);
    assert.equal(debug.factors.created.raw, "2026-01-01T00:00:00.000Z");
  });
});

describe("project-order — over HTTP against a real board", () => {
  it("orders by activity, keeps the old project last, and ships no debug by default", async () => {
    const body = (await (await fetch(`${base}/api/v1/projects`)).json()).data;
    assert.deepEqual(body.projects.map((project) => project.id), ["busy", "quiet", "old"]);
    assert.equal(body.order_debug, undefined, "the debug detail is opt-in");
  });

  it("returns the three factors on ?order_debug=1", async () => {
    const body = (await (await fetch(`${base}/api/v1/projects?order_debug=1`)).json()).data;
    assert.deepEqual(body.projects.map((project) => project.id), ["busy", "quiet", "old"]);

    const debug = Object.fromEntries(body.order_debug.map((entry) => [entry.id, entry]));
    assert.equal(debug.busy.factors.a7.raw, 3);
    assert.equal(debug.busy.factors.a30.raw, 3);
    assert.equal(debug.quiet.factors.a7.raw, 1);
    assert.equal(debug.old.factors.a7.raw, 0, "activity 40 days old is outside both windows");
    assert.equal(debug.old.factors.a30.raw, 0);
    assert.equal(debug.busy.factors.a7.score, 1);
    assert.equal(debug.old.total < debug.quiet.total, true);
    assert.equal(typeof debug.busy.last_activity_at, "string");
  });

  it("folds a heartbeat into no activity at all", async () => {
    const { commands, db } = taskd.board;
    const raw = async () => {
      const body = (await (await fetch(`${base}/api/v1/projects?order_debug=1`)).json()).data;
      return body.order_debug.find((entry) => entry.id === "quiet").factors.a7.raw;
    };

    const before = await raw();
    const task = createTask(commands, { projectId: "quiet", title: "pulse" });
    commands.claim({ id: task.id, actor: AGENT });
    assert.equal(await raw(), before + 2, "the create and the claim both count");

    commands.heartbeat({ id: task.id, actor: AGENT });
    assert.equal(await raw(), before + 2, "a heartbeat must not make a board look busy");

    // The row is stored — it is excluded from *activity*, not from the audit trail.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM task_activities WHERE event = 'task_heartbeat'").get();
    assert.equal(Number(rows.n), 1);
  });
});
