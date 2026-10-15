/**
 * md import — the exit code when a dependency edge is refused (T-20261015-175050).
 *
 * **This file pins a ruling; it does not introduce one.** The residual it answers
 * (T-20261015-171858 R-1) asked whether `migrate-cli.mjs import` returning **0**
 * while an illegal dependency shape was refused is a defect. The verdict is **by
 * design, unchanged**, and the assertions below are what "by design" means
 * concretely:
 *
 *   * the runner says so itself — `Exit codes: 0 success · 1 the run failed ·
 *     2 bad usage · 3 \`check\` found differences. **Warnings alone do not fail a
 *     run.**` (`migrate-cli.mjs` header), and that sentence is already tested for
 *     `check` (`test/core/storage/md/import-export.test.mjs`, "A warning is
 *     reported but does not fail the run");
 *   * a refusal is a documented *reporting* channel, not a failure channel:
 *     `docs/migration.md` §Risks & checklist — "Refusals are caught per-edge,
 *     listed as `unmappable[kind=invariant-violation]`, and not lost", and the
 *     notices/warnings split ("`notices` never block, `warnings` are what a
 *     reviewer reads");
 *   * the importer's M5 ruling is per-card isolation — one bad card must not sink
 *     a batch (`insertRelation` in `import.mjs`: "turning any invariant refusal
 *     into a warning instead of an abort — a real card that violates an
 *     invariant must be reported, not lost");
 *   * the sanctioning in-repo consumer agrees: `scripts/migrate/reconcile.mjs`
 *     files the same `invariantViolations` under `unmappable[kind=
 *     invariant-violation]`, which is not a `difference` and so does not move its
 *     exit code either.
 *
 * The concern R-1 raised is real but belongs to the caller: a bare `$?` cannot
 * distinguish "imported everything" from "imported, and refused N edges" — which
 * is exactly what "warnings alone do not fail a run" declares, and why the
 * refusal is carried structurally instead (stdout `warning:` line, the `--json`
 * payload's `warnings[]` and `invariantViolations[]`, the drill's `unmappable[]`).
 *
 * If a later card decides the exit code *should* carry degrade information, it
 * changes the contract here first: a non-zero code for "imported with refusals"
 * needs a new code, a caller survey and a ruling — not a quiet edit.
 *
 * Fixtures are synthetic hand-written cards (F9), built in a temp dir; the
 * registry is the shared `test/migrate/fixtures/registry/projects.json`.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { main as cliMain } from "../../src/core/storage/md/migrate-cli.mjs";
import { checkRelationInvariants } from "../../src/core/storage/md/invariants-check.mjs";
import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const REGISTRY_PATH = join(import.meta.dirname, "fixtures/registry/projects.json");
const TS = "2026-01-01T00:00:00.000Z";

/** A minimal card; `overrides` are merged into the frontmatter. */
function cardText(overrides = {}) {
  const front = {
    id: "DEMO-0001",
    title: "A card",
    status: "todo",
    priority: "medium",
    kind: "task",
    project: "demo",
    created_by: "elon",
    created_at: TS,
    ...overrides,
  };
  return `---\n${Object.entries(front)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n## Background\n\ntext\n\n## Acceptance\n\n- [ ] one\n`;
}

/** The three cards both cases share: an epic, a legal child, a legal sibling. */
const EPIC = cardText({ id: "DEMO-0001", title: "The epic", kind: "epic" });
const LEGAL_CHILD = cardText({
  id: "DEMO-0002",
  title: "A legal child",
  parent: "DEMO-0001",
  depends_on: "[DEMO-0003]",
});
const LEGAL_SIBLING = cardText({ id: "DEMO-0003", title: "A legal sibling", parent: "DEMO-0001" });

/** Write `cards` into a fresh dir under a fresh temp root, and return both. */
function writeCards(cards) {
  const dir = join(makeTempDir("md-exit-codes-"), "cards");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(dir, name), text, "utf8");
  return { dir, dbPath: join(makeTempDir("md-exit-codes-db-"), "board.sqlite") };
}

