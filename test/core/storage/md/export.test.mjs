/**
 * The markdown exporter: file layout, the canonical card, and the status word.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createCommands, createContext } from "../../../../src/core/commands/index.mjs";
import { exportMd, renderCard } from "../../../../src/core/storage/md/export.mjs";
import { createRepositories } from "../../../../src/core/storage/repositories/index.mjs";
import { TS, cleanupTempDirs, createTempBoard, makeTempDir } from "../../../helpers/sqlite-fixture.mjs";

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

  it("renders a task with nothing in it as a card with six empty sections", async () => {
    const board = await createTempBoard();
    const repos = createRepositories(board.db);
    try {
      repos.projects.create({ id: "proj", name: "P", now: TS });
      const ctx = createContext({ db: board.db, repos, clock: () => TS });
      createCommands(ctx).createTask({ projectId: "proj", title: "Bare", actor: { kind: "agent", id: "linus" } });
      const card = renderCard(repos.tasks.getByIdentifier("proj", "PROJ-0001"), { repos });
      for (const name of ["Background", "Acceptance", "Progress", "Comments", "Sessions", "Report"]) {
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
});

