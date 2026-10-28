/**
 * C-WEIGHT-1 — the assignee weight order at the service boundary.
 *
 * The arithmetic is proved in `test/foundation/task-order.test.mjs`. What can only be
 * proved here is the four §10.2 assertions that need a real SQLite board and the
 * real routes:
 *
 *   7  the list read is always the weight order (there is no `order=` to opt
 *      out), while the repository's own board order still exists for the export;
 *   8  the md export still walks the board order, byte for byte;
 *   9  `blocked_at` is gated on `status == "blocked"` (R15);
 *   10 the scope is pushed into SQL, so the order is computed over the whole set
 *      rather than over a `LIMIT 200` page (R16).
 *
 * It also pins the surface the order hangs off: the capability bit, the two
 * query parameters, and the fact that a candidate's claimability bucket stays
 * the first key.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";

import { currentRevision } from "../../src/core/index.mjs";
import { exportMd } from "../../src/core/storage/md/export.mjs";
import { TASK_ORDER_CAPABILITY } from "../../src/foundation/constants.mjs";
import { createTaskd } from "../../src/server/index.mjs";

const AGENT = { kind: "agent", id: "linus" };
/** 90 days — long enough that a leaked `blocked_at` would max the SLA factor out. */
const LONG_AGO = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

const tempDirs = [];
let taskd;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-weight-"));
  tempDirs.push(dir);
  taskd = await createTaskd({ dataDir: dir, host: "127.0.0.1", port: 0, env: {} });
  base = taskd.url;
});

