/**
 * M5 migrator hardening — the rulings the reconcile drill depends on.
 *
 *   1. project name → id resolution (registry hit / miss / --create-project);
 *   2. `parent:` on a non-epic is a WARN + SKIP, never a thrown parse error;
 *   3. `depends_on` direction: source = blocker, type = blocks;
 *   4. invariant refusals become warnings, never a silent drop;
 *   5. `target` is project-level; two values are a warning.
 *
 * Fixtures are synthetic hand-written cards (F9); the registry is the one under
 * `test/migrate/fixtures/registry/`.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { exportMd } from "../../src/core/storage/md/export.mjs";
import { importMd, parseCard, resolveProjectId } from "../../src/core/storage/md/import.mjs";
import { loadProjectRegistry } from "../../src/core/storage/md/project-registry.mjs";
import { main as cliMain, parseArgs } from "../../src/core/storage/md/migrate-cli.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const REGISTRY_PATH = join(import.meta.dirname, "fixtures/registry/projects.json");
const REGISTRY = loadProjectRegistry(REGISTRY_PATH);

/** A minimal valid card with `overrides` merged into the frontmatter. */
function cardText(overrides = {}, sections = {}) {
  const front = {
    id: "DEMO-0001",
    title: "A card",
    status: "todo",
    priority: "medium",
    kind: "task",
    project: "demo",
    target: "/tmp/task-panel-migrate-fixture",
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
  board.dir = join(makeTempDir("migrate-cards-"), "cards");
  mkdirSync(board.dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(board.dir, name), text, "utf8");
  return board;
}

const importCards = (board, extra = {}) =>
  importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS, registry: REGISTRY, ...extra });

describe("md/import — project name → id resolution (§4.8 ④)", () => {
  it("resolveProjectId maps a registered name to its id, and passes through without a registry", () => {
    assert.equal(resolveProjectId("demo", REGISTRY), "demo");
    assert.equal(resolveProjectId("DEMO", REGISTRY), "demo", "normalised match");
    assert.equal(resolveProjectId("demo", null), "demo", "no registry: the name is the id");
    assert.equal(resolveProjectId("Missing", REGISTRY), "Missing");
    assert.equal(resolveProjectId("", REGISTRY), null);
    assert.equal(resolveProjectId(null, REGISTRY), null);
  });

  it("uses the registry id and stores the metadata in projects.meta_json", async () => {
    const board = await boardWithCards({ "A.md": cardText() });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1);
      assert.equal(stats.warnings.length, 0);
      const project = board.repos.projects.get("demo");
      assert.equal(project.name, "demo");
      assert.equal(project.workspacePath, "/tmp/task-panel-migrate-fixture", "workspace path comes from the registry root");
      assert.equal(project.meta.kind, "code");
      assert.equal(project.meta.default_git_rules, "explicit paths only");
    } finally {
      board.close();
    }
  });

  it("warns and skips a card whose project is not registered (no silent create)", async () => {
    const board = await boardWithCards({ "A.md": cardText({ project: "Missing" }) });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 0, "nothing is created");
      assert.equal(stats.projectSkipped, 1);
      assert.equal(stats.warnings.length, 1);
      assert.match(stats.warnings[0], /not a registered project name/);
      assert.deepEqual(stats.projectSkippedCards, [{ file: "A.md", identifier: "DEMO-0001", project: "Missing" }]);
      assert.equal(board.repos.projects.get("Missing"), null);
    } finally {
      board.close();
    }
  });

  it("creates the project only when --create-project is explicit", async () => {
    const board = await boardWithCards({ "A.md": cardText({ project: "Missing" }) });
    try {
      const stats = importCards(board, { createProject: true });
      assert.equal(stats.tasks, 1);
      assert.equal(stats.warnings.length, 0);
      assert.equal(stats.notices.length, 1);
      assert.match(stats.notices[0], /created project/);
      assert.equal(board.repos.projects.get("Missing").name, "Missing");
    } finally {
      board.close();
    }
  });

  it("keeps the historical behaviour without a registry — but surfaces a notice", async () => {
    const board = await boardWithCards({ "A.md": cardText() });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.tasks, 1);
      assert.equal(stats.warnings.length, 0, "auto-creating is not a warning");
      assert.equal(stats.notices.length, 1);
      assert.match(stats.notices[0], /auto-created project demo/);
      assert.equal(board.repos.tasks.getByIdentifier("demo", "DEMO-0001").projectId, "demo");
    } finally {
      board.close();
    }
  });
});

