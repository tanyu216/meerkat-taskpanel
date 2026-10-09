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
    target: "/tmp/meerkat-taskpanel-migrate-fixture",
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
      assert.equal(project.workspacePath, "/tmp/meerkat-taskpanel-migrate-fixture", "workspace path comes from the registry root");
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

describe("md/import — a historical narrative ## Report is mapped, not rejected", () => {
  const NARRATIVE = "A free-form narrative with no structured acceptance list.";

  it("imports the card and stores the narrative as a conclusion-only report", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ status: "in_review" }, { Report: NARRATIVE }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the card imports");
      assert.equal(stats.reports, 1, "the narrative becomes one report row");
      assert.equal(stats.reportSkipped.length, 0, "a narrative is not a report-invalid skip");
      assert.deepEqual(stats.reportNarrative, [{ file: "A.md", identifier: "DEMO-0001", round: 1 }]);

      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.deepEqual(task.meta.import_warnings, ["report_narrative"]);
      const report = board.repos.reports.listByTask(task.id)[0];
      assert.equal(report.conclusion, NARRATIVE);
      assert.deepEqual(report.acceptance, [], "no structured field is fabricated");
      assert.deepEqual(report.evidence.items, [], "no structured field is fabricated");
    } finally {
      board.close();
    }
  });

  it("stays idempotent: a second pass writes neither row nor report", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ status: "in_review" }, { Report: NARRATIVE }),
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

  it("imports a structured-but-incomplete report degraded — acceptance, no evidence", async () => {
    // The M5 drill's class B: prose plus `- [x]` acceptance lines under a
    // `### Acceptance` heading, and no `evidence:` block. The strict gate
    // rejects it (it needs an anchor); the relaxed historical path stores it
    // with its acceptance items and empty evidence — imported, degraded, tagged,
    // and never dropped.
    const board = await boardWithCards({
      "A.md": cardText({ status: "in_review" }, {
        Report: [
          "### R1 · 2026-01-01T00:00:00.000Z · linus",
          "",
          "Round one.",
          "",
          "### Acceptance 自检",
          "",
          "- [x] criterion one",
          "- [x] criterion two",
        ].join("\n"),
      }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the card imports");
      assert.equal(stats.reports, 1, "the incomplete report is imported, not skipped");
      assert.equal(stats.reportSkipped.length, 0);
      assert.deepEqual(stats.reportIncomplete, [{ file: "A.md", identifier: "DEMO-0001", round: 1 }]);
      assert.equal(stats.reportNarrative.length, 0, "acceptance is present, so it is not a narrative");

      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.deepEqual(task.meta.import_warnings, ["report_incomplete"]);
      const report = board.repos.reports.listByTask(task.id)[0];
      assert.deepEqual(
        report.acceptance,
        [
          { status: "met", text: "criterion one" },
          { status: "met", text: "criterion two" },
        ],
        "the `- [x]` checkbox is mapped to the canonical status at the import edge",
      );
      assert.deepEqual(report.evidence.items, [], "no evidence is fabricated");

      // Idempotent: a second pass writes neither row nor report.
      const second = importCards(board);
      assert.equal(second.reports, 0);
      assert.equal(second.skipped, 1);
    } finally {
      board.close();
    }
  });

  it("still skips a report that is malformed in a way the relaxed path cannot fix", async () => {
    // Acceptance is present (so it is *not* a narrative), but the evidence anchor
    // is present-and-invalid (a commit sha that is not hex): both the strict gate
    // and the relaxed path reject it, so the block falls to reportSkipped — the
    // fallback is not a blanket licence. (A truly *unknown* anchor kind is
    // dropped by the tolerant parser instead, which leaves evidence empty and so
    // imports the report as `report_incomplete`, not a skip.)
    const board = await boardWithCards({
      "A.md": cardText({ status: "in_review" }, {
        Report: [
          "### R1 · 2026-01-01T00:00:00.000Z · linus",
          "",
          "Round one.",
          "",
          "acceptance:",
          "- [met] x",
          "",
          "evidence:",
          "- commit zzz",
        ].join("\n"),
      }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1);
      assert.equal(stats.reports, 0, "the malformed report is not written");
      assert.equal(stats.reportSkipped.length, 1);
      assert.equal(stats.reportSkipped[0].code, "REPORT_INVALID");
      assert.equal(stats.reportNarrative.length, 0);
      assert.equal(stats.reportIncomplete.length, 0);
      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.equal(task.meta.import_warnings, undefined, "a skipped report leaves no degraded tag");
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
      "A.md": cardText({ id: "DEMO-0001", target: "/tmp/meerkat-taskpanel-migrate-fixture" }),
      "B.md": cardText({ id: "DEMO-0002", target: "/tmp/elsewhere" }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 2, "both cards import; the mismatch is a warning");
      assert.equal(stats.warnings.length, 1);
      assert.match(stats.warnings[0], /two different targets/);
      assert.equal(board.repos.projects.get("demo").workspacePath, "/tmp/meerkat-taskpanel-migrate-fixture");
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

describe("md/import — the buildin __team__ project (PROTOCOL ②)", () => {
  it("imports a __team__ card with no registry file at all", async () => {
    const board = await boardWithCards({ "A.md": cardText({ project: "__team__", target: "/tmp/team-chore" }) });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.tasks, 1, "the card imports instead of being skipped as unregistered");
      assert.equal(stats.projectSkipped, 0);
      const project = board.repos.projects.get("__team__");
      assert.equal(project.workspacePath, "/__team__", "the documented synthetic anchor");
      assert.equal(project.meta.buildin, true);
      assert.equal(project.meta.kind, "team");
    } finally {
      board.close();
    }
  });

  it("imports with a registry that lacks __team__ — the buildin still resolves", async () => {
    const board = await boardWithCards({ "A.md": cardText({ project: "__team__", target: "/tmp/team-chore" }) });
    try {
      const stats = importCards(board); // registry = demo/Widgets only
      assert.equal(stats.tasks, 1);
      assert.equal(stats.projectSkipped, 0);
      assert.equal(board.repos.projects.get("__team__").workspacePath, "/__team__");
    } finally {
      board.close();
    }
  });

  it("does not raise the two-targets warning flood for __team__ cards", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ id: "DEMO-0001", project: "__team__", target: "/tmp/a.mjs" }),
      "B.md": cardText({ id: "DEMO-0002", project: "__team__", target: "/tmp/b.mjs" }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 2, "both cards import");
      assert.equal(
        stats.warnings.filter((warning) => /two different targets/.test(warning)).length,
        0,
        "a buildin project's per-card targets are not a project-level disagreement",
      );
    } finally {
      board.close();
    }
  });
});

