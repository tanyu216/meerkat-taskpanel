/**
 * Steps 16/18: the importer's statistics and failure modes, the exporter's
 * rendering, and the `migrate-cli` runner (F6).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import { exportMd, renderCard } from "../../../../src/core/storage/md/export.mjs";
import { importMd, parseCard } from "../../../../src/core/storage/md/import.mjs";
import { LEGACY_TO_CORE_STATUS, statusForImport } from "../../../../src/core/storage/md/legacy-status.mjs";
import { defaultIo, main, parseArgs } from "../../../../src/core/storage/md/migrate-cli.mjs";
import { createRepositories } from "../../../../src/core/storage/repositories/index.mjs";
import { createContext, createCommands } from "../../../../src/core/commands/index.mjs";
import {
  TS,
  cleanupTempDirs,
  countRows,
  createTempBoard,
  makeTempDir,
  reasonCode,
} from "../../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

const FIXTURES = join(import.meta.dirname, "../../../fixtures/md");

/** A card, minimal but valid, with `overrides` merged into the frontmatter. */
function cardText(overrides = {}, sections = {}) {
  const front = {
    id: "PROJ-0001",
    title: "A card",
    status: "todo",
    priority: "medium",
    project: "proj",
    target: "/tmp/task-panel-fixture",
    created_by: "Elon",
    created_at: TS,
    ...overrides,
  };
  const body = Object.entries({ Background: "text", Acceptance: "- [ ] one", ...sections })
    .map(([name, text]) => `## ${name}\n\n${text}\n`)
    .join("\n");
  return `---\n${Object.entries(front)
    .map(([key, value]) => `${key}: ${typeof value === "string" && value.includes(": ") ? JSON.stringify(value) : value}`)
    .join("\n")}\n---\n${body}`;
}

/** A board plus a directory holding one card. */
async function boardWithCards(cards) {
  const board = await createTempBoard();
  board.repos = createRepositories(board.db);
  board.dir = join(makeTempDir("md-cards-"), "cards");
  mkdirSync(board.dir, { recursive: true });
  for (const [name, text] of Object.entries(cards)) writeFileSync(join(board.dir, name), text, "utf8");
  return board;
}