/** Run the real CLI entry point, capturing both streams. */
async function runCli(argv) {
  let out = "";
  let err = "";
  const code = await cliMain(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

const importArgv = (dir, dbPath, extra = []) => [
  "import",
  "--dir",
  dir,
  "--db",
  dbPath,
  "--projects",
  REGISTRY_PATH,
  ...extra,
];

/** Read the landed relations back as `type source->target` identifier triples. */
async function readRelations(dbPath) {
  const db = await openDatabase({ path: dbPath });
  try {
    return db
      .prepare(
        `SELECT r.relation_type AS type, s.identifier AS source, d.identifier AS target
           FROM task_relations r
           JOIN tasks s ON s.id = r.source_task_id
           JOIN tasks d ON d.id = r.target_task_id`,
      )
      .all()
      .map((row) => `${row.type} ${row.source}->${row.target}`)
      .sort();
  } finally {
    closeDatabase(db);
  }
}

/** Re-derive the six relation invariants from the board as it now stands. */
async function readViolations(dbPath) {
  const db = await openDatabase({ path: dbPath });
  try {
    const tasks = db
      .prepare("SELECT id, identifier, project_id, kind FROM tasks")
      .all()
      .map((row) => ({ id: row.id, identifier: row.identifier, projectId: row.project_id, kind: row.kind }));
    const relations = db
      .prepare("SELECT relation_type, source_task_id, target_task_id FROM task_relations")
      .all()
      .map((row) => ({ type: row.relation_type, source: row.source_task_id, target: row.target_task_id }));
    return checkRelationInvariants({ tasks, relations }).violations;
  } finally {
    closeDatabase(db);
  }
}

describe("md/migrate-cli — exit code when a dependency edge is refused (T-20261015-175050)", () => {
  it("a legal batch exits 0 and lands every edge", async () => {
    const { dir, dbPath } = writeCards({
      "DEMO-0001.md": EPIC,
      "DEMO-0002.md": LEGAL_CHILD,
      "DEMO-0003.md": LEGAL_SIBLING,
    });

    const { code, out } = await runCli(importArgv(dir, dbPath));

    assert.equal(code, 0);
    assert.doesNotMatch(out, /warning:/, "a clean import reports no warning");
    assert.deepEqual(await readRelations(dbPath), [
      "blocks DEMO-0003->DEMO-0002",
      "parent DEMO-0001->DEMO-0002",
      "parent DEMO-0001->DEMO-0003",
    ]);
  });

  it("an illegal dependency shape still exits 0, and the refused pair lands no edge", async () => {
    // The illegal shape: a child whose `depends_on` names its own parent epic, so
    // the `blocks` edge would join an ancestor and a descendant of the parent
    // chain (`0019` / `0020`). Which member of the pair is the one refused is
    // insert-order dependent — the guard exists at both insert points — so the
    // assertion is about the *net* adjacency, not about which warning fires.
    const { dir, dbPath } = writeCards({
      "DEMO-0001.md": EPIC,
      "DEMO-0002.md": cardText({
        id: "DEMO-0002",
        title: "Depends on its own parent epic",
        parent: "DEMO-0001",
        depends_on: "[DEMO-0001]",
      }),
      "DEMO-0003.md": LEGAL_SIBLING,
    });

    const { code, out } = await runCli(importArgv(dir, dbPath));

    assert.equal(code, 0, "a refused edge is a warning, not a failed run");
    const warnings = out.split("\n").filter((line) => line.includes("warning:"));
    assert.equal(warnings.length, 1, "the refusal is reported exactly once");
    assert.match(warnings[0], /the (parent|depends_on) link was rejected \(RELATION_CYCLE\)/);

    const landed = await readRelations(dbPath);
    assert.ok(
      !landed.includes("blocks DEMO-0001->DEMO-0002") || !landed.includes("parent DEMO-0001->DEMO-0002"),
      `the ancestor/descendant pair must not land twice: ${JSON.stringify(landed)}`,
    );
    assert.deepEqual(await readViolations(dbPath), [], "the board that landed satisfies the relation invariants");
  });

  it("the refusal is machine-readable, not only prose on stdout", async () => {
    const { dir, dbPath } = writeCards({
      "DEMO-0001.md": EPIC,
      "DEMO-0002.md": cardText({
        id: "DEMO-0002",
        title: "Depends on its own parent epic",
        parent: "DEMO-0001",
        depends_on: "[DEMO-0001]",
      }),
    });

    const { code, out } = await runCli(importArgv(dir, dbPath, ["--json"]));
    const payload = JSON.parse(out);

    assert.equal(code, 0);
    assert.equal(payload.ok, true, "`ok` tracks the run, not the per-edge outcome");
    assert.equal(payload.warnings.length, 1);
    assert.equal(payload.invariantViolations.length, 1);
    assert.equal(payload.invariantViolations[0].reason, "RELATION_CYCLE");
    assert.equal(payload.invariantViolations[0].identifier, "DEMO-0002");
    // A caller that wants a completeness signal reads these two arrays; a caller
    // that reads only the exit code is reading the documented contract.
    assert.ok(payload.warnings.length > 0 && payload.invariantViolations.length > 0);
  });

  it("`check` does not evaluate relations, so the illegal shape is no difference there", async () => {
    // The observed boundary, pinned so it cannot surprise a reader: `check` is the
    // parse + source-hash pre-flight (migrate-cli header), and a relation shape is
    // neither. Only `import` reports the refusal.
    const { dir } = writeCards({
      "DEMO-0001.md": EPIC,
      "DEMO-0002.md": cardText({
        id: "DEMO-0002",
        title: "Depends on its own parent epic",
        parent: "DEMO-0001",
        depends_on: "[DEMO-0001]",
      }),
    });

    const { code, out } = await runCli(["check", "--dir", dir]);

    assert.equal(code, 0);
    assert.match(out, /2 parsed/);
    assert.doesNotMatch(out, /difference:/);
  });
});
