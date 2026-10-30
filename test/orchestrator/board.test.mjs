/**
 * `readBoard` — the one board read behind the deterministic passes.
 *
 * It is a small contract on purpose: one `issue list` for the whole board, a
 * `truncated` flag so a caller never mistakes a capped read for a complete one,
 * and the failure message on the result rather than only in the caller's log.
 * The console and the doctor build on it, so the shape is asserted here.
 *
 * The board is a sentinel CLI: no database, and every assertion is about the
 * call the loop makes and what it hands back.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { boardRefusal, readBoard } from "../../src/orchestrator/board.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tp-board-read-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const noopLog = () => {};

/**
 * A stand-in `taskctl` that records what it was called with and answers the
 * read with `tasks` (or with a failure envelope).
 */
function sentinel(dir, { tasks = [], fail = false } = {}) {
  const record = join(dir, "record.json");
  const script = join(dir, "sentinel-cli.mjs");
  const answer = fail
    ? 'process.stdout.write(JSON.stringify({ ok: false, error: { message: "board down" } }));'
    : `process.stdout.write(JSON.stringify({ ok: true, data: { tasks: ${JSON.stringify(tasks)} } }));`;
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  noAutostart: process.env.TASKD_NO_AUTOSTART ?? null,",
      "  token: process.env.TASKD_TOKEN ?? null,",
      "}));",
      answer,
    ].join("\n"),
  );
  return { script, record };
}

function optsFor(script, overrides = {}) {
  return {
    cli: script,
    actorKind: "claude",
    agents: ["alice"],
    boardLimit: 50,
    envFile: null,
    url: null,
    token: null,
    ...overrides,
  };
}

describe("loop/readBoard — one read, and the shape callers rely on", () => {
  it("returns the tasks and reads the whole board in one call", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir, {
      tasks: [
        { identifier: "T-1", status: "in_progress" },
        { identifier: "T-2", status: "in_review" },
      ],
    });

    const result = readBoard(optsFor(script), noopLog);

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.data.tasks.map((task) => task.identifier),
      ["T-1", "T-2"],
    );
    assert.equal(result.truncated, false);
    const calls = JSON.parse(readFileSync(record, "utf8")).argv;
    assert.deepEqual(
      calls.slice(calls.indexOf("issue")),
      ["issue", "list", "--limit", "50"],
      "one read, no status filter: the caller filters the same snapshot",
    );
  });

  it("marks a read that filled the limit as truncated", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, {
      tasks: [
        { identifier: "T-1", status: "todo" },
        { identifier: "T-2", status: "todo" },
      ],
    });

    const result = readBoard(optsFor(script, { boardLimit: 2 }), noopLog);

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true, "a full page may have cut cards off");
  });

  it("carries the failure message on the result, not only into the log", () => {
    const dir = tempDir();
    const { script } = sentinel(dir, { fail: true });

    const result = readBoard(optsFor(script), noopLog);

    assert.equal(result.ok, false);
    assert.equal(result.error, "board down");
  });

  it("lets the caller forbid autostart, without the token losing to it", () => {
    const dir = tempDir();
    const { script, record } = sentinel(dir, { tasks: [] });

    readBoard(
      optsFor(script, {
        token: "td_from_opts",
        cliEnv: { TASKD_NO_AUTOSTART: "1", TASKD_TOKEN: "from_cli_env" },
      }),
      noopLog,
    );

    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(seen.noAutostart, "1", "the child must not be allowed to start a board");
    assert.equal(seen.token, "td_from_opts", "the real token still wins over the injected env");
  });
});

describe("boardRefusal — the code survives the seam", () => {
  it("keeps the board's code, details and hint beside the readable message", () => {
    assert.deepEqual(
      boardRefusal({
        ok: false,
        error: "PROJ-0001: 1 blocking",
        code: "ACCEPTANCE_INCOMPLETE",
        details: { blocking: [{ text: "b", status: "partial" }] },
        hint: { fix: "REJECT instead" },
      }),
      {
        ok: false,
        error: "PROJ-0001: 1 blocking",
        code: "ACCEPTANCE_INCOMPLETE",
        details: { blocking: [{ text: "b", status: "partial" }] },
        hint: { fix: "REJECT instead" },
      },
      "the executor classifies on `code`; a message alone is not enough",
    );
  });

  it("passes a success through untouched, and adds nothing to a bare failure", () => {
    assert.deepEqual(boardRefusal({ ok: true }), { ok: true });
    assert.deepEqual(boardRefusal({ ok: false, error: "exit 1" }), { ok: false, error: "exit 1" });
  });
});
