/**
 * Step 15: `export md` (A1).
 *
 * Two properties are the whole contract:
 *
 *   * the cards land on disk with the identifiers as file names, and what the
 *     service rendered is what was written — byte for byte;
 *   * `--check` writes nothing and exits **3** when something is stale. Three is
 *     not an error code: it is how a CI job says "the cards need re-exporting"
 *     without pretending the tool crashed.
 *
 * The goldens under `test/fixtures/md/golden/**` are the byte-equality oracle
 * (`test/contract/md-golden.test.mjs` renders the same cards through the core
 * exporter); here the oracle is "the file the CLI wrote equals the markdown the
 * service returned".
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test, { after, describe, it } from "node:test";

import {
  assertGrowthGuard,
  createWatchScheduler,
  planTargets,
  watchPath,
} from "../../src/cli/commands/export.mjs";
import { run as runCliInProcess } from "../../src/cli/index.mjs";
import { cleanupTempDirs, dataOf, errorOf, makeTempDir, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

const servers = [];
after(() => {
  for (const server of servers) server.closeAllConnections?.();
  for (const server of servers) server.close();
});

/** Every line must be one complete JSON object. */
function records(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** An in-process fake board: /meta, POST /api/v1/export and a finite SSE stream. */
function fakeBoard(options = {}) {
  const {
    cards = [{ identifier: "DEMO-0001", task_id: "uuid-1" }],
    initial = "v1",
    refreshed = "v2",
    initialStatus = "todo",
    refreshedStatus = "todo",
    statusFor = null,
    frames = [],
    refreshError = null,
    shutdown = null,
    holdOpen = false,
  } = options;
  const byTask = new Map(cards.map((card) => [card.task_id, card.identifier]));
  const byIdentifier = new Map(cards.map((card) => [card.identifier, card.task_id]));
  const calls = { exports: [], events: 0, meta: 0 };
  let phase = "initial";

  const handler = async (req, res) => {
    if (req.method === "GET" && req.url === "/meta") {
      calls.meta += 1;
      return sendJson(res, 200, { ok: true, data: { revision: 0 } });
    }
    if (req.method === "POST" && req.url === "/api/v1/export") {
      const { ref } = await readJson(req);
      calls.exports.push(ref);
      const identifier = byIdentifier.has(ref) ? ref : byTask.get(ref);
      if (identifier === undefined) {
        return sendJson(res, 404, {
          ok: false,
          error: { code: "NOT_FOUND", message: "no such card", http: 404 },
        });
      }
      if (phase === "refresh" && refreshError !== null) {
        return sendJson(res, 404, { ok: false, error: refreshError });
      }
      const taskId = byIdentifier.get(identifier);
      const status = typeof statusFor === "function"
        ? statusFor({ identifier, taskId, phase })
        : (phase === "initial" ? initialStatus : refreshedStatus);
      return sendJson(res, 200, {
        ok: true,
        data: {
          cards: [
            {
              identifier,
              task_id: taskId,
              status,
              markdown: phase === "initial" ? initial : refreshed,
            },
          ],
        },
      });
    }
    if (req.method === "GET" && req.url.startsWith("/api/v1/events")) {
      calls.events += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Send the headers before a frame so a held-open stream still resolves
      // the client's fetch (the TTL test has no frames at all).
      res.flushHeaders?.();
      for (const frame of frames) res.write(`id: 1\ndata: ${JSON.stringify(frame)}\n\n`);
      if (shutdown !== null) {
        res.write(`event: shutdown\ndata: ${JSON.stringify(shutdown)}\n\n`);
      }
      phase = "refresh";
      if (!holdOpen) res.end();
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "no route", http: 404 } });
  };

  return { handler, calls };
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${server.address().port}`;
}

async function invokeWatch(args) {
  let stdout = "";
  let stderr = "";
  const exit = await runCliInProcess(
    // These legs exercise the direct-SSE implementation; the hub path has its
    // own suite. `--standalone` is the documented fallback and the oracle.
    ["export", "watch", "--standalone", ...args, "--actor-kind", "claude", "--agent", "tester"],
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: {},
    },
  );
  return { exit, stdout, stderr };
}

/** A manual clock and timer queue, so the coalescer is deterministic. */
function fakeClock() {
  let now = 0;
  let nextHandle = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const handle = ++nextHandle;
      timers.set(handle, { at: now + Math.max(0, ms), fn });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    pending() {
      return timers.size;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function boardWithTwo(fn) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "First", "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Second", "--json"]);
    return fn(ctx);
  });
}

describe("cli/export", () => {
  it("writes one card per identifier, byte-identical to what the service rendered", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "cards");
      const result = run(["export", "md", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.equal(data.cards, 2);
      assert.deepEqual(data.identifiers, ["DEMO-0001", "DEMO-0002"]);

      const first = readFileSync(join(out, "DEMO-0001.md"), "utf8");
      assert.match(first, /^---\n/);
      assert.match(first, /id: DEMO-0001/);
      assert.match(first, /title: First/);

      // Human output says where things went.
      assert.match(run(["export", "md", "--out", out]).stdout, /wrote 2 card\(s\) to/);
    });
  });

  it("accepts the card's own spelling, `export --md`", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "cards");
      const result = run(["export", "--md", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).cards, 2);
    });
  });

  it("--check reports 0 when the cards are current, and 3 when they are not", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "cards");

      // Nothing exported yet: every card is missing.
      const missing = run(["export", "md", "--out", out, "--check", "--json"]);
      assert.equal(missing.status, 3, missing.stderr);
      assert.equal(dataOf(missing).up_to_date, false);
      assert.deepEqual(dataOf(missing).missing, ["DEMO-0001", "DEMO-0002"]);

      run(["export", "md", "--out", out, "--json"]);
      const current = run(["export", "md", "--out", out, "--check", "--json"]);
      assert.equal(current.status, 0, current.stderr);
      assert.equal(dataOf(current).up_to_date, true);

      // Tamper with one card: it is now stale, and `--check` does not fix it.
      writeFileSync(join(out, "DEMO-0002.md"), "stale\n");
      const stale = run(["export", "md", "--out", out, "--check", "--json"]);
      assert.equal(stale.status, 3);
      assert.deepEqual(dataOf(stale).differing, ["DEMO-0002"]);
      assert.match(stale.stderr, /warning: 1 card\(s\) are not up to date/);
      assert.equal(readFileSync(join(out, "DEMO-0002.md"), "utf8"), "stale\n", "--check writes nothing");
    });
  });

  it("limits the export to one project", async () => {
    await withCli(async ({ run, dataDir }) => {
      run(["project", "create", "--id", "one", "--name", "One", "--json"]);
      run(["project", "create", "--id", "two", "--name", "Two", "--json"]);
      run(["issue", "create", "--project", "one", "--title", "Only", "--json"]);
      run(["issue", "create", "--project", "two", "--title", "Other", "--json"]);

      const out = join(dataDir, "cards");
      const result = run(["export", "md", "--project", "one", "--out", out, "--json"]);
      assert.deepEqual(dataOf(result).identifiers, ["ONE-0001"]);
    });
  });
});

describe("cli/export — one card, one file", () => {
  it("writes only the named card into a directory", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "single");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).cards, 1);
      assert.deepEqual(dataOf(result).identifiers, ["DEMO-0002"]);
      assert.equal(existsSync(join(out, "DEMO-0002.md")), true);
      assert.equal(existsSync(join(out, "DEMO-0001.md")), false);
      assert.match(run(["export", "md", "DEMO-0002", "--out", out]).stdout, /wrote 1 card\(s\) to/);
    });
  });

  it("writes one file when --out names a .md path", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "one.md");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(dataOf(result).identifiers, ["DEMO-0002"]);
      assert.equal(dataOf(result).out, out);
      assert.match(readFileSync(out, "utf8"), /id: DEMO-0002/);
      assert.equal(existsSync(join(dataDir, "DEMO-0002.md")), false);
      assert.match(run(["export", "md", "DEMO-0002", "--out", out]).stdout, /wrote DEMO-0002 to/);
    });
  });

  it("treats an existing .md directory as a directory, and a .MD path as a file", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const asDir = join(dataDir, "cards.md");
      mkdirSync(asDir, { recursive: true });
      assert.equal(run(["export", "md", "DEMO-0002", "--out", asDir, "--json"]).status, 0);
      assert.equal(existsSync(join(asDir, "DEMO-0002.md")), true);

      const asFile = join(dataDir, "UPPER.MD");
      assert.equal(run(["export", "md", "DEMO-0002", "--out", asFile, "--json"]).status, 0);
      assert.match(readFileSync(asFile, "utf8"), /id: DEMO-0002/);
    });
  });

  it("treats --out .md as a directory when no card is named", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "bundle.md");
      const result = run(["export", "md", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(dataOf(result).cards, 2);
      assert.equal(statSync(out).isDirectory(), true);
      assert.equal(existsSync(join(out, "DEMO-0001.md")), true);
      assert.equal(existsSync(join(out, "DEMO-0002.md")), true);
    });
  });

  it("refuses --project with a card ref before touching the board", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "never");
      const result = run(["export", "md", "DEMO-0001", "--project", "demo", "--out", out, "--json"]);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(errorOf(result).code, "CLI_USAGE");
      assert.equal(existsSync(out), false);
    });
  });

  it("checks only the named card", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "check-one");
      const missing = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(missing.status, 3);
      assert.deepEqual(dataOf(missing).missing, ["DEMO-0002"]);

      run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]).status, 0);

      writeFileSync(join(out, "DEMO-0002.md"), "stale\n");
      const stale = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(stale.status, 3);
      assert.deepEqual(dataOf(stale).differing, ["DEMO-0002"]);
      assert.equal(readFileSync(join(out, "DEMO-0002.md"), "utf8"), "stale\n");
      assert.equal(existsSync(join(out, "DEMO-0001.md")), false, "the other card is not checked or written");
    });
  });

  it("checks a single-file target", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "check-one.md");
      assert.equal(run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]).status, 3);
      run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]).status, 0);

      writeFileSync(out, "stale\n");
      const stale = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(stale.status, 3);
      assert.deepEqual(dataOf(stale).differing, ["DEMO-0002"]);
      assert.equal(readFileSync(out, "utf8"), "stale\n");
    });
  });

  it("refuses a single-file target whose parent is missing, for write and check", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "missing", "one.md");
      for (const extra of [[], ["--check"]]) {
        const result = run(["export", "md", "DEMO-0002", "--out", out, ...extra, "--json"]);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(errorOf(result).code, "CLI_USAGE");
      }
      assert.equal(existsSync(join(dataDir, "missing")), false);
    });
  });

  it("keeps the dir-mode --check missing-directory behaviour at exit 3", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "absent");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--check", "--json"]);
      assert.equal(result.status, 3);
      assert.deepEqual(dataOf(result).missing, ["DEMO-0002"]);
      assert.equal(existsSync(out), false);
    });
  });

  it("guards an existing file against a >4x rewrite, in both target shapes", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const file = join(dataDir, "guarded.md");
      writeFileSync(file, "x");
      const fileResult = run(["export", "md", "DEMO-0001", "--out", file, "--json"]);
      assert.equal(fileResult.status, 1, fileResult.stderr);
      assert.equal(errorOf(fileResult).code, "MD_GROWTH_GUARD");
      assert.equal(readFileSync(file, "utf8"), "x");

      const dir = join(dataDir, "guarded-dir");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "DEMO-0001.md"), "x");
      const dirResult = run(["export", "md", "DEMO-0001", "--out", dir, "--json"]);
      assert.equal(dirResult.status, 1);
      assert.equal(errorOf(dirResult).code, "MD_GROWTH_GUARD");
      assert.equal(readFileSync(join(dir, "DEMO-0001.md"), "utf8"), "x");
    });
  });

  it("guards the whole-board export too", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(dataDir, "guarded-all");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "DEMO-0001.md"), "x");
      const result = run(["export", "md", "--out", out, "--json"]);
      assert.equal(result.status, 1);
      assert.equal(errorOf(result).code, "MD_GROWTH_GUARD");
      assert.equal(readFileSync(join(out, "DEMO-0001.md"), "utf8"), "x");
    });
  });

  it("exports the attachment list in the card body", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const dir = makeTempDir();
      const file = join(dir, "notes.txt");
      writeFileSync(file, "hello", "utf8");
      run(["attachment", "add", "DEMO-0002", "--file", file, "--json"]);

      const out = join(dataDir, "with-attachment");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const card = readFileSync(join(out, "DEMO-0002.md"), "utf8");
      assert.match(card, /^## Attachments$/m);
      assert.match(card, /filename:notes\.txt/);
      assert.equal(existsSync(join(out, "DEMO-0001.md")), false);
    });
  });

  it("exports an archived card by ref", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      run(["issue", "move", "DEMO-0002", "canceled", "--json"]);
      run(["issue", "archive", "DEMO-0002", "--days", "0", "--json"]);
      const out = join(dataDir, "archived");
      const result = run(["export", "md", "DEMO-0002", "--out", out, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(out, "DEMO-0002.md"), "utf8"), /id: DEMO-0002/);
    });
  });

  it("plans targets as a pure function, refusing a multi-card file target", () => {
    const card = { identifier: "DEMO-0001", markdown: "x" };
    assert.deepEqual(planTargets([card], { fileMode: true, out: "one.md" }), [
      { card, path: "one.md" },
    ]);
    assert.deepEqual(planTargets([card], { fileMode: false, out: "cards" }), [
      { card, path: join("cards", "DEMO-0001.md") },
    ]);
    assert.throws(
      () => planTargets([card, card], { fileMode: true, out: "one.md" }),
      (err) => err.code === "CLI_IO",
    );
  });

  it("guard helper: exactly 4x passes, above it refuses, an empty file passes", () => {
    const dir = makeTempDir();
    const file = join(dir, "card.md");
    writeFileSync(file, "a".repeat(10));
    assert.doesNotThrow(() => assertGrowthGuard(file, "b".repeat(40)));
    assert.throws(() => assertGrowthGuard(file, "b".repeat(41)), (err) => err.code === "MD_GROWTH_GUARD");
    writeFileSync(file, "");
    assert.doesNotThrow(() => assertGrowthGuard(file, "b".repeat(1000)));
    assert.doesNotThrow(() => assertGrowthGuard(join(dir, "absent.md"), "b".repeat(1000)));
  });
});

describe("cli/export watch — one pass", () => {
  it("--once writes .meerkat/<ID>/card.md byte-identically, then reports no change", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const projectDir = makeTempDir();
      const oracleDir = join(dataDir, "oracle");
      run(["export", "md", "DEMO-0001", "--out", oracleDir, "--json"]);
      const oracle = readFileSync(join(oracleDir, "DEMO-0001.md"), "utf8");

      const first = run(["export", "watch", "DEMO-0001", "--dir", projectDir, "--once", "--json"]);
      assert.equal(first.status, 0, first.stderr);
      const lines = records(first.stdout);
      assert.deepEqual(lines[0], { type: "open" });
      assert.equal(lines[1].type, "refresh");
      assert.equal(lines[1].identifier, "DEMO-0001");
      assert.equal(lines[1].changed, true);
      assert.deepEqual(lines.at(-1), { type: "eof" });

      const card = join(projectDir, ".meerkat", "DEMO-0001", "card.md");
      assert.equal(watchPath(projectDir, "DEMO-0001"), card);
      assert.equal(readFileSync(card, "utf8"), oracle);

      const second = run(["export", "watch", "DEMO-0001", "--dir", projectDir, "--once", "--json"]);
      assert.equal(second.status, 0, second.stderr);
      const again = records(second.stdout).find((line) => line.type === "refresh");
      assert.equal(again.changed, false);
    });
  });

  it("defaults --dir to cwd, and accepts repeated --ref", async () => {
    await boardWithTwo(async ({ run }) => {
      const projectDir = makeTempDir();
      const result = run(
        ["export", "watch", "--ref", "DEMO-0001", "--ref", "DEMO-0002", "--once", "--json"],
        { cwd: projectDir },
      );
      assert.equal(result.status, 0, result.stderr);
      const refreshed = records(result.stdout).filter((line) => line.type === "refresh");
      assert.deepEqual(refreshed.map((line) => line.identifier).sort(), ["DEMO-0001", "DEMO-0002"]);
      assert.equal(existsSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md")), true);
      assert.equal(existsSync(join(projectDir, ".meerkat", "DEMO-0002", "card.md")), true);
    });
  });

  it("writes an explicit --out file, creating its parent", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const out = join(makeTempDir(), "nested", "card.md");
      const oracleDir = join(dataDir, "oracle");
      run(["export", "md", "DEMO-0001", "--out", oracleDir, "--json"]);
      const oracle = readFileSync(join(oracleDir, "DEMO-0001.md"), "utf8");

      const first = run(["export", "watch", "DEMO-0001", "--out", out, "--once", "--json"]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(readFileSync(out, "utf8"), oracle);

      const second = run(["export", "watch", "DEMO-0001", "--out", out, "--once", "--json"]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(records(second.stdout).find((line) => line.type === "refresh").changed, false);
    });
  });

  it("refreshes a brief that would trip the 4x growth guard", async () => {
    await boardWithTwo(async ({ run, dataDir }) => {
      const projectDir = makeTempDir();
      const oracleDir = join(dataDir, "oracle");
      run(["export", "md", "DEMO-0001", "--out", oracleDir, "--json"]);
      const oracle = readFileSync(join(oracleDir, "DEMO-0001.md"), "utf8");

      const dir = join(projectDir, ".meerkat", "DEMO-0001");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "card.md"), "x");

      const result = run(["export", "watch", "DEMO-0001", "--dir", projectDir, "--once", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(dir, "card.md"), "utf8"), oracle);
    });
  });

  it("a bad ref fails before open, as one error envelope, and writes nothing", async () => {
    const projectDir = makeTempDir();
    const { handler } = fakeBoard({ cards: [] });
    const url = await serve(handler);
    const result = await invokeWatch(["NOPE", "--dir", projectDir, "--url", url, "--json"]);
    assert.equal(result.exit, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, "NOT_FOUND");
    assert.equal(result.stdout.includes('"type":"open"'), false);
    assert.equal(existsSync(join(projectDir, ".meerkat")), false);
  });

  it("refuses a missing ref, a non-integer --idle, and a missing --dir", async () => {
    const url = "http://127.0.0.1:1";
    const cases = [
      ["--dir", makeTempDir(), "--url", url],
      ["DEMO-0001", "--idle", "1.5", "--url", url],
      ["DEMO-0001", "--dir", join(makeTempDir(), "missing"), "--url", url],
      ["DEMO-0001", "--out", join(makeTempDir(), "card.md"), "--dir", makeTempDir(), "--url", url],
      ["--ref", "DEMO-0001", "--ref", "DEMO-0002", "--out", join(makeTempDir(), "card.md"), "--url", url],
    ];
    for (const args of cases) {
      const result = await invokeWatch([...args, "--json"]);
      assert.equal(result.exit, 2, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).error.code, "CLI_USAGE");
      assert.equal(result.stdout.includes('"type":"open"'), false);
    }
  });
});

describe("cli/export watch — stream", () => {
  it("refreshes the watched card when its task_id changes", async () => {
    const projectDir = makeTempDir();
    const { handler, calls } = fakeBoard({
      initial: "v1",
      refreshed: "v2",
      frames: [{ event: "comment_added", task_id: "uuid-1" }],
    });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v2");
    assert.deepEqual(calls.exports, ["DEMO-0001", "uuid-1"]);
    const lines = records(result.stdout);
    assert.deepEqual(lines.at(-1), { type: "eof" });
    // A live card's refresh record carries the status it saw.
    assert.equal(lines.find((line) => line.type === "refresh").status, "todo");
  });

  it("leaves the card alone for an unrelated task_id", async () => {
    const projectDir = makeTempDir();
    const { handler, calls } = fakeBoard({
      initial: "v1",
      refreshed: "v2",
      frames: [{ event: "comment_added", task_id: "uuid-other" }],
    });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(calls.exports, ["DEMO-0001"]);
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v1");
    assert.deepEqual(records(result.stdout).at(-1), { type: "eof" });
  });

  it("refreshes every watched card on a task-less (project-level) event", async () => {
    const projectDir = makeTempDir();
    const cards = [
      { identifier: "DEMO-0001", task_id: "uuid-1" },
      { identifier: "DEMO-0002", task_id: "uuid-2" },
    ];
    const { handler, calls } = fakeBoard({
      cards,
      initial: "v1",
      refreshed: "v2",
      frames: [{ event: "project_updated", task_id: null }],
    });
    const url = await serve(handler);

    const result = await invokeWatch([
      "--ref", "DEMO-0001", "--ref", "DEMO-0002", "--dir", projectDir, "--url", url,
    ]);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(calls.exports.length, 4);
    for (const card of cards) {
      assert.equal(readFileSync(join(projectDir, ".meerkat", card.identifier, "card.md"), "utf8"), "v2");
    }
  });

  it("ends with a shutdown line and exits 0 when the server leaves", async () => {
    const projectDir = makeTempDir();
    const { handler } = fakeBoard({ shutdown: { reason: "server_shutdown" } });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(records(result.stdout).at(-1), {
      type: "shutdown",
      data: { reason: "server_shutdown" },
    });
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v1");
  });

  it("keeps the old brief and reports a non-fatal refresh failure", async () => {
    const projectDir = makeTempDir();
    const { handler } = fakeBoard({
      frames: [{ event: "comment_added", task_id: "uuid-1" }],
      refreshError: { code: "NOT_FOUND", message: "gone", http: 404 },
    });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    const lines = records(result.stdout);
    const failure = lines.find((line) => line.type === "refresh" && line.error !== undefined);
    assert.equal(failure.error.code, "NOT_FOUND");
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v1");
    assert.deepEqual(lines.at(-1), { type: "eof" });
  });

  it("ends the standalone watch when the card reaches canceled", async () => {
    const projectDir = makeTempDir();
    const { handler } = fakeBoard({
      initial: "v1",
      refreshed: "v2",
      frames: [{ event: "card_moved", task_id: "uuid-1" }],
      statusFor: ({ phase }) => (phase === "initial" ? "todo" : "canceled"),
    });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v2");
    assert.deepEqual(records(result.stdout).at(-1), { type: "done" });
  });

  it("does not open a stream when the card is already done", async () => {
    const projectDir = makeTempDir();
    const { handler, calls } = fakeBoard({ initialStatus: "done" });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    const lines = records(result.stdout);
    assert.deepEqual(lines.map((line) => line.type), ["open", "refresh", "done"]);
    assert.equal(lines[1].status, "done");
    assert.equal(calls.events, 0);
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v1");
  });

  it("stops itself when the watched card reaches done", async () => {
    const projectDir = makeTempDir();
    const { handler, calls } = fakeBoard({
      initialStatus: "todo",
      refreshedStatus: "done",
      frames: [{ event: "task_moved", task_id: "uuid-1", changes: { to: "done" } }],
      holdOpen: true,
    });
    const url = await serve(handler);

    const result = await invokeWatch(["DEMO-0001", "--dir", projectDir, "--url", url]);
    assert.equal(result.exit, 0, result.stderr);
    const lines = records(result.stdout);
    assert.deepEqual(lines.at(-1), { type: "done" });
    assert.equal(lines.filter((line) => line.type === "refresh").at(-1).status, "done");
    assert.equal(calls.events, 1);
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v2");
  });

  it("stops itself after --ttl and reports ttl", async () => {
    const projectDir = makeTempDir();
    const { handler } = fakeBoard({ holdOpen: true });
    const url = await serve(handler);

    const result = await invokeWatch([
      "DEMO-0001", "--dir", projectDir, "--url", url, "--ttl", "50",
    ]);
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(records(result.stdout).at(-1), { type: "ttl", data: { ttl_ms: 50 } });
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v1");
  });

  it("stops only after every watched card is done", async () => {
    const projectDir = makeTempDir();
    const cards = [
      { identifier: "DEMO-0001", task_id: "uuid-1" },
      { identifier: "DEMO-0002", task_id: "uuid-2" },
    ];
    const { handler, calls } = fakeBoard({
      cards,
      initial: "v1",
      refreshed: "v2",
      statusFor: ({ taskId, phase }) => {
        if (taskId === "uuid-1") return "done"; // already done at startup
        return phase === "initial" ? "todo" : "done";
      },
      frames: [{ event: "comment_added", task_id: "uuid-2" }],
      holdOpen: true,
    });
    const url = await serve(handler);

    const result = await invokeWatch([
      "--ref", "DEMO-0001", "--ref", "DEMO-0002", "--dir", projectDir, "--url", url,
    ]);
    assert.equal(result.exit, 0, result.stderr);
    const lines = records(result.stdout);
    assert.deepEqual(lines.at(-1), { type: "done" });
    assert.deepEqual(
      lines.filter((line) => line.type === "refresh").map((line) => [line.identifier, line.status]),
      [["DEMO-0001", "done"], ["DEMO-0002", "todo"], ["DEMO-0002", "done"]],
    );
    assert.equal(calls.events, 1);
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0001", "card.md"), "utf8"), "v1");
    assert.equal(readFileSync(join(projectDir, ".meerkat", "DEMO-0002", "card.md"), "utf8"), "v2");
  });
});

describe("cli/export watch — scheduler", () => {
  it("coalesces a burst, serializes batches, and schedules the next one", async () => {
    const clock = fakeClock();
    const batches = [];
    let release = null;
    const scheduler = createWatchScheduler({
      refresh: (batch) => {
        batches.push(batch);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("a");
    scheduler.notify("b");
    clock.advance(300);
    await flush();
    assert.equal(batches.length, 1);
    assert.deepEqual([...batches[0].taskIds].sort(), ["a", "b"]);

    scheduler.notify("c");
    clock.advance(5_000);
    await flush();
    assert.equal(batches.length, 1, "no second batch while the first is in flight");

    release();
    await flush();
    // The floor is measured from the *finish* of the previous batch.
    clock.advance(5_000);
    await flush();
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1].taskIds, ["c"]);

    release();
    await flush();
    await scheduler.stop();
  });

  it("stop() drains a pending batch without waiting for the timer", async () => {
    const clock = fakeClock();
    const batches = [];
    const scheduler = createWatchScheduler({
      refresh: async (batch) => {
        batches.push(batch);
      },
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("a");
    assert.equal(clock.pending(), 1);
    await scheduler.stop();
    await flush();
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].taskIds, ["a"]);
    assert.equal(clock.pending(), 0);
  });
});
