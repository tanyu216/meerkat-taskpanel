/**
 * 0008 — the delivery gate must not accept a report the importer wrote.
 *
 * `c668bf4` mapped a historical `## Report` into a real `task_reports` row
 * (degraded to `acceptance_json='[]'` / `evidence_json='[]'` when the card was
 * narrative or incomplete). Before that commit the same card was refused
 * `REPORT_REQUIRED`; afterwards the round-only gate accepted the imported row,
 * so a card with no real delivery could reach `in_review`. This suite pins the
 * fix from every angle the regression touched:
 *
 *   1. the domain gate ignores `origin='import'` rows (and defaults a missing
 *      origin to `delivery`, for back-compat);
 *   2. import → command layer: an imported narrative/incomplete report does not
 *      satisfy `move → in_review`;
 *   3. a real `deliver` still passes and is tagged `origin='delivery'`;
 *   4. the DB trigger agrees with the domain gate, tested with raw SQL;
 *   5. per-card parse isolation (B1): one unparseable card does not sink the batch;
 *   6. import tolerance is *not* withdrawn — narrative/incomplete reports are
 *      still imported, just tagged `origin='import'`.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../src/core/commands/index.mjs";
import { checkDeliveryGate, reportCountsAsDelivery } from "../../src/core/domain/delivery-gate.mjs";
import { importMd } from "../../src/core/storage/md/import.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import {
  TS,
  cleanupTempDirs,
  countRows,
  createTempBoard,
  insertProject,
  insertTask,
  makeTempDir,
  reasonCode,
} from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

/** A minimal valid card with `overrides` merged into the frontmatter. */
function cardText(overrides = {}, sections = {}) {
  const front = {
    id: "DEMO-0001",
    title: "A card",
    status: "todo",
    priority: "medium",
    kind: "task",
    project: "demo",
    target: "/tmp/meerkat-taskpanel-report-origin",
    created_by: "elon",
    created_at: TS,
    ...overrides,
  };
  const body = Object.entries({ Background: "text", Acceptance: "- [ ] one", ...sections })
    .map(([name, text]) => `## ${name}\n\n${text}\n`)
    .join("\n");
  return `---\n${Object.entries(front)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}`;
}

/** A board plus a directory holding cards. */
async function boardWithCards(cards) {
  const board = await createTempBoard();
  board.repos = createRepositories(board.db);
  board.dir = join(makeTempDir("report-origin-cards-"), "cards");
  mkdirSync(board.dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(board.dir, name), text, "utf8");
  return board;
}

const importCards = (board) => importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });

const act = (board) => createCommands(createContext({ db: board.db, repos: board.repos, clock: () => TS }));

const ACTOR = { kind: "agent", id: "linus" };

// A narrative report (no structured acceptance, no evidence) …
const NARRATIVE = "A free-form narrative with no structured fields.";
// … and a structured-but-incomplete one (acceptance items, no evidence block).
const INCOMPLETE = [
  "### R1 · 2026-01-01T00:00:00.000Z · linus",
  "",
  "Round one.",
  "",
  "### Acceptance 自检",
  "",
  "- [x] criterion one",
].join("\n");

/** Raw insert with an explicit `origin`, for the trigger tests. */
function insertOriginReport(db, { taskId, round = 1, origin }) {
  db.prepare(
    `INSERT INTO task_reports(task_id, round, conclusion, acceptance_json, evidence_json,
                              author_kind, author_id, created_at, origin)
     VALUES (?, ?, 'done', '[]', '[]', 'agent', 'linus', ?, ?)`,
  ).run(taskId, round, TS, origin);
}

/** The gate's own UPDATE, straight to SQL — no service layer. */
const moveToReview = (db, taskId) =>
  reasonCode(() =>
    db
      .prepare("UPDATE tasks SET status = 'in_review', version = version + 1, updated_at = ? WHERE id = ?")
      .run(TS, taskId),
  );