describe("md/import — parent handling (§4.8 ③, M5 ruling)", () => {
  it("warns and skips a parent that is not an epic, instead of throwing", async () => {
    const board = await boardWithCards({
      "EPIC.md": cardText({ id: "DEMO-0001", kind: "task" }), // deliberately NOT an epic
      "CHILD.md": cardText({ id: "DEMO-0002", parent: "DEMO-0001" }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 2, "both cards still import");
      assert.equal(stats.relations, 0, "the bad parent link is not written");
      assert.equal(stats.parentSkipped.length, 1);
      assert.deepEqual(stats.parentSkipped[0], {
        file: "CHILD.md",
        identifier: "DEMO-0002",
        parent: "DEMO-0001",
        parentKind: "task",
      });
      assert.match(stats.warnings[0], /only an epic can be a parent/);
      assert.equal(board.repos.relations.getParent(board.repos.tasks.getByIdentifier("demo", "DEMO-0002").id), null);
    } finally {
      board.close();
    }
  });

  it("links a parent that is an epic", async () => {
    const board = await boardWithCards({
      "EPIC.md": cardText({ id: "DEMO-0001", kind: "epic" }),
      "CHILD.md": cardText({ id: "DEMO-0002", parent: "DEMO-0001" }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.relations, 1);
      assert.equal(stats.parentSkipped.length, 0);
      const child = board.repos.tasks.getByIdentifier("demo", "DEMO-0002");
      assert.equal(board.repos.relations.getParent(child.id).source, board.repos.tasks.getByIdentifier("demo", "DEMO-0001").id);
    } finally {
      board.close();
    }
  });

  it("records a missing parent as a warning, not a crash", async () => {
    const board = await boardWithCards({ "A.md": cardText({ parent: "DEMO-9999" }) });
    try {
      const stats = importCards(board);
      assert.equal(stats.parentNotFound.length, 1);
      assert.match(stats.warnings[0], /parent DEMO-9999 is not in this import/);
    } finally {
      board.close();
    }
  });
});

describe("md/import — depends_on direction (M5 ruling)", () => {
  it("stores md `depends_on: [X]` as blocks(source = X the blocker, target = this card)", async () => {
    const board = await boardWithCards({
      "BLOCKER.md": cardText({ id: "DEMO-0001" }),
      "BLOCKED.md": cardText({ id: "DEMO-0002", depends_on: "[DEMO-0001]" }),
    });
    try {
      importCards(board);
      const blocked = board.repos.tasks.getByIdentifier("demo", "DEMO-0002");
      const blocker = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      const edges = board.repos.relations.listBlockerOf(blocked.id);
      assert.deepEqual(edges.map((e) => e.source), [blocker.id], "the blocker is the source");
      assert.deepEqual(edges.map((e) => e.type), ["blocks"]);
    } finally {
      board.close();
    }
  });

  it("rebuilds depends_on exactly on export", async () => {
    const board = await boardWithCards({
      "BLOCKER.md": cardText({ id: "DEMO-0001" }),
      "BLOCKED.md": cardText({ id: "DEMO-0002", depends_on: "[DEMO-0001]" }),
    });
    try {
      importCards(board);
      const out = join(makeTempDir("migrate-out-"), "cards");
      exportMd({ repos: board.repos, outDir: out, now: TS });
      assert.match(readFileSync(join(out, "DEMO-0002.md"), "utf8"), /^depends_on: \[DEMO-0001\]$/m);
    } finally {
      board.close();
    }
  });

  it("warns about an unresolved depends_on", async () => {
    const board = await boardWithCards({ "A.md": cardText({ depends_on: "[DEMO-9999]" }) });
    try {
      const stats = importCards(board);
      assert.equal(stats.dependsUnresolved.length, 1);
      assert.equal(stats.dependsUnresolved[0].dependsOn, "DEMO-9999");
    } finally {
      board.close();
    }
  });
});

describe("md/import — an unrepresentable ## Report is reported, not fatal", () => {
  it("imports the card, skips the report, and records it as a finding", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ status: "in_review" }, { Report: "A free-form narrative with no structured acceptance list." }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the card itself still imports");
      assert.equal(stats.reports, 0, "the unrepresentable report is not written");
      assert.equal(stats.reportSkipped.length, 1);
      assert.deepEqual(
        { ...stats.reportSkipped[0], reason: undefined },
        { file: "A.md", identifier: "DEMO-0001", round: 1, code: "REPORT_INVALID", reason: undefined },
      );
      assert.match(stats.warnings[0], /## Report block \(round 1\) was not imported \(REPORT_INVALID\)/);
    } finally {
      board.close();
    }
  });

  it("stays idempotent: a second pass writes neither row nor report", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ status: "in_review" }, { Report: "A free-form narrative with no structured acceptance list." }),
    });
    try {
      importCards(board);
      const second = importCards(board);
      assert.equal(second.tasks, 0);
      assert.equal(second.updated, 0);
      assert.equal(second.reports, 0);
      assert.equal(second.skipped, 1, "the card is recognised as already imported");
    } finally {
      board.close();
    }
  });
});