describe("md/import — statistics and behaviour", () => {
  it("counts what it wrote, and writes nothing in check mode", async () => {
    const board = await boardWithCards({
      "PROJ-0001.md": cardText({}, { Comments: "- 2026-10-08T00:00:00.000Z · note · linus — hi" }),
    });
    try {
      const checked = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS, check: true });
      assert.equal(checked.check, true);
      assert.equal(checked.cards, 1);
      assert.equal(checked.tasks, 0);
      assert.equal(countRows(board.db, "tasks"), 0, "check writes nothing");

      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.deepEqual(
        { files: stats.files, cards: stats.cards, tasks: stats.tasks, comments: stats.comments, activities: stats.activities, relations: stats.relations, reports: stats.reports, sessions: stats.sessions },
        { files: 1, cards: 1, tasks: 1, comments: 1, activities: 0, relations: 0, reports: 0, sessions: 0 },
      );
      assert.equal(stats.warnings.length, 0);
    } finally {
      board.close();
    }
  });

  it("registers a card's labels, counting one use per card and keeping first-seen spelling", async () => {
    const board = await boardWithCards({
      "PROJ-0001.md": cardText({ labels: "[Bug, core]" }),
      "PROJ-0002.md": cardText({ id: "PROJ-0002", labels: "[bug]" }),
    });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.labels, 3, "one registration per label name across the cards");

      const bug = board.repos.labels.getByNorm("proj", "bug");
      assert.equal(bug.displayName, "Bug", "the first card's spelling wins");
      assert.equal(bug.useCount, 2, "both cards name it");
      assert.equal(countRows(board.db, "labels"), 2, "Bug and core, not three");
      assert.ok(bug.color.length > 0);

      // The imported task stores the registry's display names, so an export is
      // byte-stable against the original card.
      assert.deepEqual(board.repos.tasks.getByIdentifier("proj", "PROJ-0001").labels, ["Bug", "core"]);
      assert.deepEqual(board.repos.tasks.getByIdentifier("proj", "PROJ-0002").labels, ["Bug"]);
    } finally {
      board.close();
    }
  });

  it("moves the use count when a re-import drops a label", async () => {
    const board = await boardWithCards({ "PROJ-0001.md": cardText({ labels: "[Bug, ui]" }) });
    try {
      importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(board.repos.labels.getByNorm("proj", "ui").useCount, 1);

      writeFileSync(join(board.dir, "PROJ-0001.md"), cardText({ labels: "[Bug]" }), "utf8");
      importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS, resume: true });

      assert.equal(board.repos.labels.getByNorm("proj", "ui").useCount, 0, "the dropped label is released");
      assert.equal(board.repos.labels.getByNorm("proj", "bug").useCount, 1, "the kept one is not double-counted");
    } finally {
      board.close();
    }
  });

  it("warns — but does not quietly bless — an in_review card with no report", async () => {
    const board = await boardWithCards({
      "PROJ-0001.md": cardText({ status: "in_review" }, { Report: "" }),
    });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.warnings.length, 1);
      assert.match(stats.warnings[0], /no ## Report/);
      const task = board.repos.tasks.getByIdentifier("proj", "PROJ-0001");
      assert.equal(task.status, "in_review");
      assert.deepEqual(task.meta.import_warnings, ["report_missing"]);
      assert.equal(countRows(board.db, "task_reports"), 0, "the gate is not satisfied by the import");
    } finally {
      board.close();
    }
  });

  it("refuses a card with no id, no title, an unknown status or two targets", async () => {
    assert.throws(() => parseCard(cardText({ id: '""' }), { file: "a.md" }), (err) => {
      assert.equal(err.code, "MD_PARSE_ERROR");
      assert.match(err.message, /needs an 'id'/);
      return true;
    });
    assert.throws(() => parseCard(cardText({ title: '""' }), { file: "a.md" }), (err) => /needs a 'title'/.test(err.message));

    const other = await boardWithCards({ "A.md": cardText({ status: "shipped" }) });
    try {
      assert.equal(reasonCode(() => importMd({ db: other.db, repos: other.repos, dir: other.dir, now: TS })), "MD_PARSE_ERROR");
    } finally {
      other.close();
    }

    const twoTargets = await boardWithCards({
      "A.md": cardText({ id: "PROJ-0001", target: "/tmp/a" }),
      "B.md": cardText({ id: "PROJ-0002", target: "/tmp/b" }),
    });
    try {
      assert.equal(
        reasonCode(() => importMd({ db: twoTargets.db, repos: twoTargets.repos, dir: twoTargets.dir, now: TS })),
        "MD_PARSE_ERROR",
        "one project cannot have two workspace paths",
      );
      assert.equal(countRows(twoTargets.db, "tasks"), 0, "a hard error leaves nothing behind");
    } finally {
      twoTargets.close();
    }
  });

  it("needs a project id and a workspace path to build a board from nothing", async () => {
    const board = await boardWithCards({ "A.md": cardText({ project: null }, {}).replace("project: null\n", "") });
    try {
      assert.equal(reasonCode(() => importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS })), "MD_PARSE_ERROR");
    } finally {
      board.close();
    }

    const noTarget = await boardWithCards({ "A.md": cardText({ target: null }).replace("target: null\n", "") });
    try {
      assert.equal(reasonCode(() => importMd({ db: noTarget.db, repos: noTarget.repos, dir: noTarget.dir, now: TS })), "MD_PARSE_ERROR");
      // ...but an existing project is enough.
      noTarget.repos.projects.create({ id: "proj", name: "proj", workspacePath: "/tmp/task-panel-fixture", now: TS });
      assert.equal(importMd({ db: noTarget.db, repos: noTarget.repos, dir: noTarget.dir, now: TS }).tasks, 1);
    } finally {
      noTarget.close();
    }
  });

  it("resolves the project from --project when the card has none", async () => {
    const board = await boardWithCards({ "A.md": cardText({ project: null }).replace("project: null\n", "") });
    try {
      const stats = importMd({
        db: board.db,
        repos: board.repos,
        dir: board.dir,
        now: TS,
        projectId: "imported",
        target: "/tmp/task-panel-fixture",
      });
      assert.equal(stats.tasks, 1);
      assert.equal(board.repos.tasks.getByIdentifier("imported", "PROJ-0001").projectId, "imported");
    } finally {
      board.close();
    }
  });

  it("warns about a depends_on it could not resolve instead of inventing a task", async () => {
    const board = await boardWithCards({
      "A.md": cardText({ depends_on: "[PROJ-9999]" }),
    });
    try {
      const stats = importMd({ db: board.db, repos: board.repos, dir: board.dir, now: TS });
      assert.equal(stats.relations, 0);
      assert.equal(stats.warnings.length, 1);
      assert.match(stats.warnings[0], /PROJ-9999/);
    } finally {
      board.close();
    }
  });
});