describe("domain/delivery-gate — origin (0008)", () => {
  const task = { id: "task-1", identifier: "PROJ-0001", deliveryRound: 1 };

  it("reportCountsAsDelivery: only 'delivery' (and a missing origin) count", () => {
    assert.equal(reportCountsAsDelivery({ round: 1, origin: "delivery" }), true);
    assert.equal(reportCountsAsDelivery({ round: 1 }), true, "a missing origin is a delivery — back-compat");
    assert.equal(reportCountsAsDelivery({ round: 1, origin: "import" }), false);
    assert.equal(reportCountsAsDelivery(null), false);
    assert.equal(reportCountsAsDelivery("nope"), false);
    assert.equal(reportCountsAsDelivery(undefined), false);
  });

  it("refuses an import-origin report and accepts a delivery one for the current round", () => {
    const imported = checkDeliveryGate({ task, reports: [{ round: 1, origin: "import" }], to: "in_review" });
    assert.equal(imported.ok, false);
    assert.equal(imported.reason, "REPORT_REQUIRED");
    assert.deepEqual(imported.existingRounds, [], "an imported row is not a round on file");

    assert.equal(checkDeliveryGate({ task, reports: [{ round: 1, origin: "delivery" }], to: "in_review" }).ok, true);
    assert.equal(checkDeliveryGate({ task, reports: [{ round: 1 }], to: "in_review" }).ok, true);
  });

  it("passes on a delivery report even when an import row sits alongside it", () => {
    assert.deepEqual(
      checkDeliveryGate({
        task,
        reports: [{ round: 1, origin: "import" }, { round: 1, origin: "delivery" }],
        to: "in_review",
      }),
      { ok: true },
    );
  });
});

describe("0008 — import writes origin='import'", () => {
  it("tags a narrative and an incomplete report as import, and still imports both", async () => {
    const board = await boardWithCards({
      "NARRATIVE.md": cardText({ id: "DEMO-0001" }, { Report: NARRATIVE }),
      "INCOMPLETE.md": cardText({ id: "DEMO-0002" }, { Report: INCOMPLETE }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 2);
      assert.equal(stats.reports, 2, "tolerance is not withdrawn — both reports land");
      assert.equal(stats.reportSkipped.length, 0, "neither is a malformed-report skip");
      assert.equal(stats.reportNarrative.length, 1);
      assert.equal(stats.reportIncomplete.length, 1);

      for (const identifier of ["DEMO-0001", "DEMO-0002"]) {
        const task = board.repos.tasks.getByIdentifier("demo", identifier);
        const report = board.repos.reports.listByTask(task.id)[0];
        assert.equal(report.origin, "import", `${identifier}'s report is history, not delivery`);
      }
    } finally {
      board.close();
    }
  });

  it("defaults a repository insert to origin='delivery' and exposes both via listGateReports", async () => {
    const board = await createTempBoard();
    try {
      const repos = createRepositories(board.db);
      insertProject(board.db);
      insertTask(board.db, { id: "t-default", identifier: "PROJ-0001", status: "todo" });
      insertTask(board.db, { id: "t-import", identifier: "PROJ-0002", status: "todo" });

      const base = {
        round: 1,
        conclusion: "done",
        acceptanceJson: "[]",
        evidenceJson: "[]",
        authorKind: "agent",
        authorId: "linus",
        createdAt: TS,
      };
      assert.equal(repos.reports.insert({ ...base, taskId: "t-default" }).origin, "delivery", "the default");
      assert.equal(repos.reports.insert({ ...base, taskId: "t-import", origin: "import" }).origin, "import");

      assert.deepEqual(repos.reports.listGateReports("t-default"), [{ round: 1, origin: "delivery" }]);
      assert.deepEqual(repos.reports.listGateReports("t-import"), [{ round: 1, origin: "import" }]);
      // listRounds stays unfiltered — it answers "which rounds exist", not "which count".
      assert.deepEqual(repos.reports.listRounds("t-import"), [1]);
    } finally {
      board.close();
    }
  });
});

describe("0008 — import → command layer", () => {
  for (const [label, report] of [
    ["a narrative report", NARRATIVE],
    ["a structured-but-incomplete report", INCOMPLETE],
  ]) {
    it(`refuses in_review when the only report is imported (${label})`, async () => {
      const board = await boardWithCards({ "A.md": cardText({ status: "todo" }, { Report: report }) });
      try {
        const stats = importCards(board);
        assert.equal(stats.tasks, 1);
        assert.equal(stats.reports, 1, "the report is imported");
        assert.equal(stats.reportSkipped.length, 0);

        const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
        assert.equal(board.repos.reports.listByTask(task.id)[0].origin, "import");

        const commands = act(board);
        commands.moveStatus({ id: task.id, to: "in_progress", actor: ACTOR });

        assert.equal(commands.canMove({ taskId: task.id, to: "in_review" }).ok, false, "canMove agrees");
        assert.throws(
          () => commands.moveStatus({ id: task.id, to: "in_review", actor: ACTOR }),
          (err) => err.code === "REPORT_REQUIRED",
          "an imported report does not satisfy the delivery gate",
        );
        assert.equal(board.repos.tasks.get(task.id).status, "in_progress", "the refused move did not happen");
      } finally {
        board.close();
      }
    });
  }

  it("a real delivery still reaches in_review and is tagged origin='delivery'", async () => {
    const board = await boardWithCards({ "A.md": cardText() });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1);
      const commands = act(board);
      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      commands.moveStatus({ id: task.id, to: "in_progress", actor: ACTOR });

      const { task: moved, report } = commands.deliver({
        taskId: task.id,
        report: {
          conclusion: "shipped",
          acceptance: [{ text: "criterion", status: "met" }],
          evidence: [{ kind: "command", cmd: "node --test", exit_code: 0 }],
        },
        actor: ACTOR,
      });

      assert.equal(moved.status, "in_review");
      assert.equal(report.origin, "delivery");
      assert.equal(board.repos.reports.get(report.id).origin, "delivery");
    } finally {
      board.close();
    }
  });
});