after(async () => {
  if (taskd) await taskd.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const board = () => taskd.board;
const commands = () => taskd.board.commands;
const repos = () => taskd.board.repos;
const db = () => taskd.board.db;

/**
 * Create one card, unconditionally.
 *
 * `allowDup: true` throughout on purpose: the creation guard derives an
 * idempotency key from `(kind, assignee, source, target)`, so a fixture that
 * makes several cards for the same assignee — which is the whole point of a
 * weight-order fixture — would otherwise receive the *same* card back every
 * time and quietly test nothing.
 */
const createTask = (input) => commands().createTask({ ...input, actor: AGENT, allowDup: true });
const createProject = (id, name) => commands().createProject({ id, name, actor: AGENT });

/** Call the API. Returns `{status, body}` — never throws on a non-2xx. */
async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

const dataOf = (result) => {
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.data;
};

/** `/tasks` in one of the two orders, as identifiers. */
async function listedOrder(query) {
  const { tasks } = dataOf(await call("GET", `/api/v1/tasks${query}`));
  return tasks.map((task) => task.identifier);
}

describe("task-order — the surface", () => {
  it("publishes the capability bit beside `project_order`", async () => {
    const meta = dataOf(await call("GET", "/meta"));
    assert.equal(meta.capabilities.task_order, TASK_ORDER_CAPABILITY);
    assert.equal(meta.capabilities.project_order, "weights-v1");
  });

});

describe("task-order — assertion 7: every list read is the weight order", () => {
  const boardOrder = ["ORD-0001", "ORD-0002", "ORD-0003", "ORD-0004", "ORD-0005"];

  before(() => {
    createProject("ord", "Order");
    // Five cards, oldest first, with the priority *inverted* against age: the
    // repository's own order is creation order, the weight order is urgency
    // first. Without that disagreement this suite could not tell the two apart.
    ["low", "low", "medium", "high", "urgent"].forEach((priority, index) => {
      // `todo`, not `in_progress`: a card cannot be *created* in progress
      // (delivery-gate.mjs#assertCreationGate), and this fixture needs neither a
      // claim nor a holder — only five same-tier cards with inverted priority.
      createTask({ projectId: "ord", title: `card ${index + 1}`, priority });
    });
  });

  it("returns the weight order, which is not the repository's own order", async () => {
    const listed = await listedOrder("?project_id=ord");
    assert.deepEqual([...listed].sort(), [...boardOrder].sort(), "same cards, different order");
    assert.notDeepEqual(listed, boardOrder);
    assert.equal(listed[0], "ORD-0005", "the urgent card leads the list");
    assert.deepEqual(
      repos().tasks.list({ projectId: "ord", limit: null }).map((task) => task.identifier),
      boardOrder,
      "…while the repository still walks its deterministic order (the export's)",
    );
  });

  it("ignores a stray `order=` — the weight order is not optional", async () => {
    // There is no `order` parameter; the query surface is declared, not
    // enforced, so a stray one is ignored rather than selecting another order.
    assert.deepEqual(await listedOrder("?project_id=ord&order=board"), await listedOrder("?project_id=ord"));
  });

  it("does not leak an `order_debug` key into a plain read", async () => {
    const data = dataOf(await call("GET", "/api/v1/tasks?project_id=ord"));
    assert.equal("order_debug" in data, false, "the diagnostic is opt-in");
  });

  it("projects `order_debug` when asked, and asking selects the weight order", async () => {
    const data = dataOf(await call("GET", "/api/v1/tasks?project_id=ord&order_debug=1"));
    assert.equal(data.order_debug.length, 5);
    assert.deepEqual(
      data.tasks.map((task) => task.identifier),
      data.order_debug.map((entry) => entry.identifier),
      "the projection reconciles with the page it came from",
    );
    assert.deepEqual(data.order_debug.map((entry) => entry.order), [1, 2, 3, 4, 5]);
    assert.equal(data.order_debug[0].tier_name, "T0");
    assert.deepEqual(Object.keys(data.order_debug[0].factors).sort(), ["A", "B", "L", "P", "S", "W"]);
    assert.deepEqual(Object.keys(data.order_debug[0].factors.P).sort(), ["normalised", "raw", "weighted"]);
  });

  it("keeps `limit`/`offset` semantics on the whole scoped set", async () => {
    // The page is cut *after* the ordering, so page 2 continues where page 1
    // stopped — the failure mode R16 names is a page ordered in isolation.
    const full = await listedOrder("?project_id=ord");
    const first = await listedOrder("?project_id=ord&limit=2");
    const second = await listedOrder("?project_id=ord&limit=2&offset=2");
    assert.deepEqual([...first, ...second], full.slice(0, 4), "two pages of two are the first four");
    assert.deepEqual(first, full.slice(0, 2));
    assert.deepEqual(second, full.slice(2, 4));
    assert.equal((await listedOrder("?project_id=ord&offset=4")).length, 1);
  });

  it("treats an explicit `limit: null` as the whole scoped set", () => {
    // The repository reads `limit: null` as "no LIMIT clause"; the JS pagination
    // that the weight order adds on top has to read it the same way, or the
    // default page size silently reappears over an unbounded read.
    assert.equal(commands().listTasks({ projectId: "ord", limit: null }).length, 5);
    assert.equal(commands().listTasks({ projectId: "ord" }).length, 5, "the default page is 200");
  });
});

describe("task-order — assertion 8: the export is untouched", () => {
  it("walks the board order and emits byte-stable cards", async () => {
    const project = "exp";
    createProject(project, "Export");
    ["low", "low", "urgent"].forEach((priority, index) =>
      createTask({ projectId: project, title: `export ${index + 1}`, priority }),
    );

    const outDir = join(tempDirs[0], "md");
    const run = () =>
      exportMd({ repos: repos(), projectId: project, outDir, now: new Date().toISOString(), dryRun: true });

    const first = run();
    const second = run();
    const emitted = first.files.map((file) => file.identifier);
    assert.deepEqual(emitted, ["EXP-0001", "EXP-0002", "EXP-0003"], "the export walks the repository's own order");
    assert.deepEqual(
      emitted,
      repos()
        .tasks.list({ projectId: project, limit: null })
        .map((task) => task.identifier),
      "…which is exactly the read the export performs",
    );
    assert.notDeepEqual(
      emitted,
      await listedOrder(`?project_id=${project}`),
      "…and the weight order is a different one, so the assertion has teeth",
    );
    assert.deepEqual(
      first.files.map((file) => file.content),
      second.files.map((file) => file.content),
      "the same board exports the same bytes twice",
    );
    // `test/contract/md-golden.test.mjs` is the version that notices a change in
    // the bytes themselves; this one proves the weight order never reaches it.
  });
});

describe("task-order — assertion 9: the `blocked_at` gate (R15)", () => {
  it("does not let a stale `blocked_at` score a card that is not blocked", async () => {
    createProject("r15", "R15");
    const ghost = createTask({ projectId: "r15", title: "blocked once, long ago", priority: "low" });

    // The real sequence: enter `blocked` (the column is stamped), leave it (the
    // column is *not* cleared — `moveCas` has no clearing branch), then backdate
    // the stamp the way three months of real life would.
    commands().moveStatus({ id: ghost.id, to: "blocked", actor: AGENT });
    commands().moveStatus({ id: ghost.id, to: "in_progress", actor: AGENT });
    db().prepare("UPDATE tasks SET blocked_at = ? WHERE id = ?").run(LONG_AGO, ghost.id);

    const moved = repos().tasks.get(ghost.id);
    assert.equal(moved.status, "in_progress");
    assert.equal(moved.blockedAt, LONG_AGO, "the stale stamp is really still on the row");

    const data = dataOf(await call("GET", "/api/v1/tasks?project_id=r15&order_debug=1"));
    const entry = data.order_debug.find((row) => row.id === ghost.id);
    // `in_progress` has no SLA threshold at all, so the honest answer is 0. A
    // leaked `blocked_at` would have produced 1.0 and floated the card to the top.
    assert.equal(entry.factors.S.normalised, 0);
    assert.equal(entry.factors.S.raw, 0);
    assert.equal(entry.score, 0);
  });

  it("still times a card that *is* blocked from `blocked_at`", async () => {
    createProject("r15b", "R15b");
    const blocked = createTask({ projectId: "r15b", title: "genuinely blocked", priority: "low" });
    commands().moveStatus({ id: blocked.id, to: "blocked", actor: AGENT });
    db().prepare("UPDATE tasks SET blocked_at = ? WHERE id = ?").run(LONG_AGO, blocked.id);

    const data = dataOf(await call("GET", "/api/v1/tasks?project_id=r15b&order_debug=1"));
    const entry = data.order_debug.find((row) => row.id === blocked.id);
    assert.equal(entry.factors.S.normalised, 1, "capped at 1 — §8 R13's deliberate ceiling");
    assert.equal(entry.tier_name, "T1");
  });
});

describe("task-order — assertion 10: the scope reaches SQL before the order does", () => {
  const FILLERS = 205;
  let late;

  before(() => {
    createProject("bulk", "Bulk");
    for (let index = 0; index < FILLERS; index += 1) {
      createTask({ projectId: "bulk", title: `filler ${index}`, priority: "low", assignee: "linus" });
    }
    // Created LAST, so in the repository's own order these sit past row 200 —
    // exactly where the old `list({status:"todo"})` (default `LIMIT 200`) cut,
    // *before* the assignee filter ran. They are also the weight-order winners.
    late = [0, 1].map((index) =>
      createTask({ projectId: "bulk", title: `late urgent ${index}`, priority: "urgent", assignee: "linus" }),
    );
  });

  it("returns the assignee's whole pool, not the first 200 rows of the board", async () => {
    const { candidates } = dataOf(await call("GET", "/api/v1/tasks/candidates?assignee=linus"));
    assert.equal(candidates.length, FILLERS + late.length);
    for (const candidate of late) {
      assert.ok(
        candidates.some((row) => row.id === candidate.id),
        `${candidate.identifier} sits past the old truncation point and must still be offered`,
      );
    }
  });

  it("orders the untruncated set, so a card past row 200 can lead", async () => {
    const { candidates } = dataOf(await call("GET", "/api/v1/tasks/candidates?assignee=linus"));
    assert.deepEqual(
      candidates.slice(0, 2).map((row) => row.id),
      late.map((task) => task.id),
      "the two cards created last lead the weight order",
    );
    assert.equal(candidates.at(-1).priority, "low");
  });

  it("does not leak an `order_debug` key into a plain candidate read", async () => {
    const data = dataOf(await call("GET", "/api/v1/tasks/candidates?assignee=linus"));
    assert.equal("order_debug" in data, false, "the diagnostic stays opt-in");
  });

  it("keeps the claimability bucket as the first key", async () => {
    // `stale` cards are in the recovery pool and must stay behind every `ready`
    // one, however much longer they have been waiting.
    createProject("buckets", "Buckets");
    const carol = { kind: "agent", id: "carol" };
    const abandoned = createTask({ projectId: "buckets", title: "abandoned", priority: "urgent", assignee: "carol" });
    commands().moveStatus({ id: abandoned.id, to: "in_progress", actor: carol });
    db().prepare("UPDATE tasks SET heartbeat_at = ? WHERE id = ?").run(LONG_AGO, abandoned.id);
    createTask({ projectId: "buckets", title: "queued", priority: "low", assignee: "carol" });

    const { candidates } = dataOf(
      await call("GET", "/api/v1/tasks/candidates?assignee=carol&stale=1&order_debug=1"),
    );
    assert.deepEqual(candidates.map((row) => row.reason), ["ready", "stale_any"]);
    assert.equal(candidates[1].priority, "urgent", "…and the urgent recovery card still comes second");
  });

  it("never offers an epic, however much it blocks (R10)", async () => {
    createProject("epics", "Epics");
    const epic = createTask({ projectId: "epics", title: "container", kind: "epic", priority: "urgent", assignee: "dave" });
    const children = [1, 2, 3].map((n) => createTask({ projectId: "epics", title: `child ${n}`, assignee: "dave" }));
    for (const child of children) {
      commands().addRelation({ type: "blocks", source: epic.id, target: child.id, actor: AGENT });
    }
    const ordinary = createTask({ projectId: "epics", title: "ordinary", assignee: "dave" });

    const { candidates, order_debug: orderDebug } = dataOf(
      await call("GET", "/api/v1/tasks/candidates?assignee=dave&order_debug=1"),
    );
    // The epic blocks three open cards — `B` at its cap of 1.0, the highest score
    // any card can reach on that factor — and is still absent, because automatic
    // reads never offer one (`domain/claim.mjs#AUTO_CLAIM_EXCLUDED_KINDS`).
    assert.equal(orderDebug.find((entry) => entry.id === epic.id), undefined);
    assert.ok(candidates.every((row) => row.id !== epic.id), "an epic is never a candidate");
    assert.deepEqual(candidates.map((row) => row.id), [ordinary.id]);
    // Its children are held back too — by the `blocks` edge, not by the epic
    // being excluded (T1: a `todo` card with an open predecessor).
    for (const child of children) {
      assert.deepEqual(
        repos().relations.listBlockerOf(child.id).map((edge) => edge.source),
        [epic.id],
      );
    }
  });

  it("counts open downstream cards for the `B` factor from one batched read", async () => {
    createProject("fan", "Fan");
    const hub = createTask({ projectId: "fan", title: "hub", priority: "low", assignee: "linus" });
    const leaves = [1, 2, 3, 4].map((n) => createTask({ projectId: "fan", title: `leaf ${n}`, assignee: "linus" }));
    for (const leaf of leaves) {
      commands().addRelation({ type: "blocks", source: hub.id, target: leaf.id, actor: AGENT });
    }
    // Finish one leaf: a card that is already `done` is not something this card
    // unlocks, so `B` must count 3, not 4 — and cap at 3/3 = 1.0.
    commands().moveStatus({ id: leaves[0].id, to: "in_progress", actor: AGENT });
    commands().moveStatus({
      id: leaves[0].id,
      to: "in_review",
      actor: AGENT,
      noReport: true,
      reason: "fan-out fixture",
    });
    commands().moveStatus({ id: leaves[0].id, to: "done", actor: { kind: "human", id: "Terry" } });

    const data = dataOf(await call("GET", "/api/v1/tasks?project_id=fan&order_debug=1"));
    const entry = data.order_debug.find((row) => row.id === hub.id);
    assert.equal(entry.factors.B.raw, 3, "the finished leaf is not counted");
    assert.equal(entry.factors.B.normalised, 1, "3/3, capped");
    // …and it is the whole `B` title: the hub leads its project on that alone.
    assert.equal(data.order_debug[0].id, hub.id);
  });
});

describe("task-order — the candidate projection is unchanged by the order", () => {
  it("still emits the card's fields, its meta and `reason`, and writes nothing", async () => {
    const before = currentRevision(db());
    const { candidates } = dataOf(await call("GET", "/api/v1/tasks/candidates?assignee=linus"));
    assert.deepEqual(Object.keys(candidates[0]).sort(), [
      "created_at",
      "id",
      "identifier",
      "meta",
      "priority",
      "project",
      "reason",
      "review_of",
      "review_round",
      "sort",
      "status",
      "target",
      "title",
    ]);
    assert.equal(currentRevision(db()), before, "the ordered poll read is still read-only");
  });
});