describe("md/import — invariant refusals become warnings", () => {
  it("catches a self-parenting epic per card and records the reason", async () => {
    const board = await boardWithCards({ "A.md": cardText({ id: "DEMO-0001", kind: "epic", parent: "DEMO-0001" }) });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the card itself still imports");
      assert.equal(stats.relations, 0);
      assert.equal(stats.invariantViolations.length, 1);
      assert.equal(stats.invariantViolations[0].reason, "SELF_REFERENCE");
      assert.match(stats.warnings[0], /rejected \(SELF_REFERENCE\)/);
    } finally {
      board.close();
    }
  });
});

describe("md/import — target is project-level (M5 ruling)", () => {
  it("warns — but does not fail — when one project carries two targets", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ id: "DEMO-0001", target: "/tmp/task-panel-migrate-fixture" }),
      "B.md": cardText({ id: "DEMO-0002", target: "/tmp/elsewhere" }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 2, "both cards import; the mismatch is a warning");
      assert.equal(stats.warnings.length, 1);
      assert.match(stats.warnings[0], /two different targets/);
      assert.equal(board.repos.projects.get("demo").workspacePath, "/tmp/task-panel-migrate-fixture");
    } finally {
      board.close();
    }
  });
});

describe("md/import — legacy fields stay verbatim (§4.8 ①)", () => {
  it("preserves goal and review_of in meta_json.legacy and re-exports them", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ goal: "keep me around", review_of: "DEMO-0000" }),
    });
    try {
      importCards(board);
      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.equal(task.meta.legacy.goal, "keep me around");
      assert.equal(task.meta.legacy.review_of, "DEMO-0000");

      const out = join(makeTempDir("migrate-legacy-"), "cards");
      exportMd({ repos: board.repos, outDir: out, now: TS });
      const card = readFileSync(join(out, "DEMO-0001.md"), "utf8");
      assert.match(card, /^goal: keep me around$/m);
      assert.match(card, /^review_of: DEMO-0000$/m);
    } finally {
      board.close();
    }
  });

  it("parses a card whose goal/review_of are no longer 'known' keys", () => {
    const card = parseCard(cardText({ goal: "g", review_of: "R" }), { file: "a.md" });
    assert.deepEqual(card.legacy, { goal: "g", review_of: "R" });
  });
});

describe("md/migrate-cli — the new flags", () => {
  it("parses --projects and --create-project", () => {
    assert.deepEqual(parseArgs(["import", "--dir", "x", "--projects", "p.json", "--create-project"]), {
      command: "import",
      json: false,
      resume: false,
      dir: "x",
      projects: "p.json",
      createProject: true,
    });
  });

  it("runs the drill through the CLI, printing notes for auto-created projects", async () => {
    const board = await boardWithCards({ "A.md": cardText() });
    let out = "";
    const io = { stdout: (t) => (out += t), stderr: (t) => (out += t) };
    try {
      // No --projects: legacy id = name, with a note.
      const db1 = join(makeTempDir("migrate-cli-"), "board.sqlite");
      assert.equal(await cliMain(["import", "--dir", board.dir, "--db", db1], io), 0);
      assert.match(out, /note: auto-created project demo/);

      out = "";
      const db2 = join(makeTempDir("migrate-cli-"), "board.sqlite");
      assert.equal(await cliMain(["import", "--dir", board.dir, "--db", db2, "--projects", REGISTRY_PATH], io), 0);
      assert.match(out, /imported 1 new, 0 updated, 0 unchanged from 1 file\(s\)/);

      out = "";
      const db3 = join(makeTempDir("migrate-cli-"), "board.sqlite");
      assert.equal(
        await cliMain(["import", "--dir", board.dir, "--db", db3, "--projects", join(makeTempDir("missing-"), "none.json")], io),
        1,
        out,
      );
    } finally {
      board.close();
    }
  });
});