describe("0008 — the DB trigger agrees (raw SQL)", () => {
  it("an import-origin row does not satisfy tr_deliver_gate; a delivery one does", async () => {
    const board = await createTempBoard();
    try {
      insertProject(board.db);
      insertTask(board.db, { id: "t-import", identifier: "PROJ-0001", status: "in_progress" });
      insertOriginReport(board.db, { taskId: "t-import", origin: "import" });
      assert.equal(moveToReview(board.db, "t-import"), "REPORT_REQUIRED");

      insertTask(board.db, { id: "t-delivery", identifier: "PROJ-0002", status: "in_progress" });
      insertOriginReport(board.db, { taskId: "t-delivery", origin: "delivery" });
      assert.equal(moveToReview(board.db, "t-delivery"), "NO_ERROR");
    } finally {
      board.close();
    }
  });
});

describe("B1 — per-card parse isolation", () => {
  it("skips one unparseable card and imports the rest, without aborting the batch", async () => {
    const board = await boardWithCards({
      "GOOD.md": cardText({ id: "DEMO-0001" }),
      "BAD.md": cardText({ id: '""' }), // frontmatter with no id → parseCard throws
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.files, 2);
      assert.equal(stats.tasks, 1, "the good card imports");
      assert.equal(stats.parseSkipped.length, 1, "the bad card is skipped, not fatal");
      assert.equal(stats.parseSkipped[0].file, "BAD.md");
      assert.equal(stats.parseSkipped[0].code, "MD_PARSE_ERROR");
      assert.ok(stats.warnings.some((w) => /BAD\.md: the card could not be parsed \(MD_PARSE_ERROR\)/.test(w)));
      assert.equal(countRows(board.db, "tasks"), 1);
      assert.notEqual(board.repos.tasks.getByIdentifier("demo", "DEMO-0001"), null);
    } finally {
      board.close();
    }
  });
});