describe("md/import — a tolerant parse is visible, not silent", () => {
  it("imports a card whose ## Acceptance carries prose, recording a notice", async () => {
    const card = cardText({}, { Acceptance: ["- [ ] one", "> a quote note", "prose here"].join("\n") });
    const parsed = parseCard(card, { file: "A.md" });
    assert.deepEqual(parsed.acceptance, [{ text: "one", checked: false }], "the checkbox survives");
    assert.equal(parsed.notices.length, 2, "the quote note and the prose line");
    assert.equal(parsed.notices[0].section, "Acceptance");
    assert.deepEqual(parsed.meta.import_warnings, ["parse_tolerated"]);

    const board = await boardWithCards({ "A.md": card });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the card imports");
      assert.equal(stats.warnings.length, 0, "tolerance is a notice, not a warning");
      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.deepEqual(task.meta.import_warnings, ["parse_tolerated"]);
      assert.deepEqual(task.meta.acceptance_legacy, [{ text: "one", checked: false }]);
    } finally {
      board.close();
    }
  });

  it("parses and imports a card carrying all four M5 failure shapes at once", async () => {
    const text = [
      "---",
      "id: DEMO-0001",
      "title: Kitchen sink",
      "status: in_review",
      "priority: high",
      "kind: task",
      "project: __team__",
      "target: /tmp/team-chore.mjs",
      "created_by: elon",
      "created_at: 2026-01-01T00:00:00.000Z",
      "updated_at: 2026-01-01T00:00:00.000Z",
      "status_changed_at: 2026-01-01T00:00:00.000Z",
      'claimed_by: ""',
      'claimed_at: ""',
      'heartbeat_at: ""',
      'blocked_at: ""',
      // (frontmatter-value) a real git_rules value that begins with `**`.
      "git_rules: **only** team scripts; git commit -- <explicit paths>",
      "---",
      "## Background",
      "",
      "text",
      "",
      "## Acceptance",
      "",
      "- [ ] one",
      "> a quote note",
      "- [x] two",
      "  - a nested sub-bullet",
      "a plain prose line",
      "",
      "## Progress",
      "",
      "## Comments",
      "",
      "- 2026-01-01T01:00:00.000Z · change · elon — a well-formed comment",
      "a body continuation line with no separator",
      "",
      "## Sessions",
      "",
      "## Report",
      "",
      "**结论**：done.",
      "",
      "| # | need | done |",
      "|---|---|---|",
      "| 1 | one | yes |",
    ].join("\n");

    const card = parseCard(text, { file: "A.md" });
    assert.deepEqual(card.acceptance.map((item) => item.text), ["one", "two"], "(acceptance-line)");
    assert.equal(card.comments.length, 1, "(comment-separator) the well-formed comment survives");
    assert.equal(card.reports.length, 1);
    assert.equal(card.reports[0].narrative, true, "(report sub-block) the table is a narrative");
    assert.equal(card.legacy.git_rules, "**only** team scripts; git commit -- <explicit paths>");
    assert.ok(card.notices.length >= 4, "the tolerated lines are recorded");

    const board = await boardWithCards({ "A.md": text });
    try {
      const stats = importCards(board); // the registry has no __team__ — buildin covers it
      assert.equal(stats.tasks, 1, "the card imports");
      assert.equal(stats.projectSkipped, 0, "(__team__) no unregistered-project skip");
      assert.equal(stats.comments, 1);
      assert.equal(stats.reports, 1, "the narrative report is stored");
      assert.equal(stats.reportSkipped.length, 0);
      assert.equal(board.repos.projects.get("__team__").workspacePath, "/__team__");
      const task = board.repos.tasks.getByIdentifier("__team__", "DEMO-0001");
      assert.deepEqual(task.meta.import_warnings, ["report_narrative", "parse_tolerated"]);
    } finally {
      board.close();
    }
  });

  it("imports a card whose ## Sessions keeps the unedited placeholder comment", async () => {
    // 11 of the M5 drill's cards kept the template placeholder verbatim; a
    // non-conforming line used to abort the whole card.
    const placeholder =
      "<!-- 子会话关联（resume 依据）：每段一行 · 字段 seg/owner/backend/id/phase/status/pid -->";
    const board = await boardWithCards({
      "A.md": cardText({}, {
        Sessions: [
          placeholder,
          "- seg:seg1 · owner:linus · backend:claude · id:sess-1 · phase:plan · status:closed · pid: · 2026-01-01T00:00:00.000Z",
          "- 2026-10-09T15:52+08:00 · change · author=elon · a misplaced comment-shaped line",
        ].join("\n"),
      }),
    });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the card imports");
      assert.equal(stats.sessions, 1, "only the real session is kept");
      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.deepEqual(board.repos.sessions.listByTask(task.id).map((session) => session.seg), ["seg1"]);
      assert.deepEqual(task.meta.import_warnings, ["parse_tolerated"], "the tolerated lines are recorded");
    } finally {
      board.close();
    }
  });

  it("does not abort a card on a malformed `- seg:x` session line", async () => {
    const board = await boardWithCards({ "A.md": cardText({}, { Sessions: "- seg:x" }) });
    try {
      const stats = importCards(board);
      assert.equal(stats.tasks, 1, "the malformed line no longer sinks the card");
      assert.equal(stats.sessions, 0);
      const task = board.repos.tasks.getByIdentifier("demo", "DEMO-0001");
      assert.deepEqual(task.meta.import_warnings, ["parse_tolerated"]);
    } finally {
      board.close();
    }
  });
});