describe("md/legacy-status", () => {
  it("maps the two v1 words and refuses anything else", () => {
    assert.deepEqual(statusForImport("ready"), { status: "todo", legacyStatus: "ready" });
    assert.deepEqual(statusForImport("failed"), { status: "canceled", legacyStatus: "failed" });
    assert.deepEqual(statusForImport("done"), { status: "done", legacyStatus: null });
    assert.deepEqual(Object.keys(LEGACY_TO_CORE_STATUS).includes("ready"), true);
    assert.throws(() => statusForImport("shipped"), (err) => {
      assert.equal(err.code, "MD_PARSE_ERROR");
      assert.deepEqual(err.details.aliases, ["ready", "failed", "cancelled", "in-review", "in-progress"]);
      return true;
    });
  });
});

describe("md/export — rendering", () => {
  it("writes one file per task, including archived ones, with a stable name", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      commands.createProject({ id: "proj", name: "P", workspacePath: "/tmp/ws", actor: { kind: "human", id: "T" } });
      commands.createTask({ projectId: "proj", title: "One", actor: { kind: "agent", id: "linus" } });
      commands.createTask({ projectId: "proj", title: "Two", actor: { kind: "agent", id: "linus" } });

      const out = join(makeTempDir("md-exp-"), "cards");
      const result = exportMd({ repos, outDir: out, now: TS });
      assert.deepEqual(result.files.map((f) => f.identifier), ["PROJ-0001", "PROJ-0002"]);
      assert.equal(readFileSync(join(out, "PROJ-0001.md"), "utf8").startsWith("---\nid: PROJ-0001\n"), true);

      const dry = exportMd({ repos, outDir: join(makeTempDir("md-dry-"), "cards"), now: TS, dryRun: true });
      assert.equal(dry.files[0].content.includes("id: PROJ-0001"), true);
    } finally {
      board.close();
    }
  });

  it("renders a task with nothing in it as a card with six empty sections", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", workspacePath: "/tmp/ws", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      createCommands(ctx).createTask({ projectId: "proj", title: "Bare", actor: { kind: "agent", id: "linus" } });
      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), {
        repos,
        project: repos.projects.get("proj"),
      });
      for (const name of ["Background", "Acceptance", "Progress", "Comments", "Sessions", "Report"]) {
        assert.match(card, new RegExp(`^## ${name}$`, "m"), name);
      }
      assert.match(card, /^assignee: ""$/m);
      assert.match(card, /^created_by: ""$/m);
    } finally {
      board.close();
    }
  });
});

