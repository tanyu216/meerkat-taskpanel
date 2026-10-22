/**
 * The markdown exporter: file layout, the canonical card, and its sections.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../../src/core/commands/index.mjs";
import { exportMd, renderCard } from "../../../../src/core/storage/md/export.mjs";
import { createRepositories } from "../../../../src/core/storage/repositories/index.mjs";
import {
  TS,
  cleanupTempDirs,
  createTempBoard,
  makeTempDir,
} from "../../../helpers/sqlite-fixture.mjs";

after(cleanupTempDirs);

describe("md/export — rendering", () => {
  it("writes one file per task, including archived ones, with a stable name", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      commands.createProject({ id: "proj", name: "P", actor: { kind: "human", id: "T" } });
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

  it("renders a task with nothing in it as a card with five empty sections", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      createCommands(ctx).createTask({ projectId: "proj", title: "Bare", actor: { kind: "agent", id: "linus" } });
      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      for (const name of ["Background", "Acceptance", "Comments", "Sessions", "Report"]) {
        assert.match(card, new RegExp(`^## ${name}$`, "m"), name);
      }
      assert.match(card, /^assignee: ""$/m);
      assert.match(card, /^created_by: ""$/m);
    } finally {
      board.close();
    }
  });

  it("writes a session's goal into the Sessions section, escaped to one field", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const task = createCommands(ctx).createTask({
        projectId: "proj",
        title: "With a session",
        actor: { kind: "agent", id: "linus" },
      });
      repos.sessions.upsertByNaturalKey({
        taskId: task.id,
        seg: "s1",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "sid",
        goal: "fix a · b",
        status: "running",
        ts: TS,
      });
      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /goal:fix a \\u00b7 b/, "the separator is escaped, not written raw");
      assert.match(card, /^## Sessions$/m);
    } finally {
      board.close();
    }
  });

  it("writes the canonical status even when the card stored a legacy word", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      createCommands(ctx).createTask({
        projectId: "proj",
        title: "Legacy",
        meta: { legacy_status: "ready" },
        actor: { kind: "agent", id: "linus" },
      });

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /^status: todo$/m);
      assert.doesNotMatch(card, /^status: ready$/m);
    } finally {
      board.close();
    }
  });

  it("renders modern acceptance as plain bullets, preferring it over the imported checkboxes", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      createCommands(ctx).createTask({
        projectId: "proj",
        title: "Modern acceptance",
        meta: {
          acceptance: ["cli works", "gate visible"],
          acceptance_legacy: [{ text: "old checkbox", checked: true }],
        },
        actor: { kind: "agent", id: "linus" },
      });

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /^## Acceptance$/m);
      assert.match(card, /^- cli works$/m);
      assert.match(card, /^- gate visible$/m);
      assert.doesNotMatch(card, /^- \[[ x]\] cli works$/m, "no invented checkbox state");
      assert.doesNotMatch(card, /^- \[x\] old checkbox$/m, "the modern list wins; legacy is not merged");
    } finally {
      board.close();
    }
  });

  it("freezes an imported checkbox list into the baseline, dropping the checkbox state", async () => {
    // 0032 — the imported list seeds the snapshot at creation. A tick on an
    // imported card is the author's intent, never this delivery's evidence, so
    // the canonical card carries the texts as plain bullets.
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      createCommands(ctx).createTask({
        projectId: "proj",
        title: "Imported acceptance",
        meta: {
          acceptance_legacy: [
            { text: "done thing", checked: true },
            { text: "open thing", checked: false },
          ],
        },
        actor: { kind: "agent", id: "linus" },
      });

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /^- done thing$/m);
      assert.match(card, /^- open thing$/m);
      assert.doesNotMatch(card, /^- \[[ x]\]/, "no invented checkbox state");
      assert.doesNotMatch(card, /seed; no frozen baseline/, "the snapshot is the baseline");
    } finally {
      board.close();
    }
  });

  it("renders an Attachments section only when the card has attachments", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const task = createCommands(ctx).createTask({
        projectId: "proj",
        title: "With a file",
        actor: { kind: "agent", id: "linus" },
      });

      const without = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.doesNotMatch(without, /^## Attachments$/m);

      repos.attachments.insert({
        taskId: task.id,
        filename: "notes.txt",
        contentType: "text/plain",
        size: 5,
        kind: "attachment",
        createdAt: TS,
      });

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /^## Attachments$/m);
      assert.match(card, /filename:notes\.txt/);
      assert.ok(card.indexOf("## Sessions") < card.indexOf("## Attachments"));
      assert.ok(card.indexOf("## Attachments") < card.indexOf("## Report"));
    } finally {
      board.close();
    }
  });

  it("does not render a Progress section, even when historical progress rows exist", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const task = createCommands(ctx).createTask({
        projectId: "proj",
        title: "With progress",
        actor: { kind: "agent", id: "linus" },
      });
      repos.activities.append({
        taskId: task.id,
        actorKind: "system",
        actorId: "md-import",
        event: "progress",
        changes: { line: "started the schema" },
        createdAt: TS,
      });

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.doesNotMatch(card, /^## Progress$/m);
      assert.doesNotMatch(card, /started the schema/);
    } finally {
      board.close();
    }
  });
});


describe("md/export — 0031 review decision", () => {
  it("emits review_required: yes only when the card requires review", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      commands.createProject({
        id: "req",
        name: "Required",
        reviewPolicy: "required",
        actor: { kind: "human", id: "T" },
      });
      const required = commands.createTask({
        projectId: "req",
        title: "Reviewed",
        actor: { kind: "agent", id: "linus" },
      });
      commands.createProject({ id: "proj", name: "P", actor: { kind: "human", id: "T" } });
      const plain = commands.createTask({
        projectId: "proj",
        title: "Plain",
        actor: { kind: "agent", id: "linus" },
      });

      assert.match(renderCard(required, { repos }), /^review_required: yes$/m);
      assert.doesNotMatch(renderCard(plain, { repos }), /^review_required:/m);
    } finally {
      board.close();
    }
  });
});

describe("md/export — 0032 snapshot and workflow facts", () => {
  async function withBoard(fn) {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      return await fn({ board, repos, commands });
    } finally {
      board.close();
    }
  }

  it("writes meta.target, falling back to the legacy bag, and nothing when unset", async () => {
    await withBoard(({ repos, commands }) => {
      commands.createTask({
        projectId: "proj",
        title: "Modern target",
        meta: { target: "repo-a" },
        actor: { kind: "agent", id: "linus" },
      });
      commands.createTask({
        projectId: "proj",
        title: "Legacy target",
        meta: { legacy: { target: "repo-b" } },
        actor: { kind: "agent", id: "linus" },
      });
      commands.createTask({
        projectId: "proj",
        title: "No target",
        actor: { kind: "agent", id: "linus" },
      });

      assert.match(renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos }), /^target: repo-a$/m);
      assert.match(renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0002"), { repos }), /^target: repo-b$/m);
      assert.doesNotMatch(renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0003"), { repos }), /^target:/m);
    });
  });

  it("prefers the frozen snapshot over a later meta edit, and marks a meta-only list as a seed", async () => {
    await withBoard(({ board, repos, commands }) => {
      const task = commands.createTask({
        projectId: "proj",
        title: "Frozen",
        meta: { acceptance: ["from meta"] },
        actor: { kind: "agent", id: "linus" },
      });
      // A raw meta edit is exactly what the command layer refuses (`--meta
      // acceptance` is frozen); the renderer still has to pick the snapshot.
      board.db
        .prepare("UPDATE tasks SET meta_json = json_set(meta_json, '$.acceptance', json(?)) WHERE id = ?")
        .run(JSON.stringify(["rewritten in meta"]), task.id);

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /^- from meta$/m);
      assert.doesNotMatch(card, /rewritten in meta/);
      assert.doesNotMatch(card, /seed; no frozen baseline/);

      // A grandfathered card (snapshot empty, meta list present) still renders
      // its list — but says the baseline was never frozen.
      commands.createTask({
        projectId: "proj",
        title: "Grandfathered",
        actor: { kind: "agent", id: "linus" },
      });
      const old = repos.tasks.getByIdentifier("proj", "PROJ-0002");
      board.db
        .prepare("UPDATE tasks SET meta_json = json_set(meta_json, '$.acceptance', json(?)) WHERE id = ?")
        .run(JSON.stringify(["seed only"]), old.id);

      const seeded = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0002"), { repos });
      assert.match(seeded, /^- seed only$/m);
      assert.match(seeded, /_\(seed; no frozen baseline\)_/);
      assert.doesNotMatch(seeded, /^acceptance_revision:/m, "0 is not worth a key");
    });
  });

  it("writes delivery/review/waiver/archive facts and the workflow meta only when set", async () => {
    await withBoard(({ board, repos, commands }) => {
      const original = commands.createTask({
        projectId: "proj",
        title: "Original",
        meta: { acceptance: ["a", "b"] },
        actor: { kind: "agent", id: "linus" },
      });
      commands.claim({ id: original.id, actor: { kind: "agent", id: "linus" } });
      commands.deliver({
        taskId: original.id,
        report: {
          conclusion: "Delivered.",
          acceptance: [
            { text: "a", status: "met" },
            { text: "b", status: "met" },
          ],
          evidence: [{ kind: "commit", sha: "dcd7d15" }],
          author: { kind: "agent", id: "linus" },
        },
        actor: { kind: "agent", id: "linus" },
      });
      commands.createTask({
        projectId: "proj",
        title: "Review",
        allowDup: true,
        reviewOf: original.identifier,
        reviewRound: 1,
        actor: { kind: "agent", id: "linus" },
      });
      commands.createTask({
        projectId: "proj",
        title: "Bare",
        actor: { kind: "agent", id: "linus" },
      });
      const bare = repos.tasks.getByIdentifier("proj", "PROJ-0003");
      commands.moveStatus({ id: bare.id, to: "canceled", actor: { kind: "human", id: "T" } });
      repos.tasks.archive({ id: bare.id, now: TS });
      // The waiver columns and workflow meta normally arrive through commands; a
      // raw write keeps this a pure rendering test.
      board.db
        .prepare(
          `UPDATE tasks SET delivery_round = 2, awaiting_reason = 'E2',
             report_waiver_round = 1, report_waiver_reason = 'no report exists yet',
             report_waived_at = ?,
             meta_json = json_set(meta_json,
               '$.accepted_by', 'T', '$.auto_accepted', 'yes',
               '$.review_verdict', 'APPROVE', '$.rework_round', 2, '$.flow', 'auto')
           WHERE id = ?`,
        )
        .run(TS, bare.id);

      const review = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0002"), { repos });
      assert.match(review, /^review_of: PROJ-0001$/m, "the identifier, not the internal id");
      assert.match(review, /^review_round: "1"$/m);

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0003"), { repos });
      assert.match(card, /^delivery_round: "2"$/m);
      assert.match(card, /^awaiting_reason: E2$/m);
      assert.match(card, /^report_waiver_round: "1"$/m);
      assert.match(card, /^report_waiver_reason: no report exists yet$/m);
      assert.match(card, /^report_waived_at: /m);
      assert.match(card, /^archived_at: /m);
      assert.match(card, /^accepted_by: T$/m);
      assert.match(card, /^auto_accepted: yes$/m);
      assert.match(card, /^review_verdict: APPROVE$/m);
      assert.match(card, /^rework_round: "2"$/m);
      assert.match(card, /^flow: auto$/m);

      const plain = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      for (const key of [
        "delivery_round",
        "awaiting_reason",
        "review_of",
        "review_round",
        "report_waiver_round",
        "report_waived_at",
        "archived_at",
        "accepted_by",
        "auto_accepted",
        "review_verdict",
        "rework_round",
        "flow",
      ]) {
        assert.doesNotMatch(plain, new RegExp(`^${key}:`, "m"), `${key} must not grow a bare card`);
      }
      assert.match(plain, /^acceptance_revision: "1"$/m);
    });
  });
});

describe("md/export — 0033 rollups", () => {
  it("marks a rollup report and keeps each child's ref, and marks an imported row", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    const agent = { kind: "agent", id: "linus" };
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      const commands = createCommands(ctx);
      const epic = commands.createTask({ projectId: "proj", title: "Epic", kind: "epic", actor: agent });
      const child = commands.createTask({ projectId: "proj", title: "Child", allowDup: true, actor: agent });
      commands.addRelation({ type: "parent", source: epic.id, target: child.id, actor: agent });

      commands.claim({ id: child.id, actor: agent });
      commands.deliver({
        taskId: child.id,
        report: {
          conclusion: "Child delivered.",
          acceptance: [{ text: "child works", status: "met" }],
          evidence: [{ kind: "commit", sha: "dcd7d15" }],
          author: agent,
        },
        actor: agent,
      });
      commands.moveStatus({ id: child.id, to: "done", actor: agent });
      assert.equal(commands.getTask({ id: epic.id }).status, "in_review", "the board rolled up");

      // An imported narrative on the same epic is history, and says so.
      const authorId = board.db
        .prepare("SELECT id FROM actors WHERE normalized_name = ?")
        .get("linus").id;
      board.db
        .prepare(
          `INSERT INTO task_reports(task_id, round, conclusion, acceptance_json, evidence_json,
                                    author_kind, author_id, created_at, origin, is_rollup)
           VALUES (?, 2, ?, '[]', '[]', 'agent', ?, ?, 'import', 0)`,
        )
        .run(epic.id, "An imported narrative.", authorId, TS);

      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      assert.match(card, /^rollup: yes$/m);
      assert.match(card, new RegExp(`^- \\[met\\] ${child.identifier} Child \\(done\\) · ref: ${child.identifier}$`, "m"));
      assert.match(card, /^origin: import$/m);
      assert.match(card, /An imported narrative\./);

      // A plain card's report never grows the marker.
      const plain = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0002"), { repos });
      assert.doesNotMatch(plain, /^rollup: yes$/m);
    } finally {
      board.close();
    }
  });
});
