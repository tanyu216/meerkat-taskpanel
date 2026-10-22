/**
 * The loop's card brief on disk.
 *
 * Every case stubs the CLI (`run`) and asserts the filesystem contract: one
 * atomic `card.md`, no temp left behind, the previous brief preserved on
 * failure, and the queue-to-event mapping used by the subscriber.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  activeCards,
  exportCardFile,
  identifiersForEvent,
  refreshCardsForIds,
} from "../../scripts/loop/card-file.mjs";
import { enqueueCard } from "../../scripts/loop/queue.mjs";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-card-file-"));
  dirs.push(dir);
  return dir;
}

/** A stub CLI that writes the requested markdown to its `--out` path. */
function writingRun(content, calls = []) {
  return (opts, agent, args) => {
    calls.push({ agent, args });
    const out = args[args.indexOf("--out") + 1];
    writeFileSync(out, typeof content === "function" ? content(args) : content, "utf8");
    return { ok: true };
  };
}

describe("card-file — exportCardFile", () => {
  it("exports through the CLI and atomically lands card.md", () => {
    const target = tempDir();
    const calls = [];
    const outcome = exportCardFile({
      opts: { cli: "/taskctl", host: "claude" },
      agent: "alice",
      targetDir: target,
      identifier: "PROJ-0007",
      run: writingRun("# Card\n", calls),
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.path, join(target, ".meerkat", "PROJ-0007", "card.md"));
    assert.equal(readFileSync(outcome.path, "utf8"), "# Card\n");
    assert.deepEqual(calls[0].args.slice(0, 4), ["export", "md", "PROJ-0007", "--out"]);
    assert.ok(calls[0].args[4].endsWith(".tmp.md"), "the CLI writes a temp .md file");
    assert.deepEqual(readdirSync(join(target, ".meerkat", "PROJ-0007")), ["card.md"], "no temp survives");
  });

  it("bypasses the growth guard by exporting to a fresh temp file", () => {
    const target = tempDir();
    const cardDir = join(target, ".meerkat", "PROJ-0007");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "old\n");

    const outcome = exportCardFile({
      opts: {},
      agent: "alice",
      targetDir: target,
      identifier: "PROJ-0007",
      run: writingRun("x".repeat(1000)),
    });

    assert.equal(outcome.ok, true);
    assert.equal(readFileSync(join(cardDir, "card.md"), "utf8").length, 1000);
  });

  it("reports unchanged content without replacing the file", () => {
    const target = tempDir();
    const cardDir = join(target, ".meerkat", "PROJ-0007");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "# Card\n");

    const outcome = exportCardFile({
      opts: {},
      agent: "alice",
      targetDir: target,
      identifier: "PROJ-0007",
      run: writingRun("# Card\n"),
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.unchanged, true);
    assert.deepEqual(readdirSync(cardDir), ["card.md"]);
  });

  it("keeps the previous brief when the CLI fails", () => {
    const target = tempDir();
    const cardDir = join(target, ".meerkat", "PROJ-0007");
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(cardDir, "card.md"), "previous\n");

    const outcome = exportCardFile({
      opts: {},
      agent: "alice",
      targetDir: target,
      identifier: "PROJ-0007",
      run: () => ({ ok: false, error: "board down" }),
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /board down/);
    assert.equal(readFileSync(join(cardDir, "card.md"), "utf8"), "previous\n");
    assert.deepEqual(readdirSync(cardDir), ["card.md"]);
  });

  it("treats a silent success with no file as a failure", () => {
    const target = tempDir();
    const outcome = exportCardFile({
      opts: {},
      agent: "alice",
      targetDir: target,
      identifier: "PROJ-0007",
      run: () => ({ ok: true }),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /wrote no file/);
    assert.equal(existsSync(join(target, ".meerkat", "PROJ-0007", "card.md")), false);
  });

  it("refuses a relative target directory before doing any I/O", () => {
    const outcome = exportCardFile({
      opts: {},
      agent: "alice",
      targetDir: "relative/dir",
      identifier: "PROJ-0007",
      run: () => ({ ok: true }),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /not absolute/);
  });
});

describe("card-file — queue/event mapping", () => {
  it("keeps only active rows and names a review's original", () => {
    const rows = [
      { card: "T-1", status: "pending", review_of: null },
      { card: "T-2", status: "processing", review_of: "T-1" },
      { card: "T-3", status: "done", review_of: null },
      { card: "T-4", status: "failed", review_of: null },
    ];
    assert.deepEqual(activeCards(rows), [
      { identifier: "T-1", reviewOf: null },
      { identifier: "T-2", reviewOf: "T-1" },
    ]);
  });

  it("maps an event UUID to its card and the review's original", () => {
    const rows = [
      { card: "T-1", status: "processing", task_id: "uuid-1" },
      { card: "T-2", status: "pending", task_id: "uuid-2", review_of: "T-1" },
    ];
    assert.deepEqual(identifiersForEvent({ task_id: "uuid-2" }, rows), ["T-2", "T-1"]);
    assert.deepEqual(identifiersForEvent({ task_id: "uuid-1" }, rows), ["T-1"]);
    assert.deepEqual(identifiersForEvent({ task_id: "uuid-9" }, rows), []);
    assert.deepEqual(identifiersForEvent({}, rows), []);
    assert.deepEqual(
      identifiersForEvent({ task_id: "uuid-1" }, [{ card: "T-1", status: "done", task_id: "uuid-1" }]),
      [],
      "a terminal row is not refreshed",
    );
  });

  it("batch-refreshes the active cards an event names, logging failures", () => {
    const stateDir = tempDir();
    const target = tempDir();
    enqueueCard(stateDir, {
      card: "T-2",
      agent: "alice",
      target_dir: target,
      task_id: "uuid-2",
      review_of: "T-1",
      status: "pending",
    });

    const calls = [];
    const logs = [];
    const outcome = refreshCardsForIds({
      opts: { agents: ["alice"] },
      stateDir,
      taskIds: ["uuid-2", "uuid-unknown"],
      run: writingRun("# Card\n", calls),
      log: (line) => logs.push(line),
    });

    assert.deepEqual(outcome, { refreshed: 2, failed: 0 });
    assert.deepEqual(calls.map((call) => call.args[2]).sort(), ["T-1", "T-2"]);
    assert.equal(logs.some((line) => line.includes("wrote")), true);
  });

  it("does nothing without a state directory or task ids", () => {
    assert.deepEqual(
      refreshCardsForIds({ opts: {}, stateDir: null, taskIds: ["uuid-1"] }),
      { refreshed: 0, failed: 0 },
    );
    assert.deepEqual(
      refreshCardsForIds({ opts: {}, stateDir: tempDir(), taskIds: [] }),
      { refreshed: 0, failed: 0 },
    );
  });
});