describe("md/migrate-cli — argument handling (F6)", () => {
  it("parses the flags it documents and refuses the rest", () => {
    assert.deepEqual(parseArgs(["check", "--dir", "x", "--json"]), {
      command: "check",
      json: true,
      resume: false,
      dir: "x",
    });
    assert.equal(parseArgs(["import", "--resume"]).resume, true);
    assert.throws(() => parseArgs(["check", "--dir"]), (err) => err.code === "VALIDATION_FAILED");
    assert.throws(() => parseArgs(["check", "--nope"]), (err) => /unknown option/.test(err.message));
    assert.throws(() => parseArgs(["check", "extra"]), (err) => /unexpected argument/.test(err.message));
    assert.equal(parseArgs([]).command, null);
    assert.equal(parseArgs(["--help"]).help, true);
  });

  it("checks the fixture directory and exits 0 with an empty difference list", async () => {
    let out = "";
    const code = await main(["check", "--dir", FIXTURES, "--json"], { stdout: (t) => (out += t) });
    assert.equal(code, 0);
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.deepEqual(report.differences, []);
    assert.equal(report.cards.length, 6);
  });

  it("imports into a database, reports progress, and can export it back", async () => {
    const dir = join(makeTempDir("md-cli-"), "cards");
    const dbPath = join(makeTempDir("md-cli-db-"), "board.sqlite");
    let out = "";
    const io = { stdout: (t) => (out += t), stderr: (t) => (out += t) };

    assert.equal(
      await main(["import", "--dir", FIXTURES, "--db", dbPath, "--json"], io),
      0,
      out,
    );
    const imported = JSON.parse(out);
    assert.equal(imported.ok, true);
    assert.equal(imported.tasks, 6);
    assert.equal(imported.db, dbPath);

    out = "";
    assert.equal(await main(["import", "--dir", FIXTURES, "--db", dbPath], io), 0);
    assert.match(out, /0 new, 0 updated, 6 unchanged/);

    const outDir = join(makeTempDir("md-cli-out-"), "cards");
    out = "";
    assert.equal(await main(["export", "--db", dbPath, "--out", outDir, "--json"], io), 0);
    assert.equal(JSON.parse(out).count, 6);
    assert.equal(readFileSync(join(outDir, "PROJ-0001.md"), "utf8"), readFileSync(join(FIXTURES, "golden/PROJ-0001.md"), "utf8"));

    out = "";
    assert.equal(await main(["check", "--dir", FIXTURES, "--db", dbPath, "--json"], io), 0);
    const checked = JSON.parse(out);
    assert.deepEqual(checked.differences, []);
    assert.equal(checked.cards.every((card) => card.imported), true);
  });

  it("prints something a human wants to read when --json is absent", async () => {
    const dir = join(makeTempDir("md-human-"), "cards");
    const dbPath = join(makeTempDir("md-human-db-"), "board.sqlite");
    let out = "";
    const io = { stdout: (t) => (out += t), stderr: (t) => (out += t) };

    assert.equal(await main(["import", "--dir", FIXTURES, "--db", dbPath], io), 0);
    assert.match(out, /imported 6 new, 0 updated, 0 unchanged from 6 file\(s\)/);
    assert.match(out, /comments \d+ · sessions \d+ · reports \d+ · relations \d+ · activities \d+/);

    const outDir = join(makeTempDir("md-human-out-"), "cards");
    out = "";
    assert.equal(await main(["export", "--db", dbPath, "--out", outDir], io), 0);
    assert.match(out, /exported 6 card\(s\) to /);
    assert.equal(readdirSync(outDir).length, 6);

    // --dry-run reports without writing.
    const dryDir = join(makeTempDir("md-human-dry-"), "cards");
    out = "";
    assert.equal(await main(["export", "--db", dbPath, "--out", dryDir, "--dry-run"], io), 0);
    assert.equal(existsSync(dryDir), false, "a dry run creates nothing");

    out = "";
    assert.equal(await main(["check", "--dir", FIXTURES], io), 0);
    assert.match(out, /checked 6 card\(s\): 6 parsed/);

    // A warning is reported but does not fail the run.
    const warned = join(makeTempDir("md-warn-"), "cards");
    mkdirSync(warned, { recursive: true });
    writeFileSync(join(warned, "A.md"), cardText({ status: "done" }, { Report: "" }), "utf8");
    out = "";
    assert.equal(await main(["check", "--dir", warned], io), 0);
    assert.match(out, /warning: .*no ## Report/);

    // A card that does not parse is a difference, and differences exit 3.
    const broken = join(makeTempDir("md-broken-"), "cards");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "B.md"), "not a card at all\n", "utf8");
    out = "";
    assert.equal(await main(["check", "--dir", broken], io), 3);
    assert.match(out, /difference: B.md/);

    // The default IO is real stdio; touching it must not throw.
    const real = defaultIo();
    real.stdout("");
    real.stderr("");

    // A human-readable failure goes to stderr with its code.
    out = "";
    // Always with an explicit --db: the *default* database is the real
    // `.data/board.sqlite`, and a test must never create it.
    assert.equal(
      await main(["import", "--dir", join(makeTempDir("md-none-"), "nope"), "--db", join(makeTempDir("md-none-db-"), "b.sqlite")], io),
      1,
    );
    assert.match(out, /no such file|ENOENT/);
  });

  it("fails with a code, not a stack trace", async () => {
    let out = "";
    const io = { stdout: (t) => (out += t), stderr: (t) => (out += t) };
    assert.equal(
      await main(["import", "--dir", join(makeTempDir("md-missing-"), "nope"), "--db", join(makeTempDir("md-missing-db-"), "b.sqlite"), "--json"], io),
      1,
    );
    assert.equal(JSON.parse(out).ok, false);

    out = "";
    assert.equal(await main(["frobnicate"], io), 2);
    assert.match(out, /unknown command/);

    out = "";
    assert.equal(await main(["export", "--json"], io), 2);
    assert.match(out, /--out/);

    out = "";
    assert.equal(await main([], io), 2);
    assert.match(out, /Usage:/);

    out = "";
    assert.equal(await main(["--help"], io), 0);

    // A real difference: a card the board has never seen, checked against it.
    const dbPath = join(makeTempDir("md-cli-db2-"), "board.sqlite");
    assert.equal(await main(["import", "--dir", FIXTURES, "--db", dbPath], io), 0);
    const changed = join(makeTempDir("md-changed-"), "cards");
    mkdirSync(changed, { recursive: true });
    writeFileSync(join(changed, "PROJ-0001.md"), readFileSync(join(FIXTURES, "PROJ-0001.md"), "utf8").replace("M1 core", "M1 core!"), "utf8");
    out = "";
    assert.equal(await main(["check", "--dir", changed, "--db", dbPath, "--json"], io), 3);
    assert.match(JSON.parse(out).differences[0], /out of date/);
  });
});
