#!/usr/bin/env node
/**
 * `loop-soak` — a fault-injection soak for the resident session pool (epic TP-0025).
 *
 * The unit-level suite (`test/orchestrator/resilience.test.mjs`) pins each defect
 * once. This driver is the complement: it runs the **real** pool entry
 * (`taskctl pool`), against a hermetic sandbox and a fake agent CLI, for
 * a configurable duration while injecting the four faults the epic fixes —
 * SIGKILL, EPIPE, an immediately-exiting child, and a slow `taskctl` — and then
 * asserts the three invariants the epic exists to keep:
 *
 *   * **no lost card** — every seeded card is dispatched at least once or is
 *     still a live queue row;
 *   * **no duplicate dispatch** — two agent turns for the same card never
 *     overlap in time (the SIGKILL/restart path is where today's tree violates
 *     this: it redispatches while the orphaned child still runs);
 *   * **loop status healthy and live** — after the last restart, the loop's own
 *     verdict is `running`, or `busy` with a live pid, within the documented
 *     bound. `busy` is a tick in flight, not a failure (TP-0151).
 *
 * A fourth check covers the EPIPE boundary directly: closing the pool's stderr
 * reader must not kill the pool.
 *
 * It is **not** part of `npm run check` or the pre-push gate — it is a manual /
 * nightly acceptance harness. The sandbox uses Node builtins only and never
 * touches a board, a database, or the user's real state directory.
 *
 * Usage:
 *   node scripts/verify/loop-soak.mjs                      # 60s
 *   node scripts/verify/loop-soak.mjs --minutes 10
 *   node scripts/verify/loop-soak.mjs --hours 2
 *   node scripts/verify/loop-soak.mjs --duration 30 --verbose --keep
 *
 * Exit: 0 = every invariant held · 1 = at least one failed · 2 = bad usage.
 *
 * The current tree is expected to FAIL this driver (that is the point of the
 * baseline); each stage of the epic should bring one check green.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { enqueueCard, readCards } from "../../src/orchestrator/queue.mjs";
import { probeSupervisor } from "../../src/orchestrator/status.mjs";
import { healthyStatusVerdict } from "./lib/soak-verdict.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Usage: node scripts/verify/loop-soak.mjs [options]

  --duration <sec>     Total soak duration (default 60)
  --minutes <n>        Duration in minutes (overrides --duration)
  --hours <n>          Duration in hours (overrides --duration/--minutes)
  --turn-ms <ms>       Fake agent turn length (default 6000)
  --linger-ms <ms>     How long an orphaned fake agent lingers (default 1200)
  --slow-cli-ms <ms>   Latency injected into the fake taskctl (default 1200)
  --cards <n>          Initial cards to seed (default 3)
  --control <mode>     external|internal|both residency checks (default both)
  --keep               Keep the sandbox directory (its path is printed)
  --verbose            Echo pool/agent events as they happen
  -h, --help           This text`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    durationSec: 60,
    turnMs: 6000,
    lingerMs: 1200,
    slowCliMs: 1200,
    cards: 3,
    control: "both",
    keep: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };
    switch (name) {
      case "--duration":
        options.durationSec = Number(value());
        break;
      case "--minutes":
        options.durationSec = Number(value()) * 60;
        break;
      case "--hours":
        options.durationSec = Number(value()) * 3600;
        break;
      case "--turn-ms":
        options.turnMs = Number(value());
        break;
      case "--linger-ms":
        options.lingerMs = Number(value());
        break;
      case "--slow-cli-ms":
        options.slowCliMs = Number(value());
        break;
      case "--cards":
        options.cards = Number(value());
        break;
      case "--control":
        options.control = value();
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  const NAMED = {
    durationSec: "--duration / --minutes / --hours",
    turnMs: "--turn-ms",
    lingerMs: "--linger-ms",
    slowCliMs: "--slow-cli-ms",
    cards: "--cards",
  };
  for (const [key, flag] of Object.entries(NAMED)) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`${flag} must be a positive number`);
    }
  }
  if (!["external", "internal", "both"].includes(options.control)) {
    throw new Error("--control must be external, internal or both");
  }
  return options;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------

/**
 * Build a hermetic tree:
 *
 *   <sandbox>/{home}/.claude/skills/{meerkat-director,meerkat}/SKILL.md
 *   <sandbox>/config/.env.claude      (empty per-kind config)
 *   <sandbox>/state/                  the pool's state dir
 *   <sandbox>/repo/                   --repo
 *   <sandbox>/projects/<card>/        one target_dir per card
 *   <sandbox>/bin/claude              the fake agent (stream-json)
 *   <sandbox>/bin/slow-taskctl.mjs    the slow board CLI
 */
function createSandbox(options) {
  const dir = mkdtempSync(join(tmpdir(), "meerkat-loop-soak-"));
  const home = join(dir, "home");
  const config = join(dir, "config");
  const stateDir = join(dir, "state");
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  for (const path of [home, config, stateDir, repo, bin]) mkdirSync(path, { recursive: true });

  for (const skill of ["meerkat-director", "meerkat"]) {
    const skillDir = join(home, ".claude", "skills", skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${skill}\n\nsoak fixture\n`);
  }
  const configFile = join(config, ".env.claude");
  writeFileSync(configFile, "");

  const agentLog = join(dir, "agent.jsonl");
  const cliLog = join(dir, "cli.jsonl");
  const exitOnce = join(dir, "exit-127.once");

  const agentScript = join(bin, "claude");
  writeFileSync(
    agentScript,
    `#!/usr/bin/env node
// The soak's fake agent. Speaks just enough of the stream-json protocol for the
// pool's claude adapter: init, one user event carrying an agentId per card, an
// assistant event, then a result. Its own stdout/errors are guarded because a
// SIGKILLed pool takes the read end with it.
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

const pid = process.pid;
const log = (entry) => appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify(entry) + "\\n");
const turnMs = Number(process.env.FAKE_AGENT_TURN_MS ?? 0);
const lingerMs = Number(process.env.FAKE_AGENT_LINGER_MS ?? 0);
const exitOnce = process.env.FAKE_AGENT_EXIT_ONCE ?? "";
const cards = (text) => [...new Set(String(text).match(/\\bTP-\\d{4}\\b/g) ?? [])];

process.stdout.on("error", () => {});

if (!process.argv.includes("--input-format")) {
  log({ event: "oneshot", pid, at: Date.now(), argv: process.argv.slice(2).map((a) => a.slice(0, 80)) });
  setTimeout(() => process.exit(0), 50);
} else {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-" + pid }) + "\\n");
  const rl = createInterface({ input: process.stdin });
  const open = new Set();
  let turns = 0;
  let stdinClosed = false;
  // A killed pool takes the read end with it. A real agent keeps working on its
  // turn (it cannot tell "my parent died" from "my parent is slow"), so the
  // fake finishes the turn at its normal end and only then exits. A fixed pool
  // terminates the orphan explicitly: SIGTERM closes the interval immediately.
  const abortOpen = () => {
    for (const entry of open) {
      log({ event: "turn_end", pid, at: Date.now(), cards: entry.ids, aborted: true });
    }
    open.clear();
  };
  const maybeExit = () => {
    if (stdinClosed && open.size === 0) {
      setTimeout(() => process.exit(0), Math.max(100, lingerMs));
    }
  };
  process.on("SIGTERM", () => {
    abortOpen();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    abortOpen();
    process.exit(0);
  });
  rl.on("line", (line) => {
    let prompt = "";
    try {
      prompt = JSON.parse(line)?.message?.content ?? "";
    } catch {
      prompt = "";
    }
    if (typeof prompt !== "string") prompt = JSON.stringify(prompt);
    const ids = cards(prompt);
    log({ event: "turn_start", pid, at: Date.now(), cards: ids });
    if (exitOnce !== "" && existsSync(exitOnce)) {
      rmSync(exitOnce, { force: true });
      log({ event: "turn_exit", pid, at: Date.now(), cards: ids, code: 127 });
      process.exit(127);
    }
    const entry = { ids };
    open.add(entry);
    setTimeout(() => {
      open.delete(entry);
      turns += 1;
      for (const card of ids) {
        process.stdout.write(
          JSON.stringify({
            type: "user",
            message: { content: [{ type: "text", text: "agentId: fake-" + pid + "-" + turns + "-" + card }] },
            session_id: "fake-" + pid,
          }) + "\\n",
        );
      }
      process.stdout.write(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "soak ok" }] },
          session_id: "fake-" + pid,
        }) + "\\n",
      );
      process.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "fake-" + pid,
        }) + "\\n",
      );
      log({ event: "turn_end", pid, at: Date.now(), cards: ids });
      maybeExit();
    }, turnMs);
  });
  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });
}
`,
    "utf8",
  );
  chmodSync(agentScript, 0o755);

  const slowCli = join(bin, "slow-taskctl.mjs");
  writeFileSync(
    slowCli,
    `#!/usr/bin/env node
// A taskctl stand-in with injectable latency. The pool calls it synchronously
// (spawnSync), so this sleep blocks the pool's event loop — the "slow CLI"
// fault this soak injects. It answers an issue read as "still in progress".
import { appendFileSync } from "node:fs";

const ms = Number(process.env.FAKE_CLI_MS ?? 0);
appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ at: Date.now(), ms, argv: process.argv.slice(2) }) + "\\n");
if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
process.stdout.write(JSON.stringify({ ok: true, data: { task: { status: "in_progress" } } }) + "\\n");
`,
    "utf8",
  );
  chmodSync(slowCli, 0o755);

  return {
    dir,
    home,
    configFile,
    stateDir,
    repo,
    bin,
    agentLog,
    cliLog,
    exitOnce,
    slowCli,
  };
}

// ---------------------------------------------------------------------------
// the pool process
// ---------------------------------------------------------------------------

function poolArgs(sandbox, control = "external") {
  return [
    join(ROOT, "src", "cli", "index.mjs"),
    "pool",
    "--actor-kind",
    "claude",
    "--agent",
    "soak",
    "--home",
    sandbox.home,
    "--state-dir",
    sandbox.stateDir,
    "--repo",
    sandbox.repo,
    "--config",
    sandbox.configFile,
    "--log",
    join(sandbox.stateDir, "supervisor.log"),
    "--cli",
    sandbox.slowCli,
    ...(control === null ? [] : ["--control", control]),
    "--session-poll-ms",
    "50",
    "--session-turn-timeout",
    "1200",
    "--max-concurrency",
    "2",
    "--project-concurrency",
    "2",
    "--session-pool-max",
    "4",
  ];
}

function poolEnv(sandbox, options) {
  return {
    ...process.env,
    PATH: `${sandbox.bin}:${process.env.PATH ?? ""}`,
    MEERKAT_TASKPANEL_CONFIG_DIR: dirname(sandbox.configFile),
    FAKE_AGENT_LOG: sandbox.agentLog,
    FAKE_AGENT_TURN_MS: String(options.turnMs),
    FAKE_AGENT_LINGER_MS: String(options.lingerMs),
    FAKE_AGENT_EXIT_ONCE: sandbox.exitOnce,
    FAKE_CLI_LOG: sandbox.cliLog,
    FAKE_CLI_MS: String(options.slowCliMs),
  };
}

/** The real `taskctl loop --json`, as an operator would run it. */
function cliStatus(sandbox) {
  const run = spawnSync(
    process.execPath,
    [
      join(ROOT, "src", "cli", "index.mjs"),
      "loop",
      "--json",
      "--actor-kind",
      "claude",
      "--agent",
      "soak",
      "--home",
      sandbox.home,
      "--state-dir",
      sandbox.stateDir,
      "--config",
      sandbox.configFile,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, MEERKAT_TASKPANEL_CONFIG_DIR: dirname(sandbox.configFile) },
    },
  );
  return { exit: run.status, out: run.stdout ?? "", err: run.stderr ?? "" };
}

function statusOf(sandbox) {
  return probeSupervisor(
    {
      actorKind: "claude",
      agents: ["soak"],
      home: sandbox.home,
      state: join(sandbox.stateDir, "supervisor.state.json"),
      sessionState: join(sandbox.stateDir, "sessions.state.json"),
      continueState: join(sandbox.stateDir, "continue.state.json"),
    },
    // Hermetic: no installed units in this sandbox, and never ask the host's.
    { run: () => ({ status: 1, stdout: "", stderr: "", error: null }) },
  );
}

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

/**
 * Turn intervals per card. A turn runs from `turn_start` to `turn_end` /
 * `turn_exit`; a turn whose process died without either is closed at its
 * process's observed death (or `Infinity` if it is somehow still running).
 */
function intervalsByCard(agentLog, deadAt) {
  const cards = new Map();
  const open = new Map(); // `${pid}:${card}` -> {card, start}
  for (const record of agentLog) {
    if (record.event === "turn_start") {
      for (const card of record.cards ?? []) {
        if (!cards.has(card)) cards.set(card, []);
        open.set(`${record.pid}:${card}`, { card, start: record.at, end: null });
      }
    } else if (record.event === "turn_end" || record.event === "turn_exit") {
      for (const card of record.cards ?? []) {
        const entry = open.get(`${record.pid}:${card}`);
        if (entry !== undefined) {
          entry.end = record.at;
          cards.get(card)?.push({ start: entry.start, end: entry.end });
          open.delete(`${record.pid}:${card}`);
        }
      }
    }
  }
  for (const entry of open.values()) {
    if (!cards.has(entry.card)) cards.set(entry.card, []);
    cards.get(entry.card).push({
      start: entry.start,
      end: deadAt.get(entry.pid) ?? Number.POSITIVE_INFINITY,
    });
  }
  for (const intervals of cards.values()) intervals.sort((a, b) => a.start - b.start);
  return cards;
}

function overlappingPairs(intervals) {
  const pairs = [];
  for (let i = 1; i < intervals.length; i += 1) {
    const previous = intervals[i - 1];
    const current = intervals[i];
    if (current.start < previous.end) pairs.push([previous, current]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`loop-soak: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const sandbox = createSandbox(options);
  const failures = [];
  const checks = [];
  const pools = [];
  const deadAt = new Map();
  const seeded = [];
  const say = (line) => process.stdout.write(`loop-soak: ${line}\n`);
  const note = (line) => {
    if (options.verbose) process.stdout.write(`loop-soak: ${line}\n`);
  };
  const fail = (check, detail) => {
    failures.push({ check, detail });
    process.stdout.write(`loop-soak: FAIL ${check} — ${detail}\n`);
  };
  const pass = (check, detail) => {
    checks.push(check);
    process.stdout.write(`loop-soak: ok   ${check}${detail === undefined ? "" : ` — ${detail}`}\n`);
  };

  const env = poolEnv(sandbox, options);
  const faultControl = options.control === "both" ? "external" : options.control;
  const args = poolArgs(sandbox, faultControl);
  let pool = null;

  function startPool() {
    const child = spawn(process.execPath, args, { cwd: sandbox.repo, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => note(String(chunk).trimEnd()));
    child.once("exit", (code, signal) => {
      note(`pool ${child.pid} exited code=${code} signal=${signal}`);
      deadAt.set(child.pid, Date.now());
    });
    pools.push(child);
    pool = child;
    note(`pool started pid ${child.pid}`);
    return child;
  }

  async function waitForVerdict(want, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = statusOf(sandbox);
      if (status.verdict === want) return status;
      await sleep(100);
    }
    return statusOf(sandbox);
  }

  /**
   * Wait for a healthy live verdict: `running`, or `busy` with a live pid. A
   * `starting` phase can still resolve into one, so the wait continues until
   * the deadline; the last status is the evidence either way.
   */
  async function waitForHealthyStatus(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let status = statusOf(sandbox);
    while (!healthyStatusVerdict(status).ok && Date.now() < deadline) {
      await sleep(100);
      status = statusOf(sandbox);
    }
    return status;
  }

  async function poolPid() {
    const state = readJson(join(sandbox.stateDir, "sessions.state.json"));
    const pid = Number(state?.poolPid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  function waitExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolveExit) => {
      let settled = false;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExit({ code, signal });
      };
      const timer = setTimeout(() => finish(null, null), timeoutMs);
      timer.unref?.();
      child.once("exit", finish);
    });
  }

  /**
   * The installed shape, not the take-over shape: start a pool with no cards
   * seeded and prove it is still resident after several poll periods, then that
   * SIGTERM shuts it down cleanly. `control === null` is the default (internal)
   * invocation the service units use.
   */
  async function residencyCheck(control) {
    const label = control === null ? "default" : control;
    const child = spawn(process.execPath, poolArgs(sandbox, control), {
      cwd: sandbox.repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (chunk) => note(String(chunk).trimEnd()));
    try {
      const deadline = Date.now() + 8000;
      let live = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        const state = readJson(join(sandbox.stateDir, "sessions.state.json"));
        if (Number(state?.poolPid) === child.pid && state?.phase === "running") {
          live = true;
          break;
        }
        await sleep(100);
      }
      if (!live) {
        fail(`residency-${label}`, `the pool never reached running (exit ${child.exitCode})`);
        return;
      }
      await sleep(2500);
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(
          `residency-${label}`,
          `the pool exited while idle (code ${child.exitCode}, signal ${child.signalCode})`,
        );
        return;
      }
      const exited = waitExit(child, 10_000);
      child.kill("SIGTERM");
      const outcome = await exited;
      if (outcome.signal !== null || outcome.code !== 0) {
        fail(`residency-${label}`, `SIGTERM gave code ${outcome.code}, signal ${outcome.signal}`);
        return;
      }
      pass(`residency-${label}`, "resident at idle; SIGTERM exit 0");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = waitExit(child, 2000);
        child.kill("SIGKILL");
        await exited;
      }
    }
  }

  function seed(card, cardCount) {
    const projectDir = join(sandbox.dir, "projects", `p${cardCount}`);
    mkdirSync(projectDir, { recursive: true });
    // A retried row forces the pool's board re-read, which is the slow-CLI
    // injection point (spawnSync, so it blocks the pool's event loop).
    enqueueCard(sandbox.stateDir, {
      card,
      role: "worker",
      target_dir: projectDir,
      handoff: `soak handoff for ${card}`,
      attempts: cardCount % 2 === 0 ? 1 : 0,
    });
    seeded.push(card);
  }

  // A long soak must not grow its queue without bound: after the initial batch,
  // only a handful of fault-target cards are added.
  const maxSeeds = options.cards + 6;
  function seedMore() {
    if (seeded.length >= maxSeeds) return;
    seed(`TP-${9000 + seeded.length + 1}`, seeded.length + 1);
  }

  try {
    say(`sandbox ${sandbox.dir} (duration ${options.durationSec}s)`);
    // Residency first, before any card exists: the installed daemon must hold the
    // loop on an empty board. `null` is the default invocation the units use.
    const residencyModes =
      options.control === "both"
        ? [null, "external"]
        : [options.control === "external" ? "external" : null];
    for (const mode of residencyModes) await residencyCheck(mode);

    for (let i = 1; i <= options.cards; i += 1) seed(`TP-${9000 + i}`, i);

    startPool();
    const initial = await waitForVerdict("running", 8000);
    if (initial.verdict !== "running") {
      fail("pool-start", `verdict was ${initial.verdict}, expected running`);
    } else {
      pass("pool-start", `running with pid ${initial.pool.poolPid}`);
    }

    // Let the first batch dispatch, so every later injection has work in flight.
    const firstDispatch = Date.now() + 10_000;
    while (Date.now() < firstDispatch) {
      if (readJsonl(sandbox.agentLog).some((record) => record.event === "turn_start")) break;
      await sleep(100);
    }
    // Land the first SIGKILL in the middle of a turn, not after it finished.
    await sleep(Math.floor(options.turnMs * 0.3));

    const deadline = Date.now() + options.durationSec * 1000;
    let cycle = 0;
    let epipeChecked = false;
    while (Date.now() < deadline) {
      cycle += 1;
      const phase = cycle % 3;

      if (phase === 1) {
        // --- SIGKILL the pool mid-turn, then restart it like the service manager.
        const pid = (await poolPid()) ?? pool?.pid ?? null;
        const before = readJsonl(sandbox.agentLog).filter((record) => record.event === "turn_start").length;
        if (pid !== null && alive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
          deadAt.set(pid, Date.now());
          note(`injected SIGKILL into pool ${pid}`);
        }
        await sleep(300);
        startPool();
        const restarted = await waitForVerdict("running", 8000);
        if (restarted.verdict !== "running") {
          fail("status-running", `after restart the verdict was ${restarted.verdict}`);
        }
        // Give the new pool time to dispatch whatever it decides to dispatch.
        const settle = Date.now() + Math.max(2000, options.turnMs + 1500);
        while (Date.now() < settle) {
          const turns = readJsonl(sandbox.agentLog).filter((record) => record.event === "turn_start").length;
          if (turns > before) break;
          await sleep(100);
        }
      } else if (phase === 2) {
        // --- EPIPE: close the pool's stderr reader and prove the pool survives.
        if (!epipeChecked && pool !== null && pool.exitCode === null) {
          epipeChecked = true;
          const pid = pool.pid;
          try {
            pool.stderr.destroy();
          } catch {
            /* already closed */
          }
          // The pool logs on every dispatch; make sure one is coming.
          seedMore();
          const survived = await (async () => {
            const until = Date.now() + 5000;
            while (Date.now() < until) {
              if (alive(pid) === false) return false;
              await sleep(100);
            }
            return alive(pid);
          })();
          if (survived) pass("epipe-survival", `pool ${pid} survived its closed stderr`);
          else fail("epipe-survival", `pool ${pid} died after its stderr reader closed`);
          // The pool must still be healthy and live after the EPIPE. A card
          // turn in flight (`busy`) is that healthy state, not a failure —
          // demanding exactly `running` here is the same defect the final
          // check had (TP-0151).
          const afterEpipe = healthyStatusVerdict(statusOf(sandbox));
          if (!afterEpipe.ok) {
            fail("status-running", `after EPIPE ${afterEpipe.detail}`);
          }
        }
      } else {
        // --- An immediately-exiting child: the next agent spawn exits 127.
        writeFileSync(sandbox.exitOnce, "once\n");
        seedMore();
        note("armed an immediate (127) agent exit for the next spawn");
        await sleep(Math.max(1500, options.turnMs));
      }

      await sleep(Math.max(500, options.turnMs / 2));
    }

    // --- Final restart if a fault left the pool down, then the status check.
    if (pool === null || pool.exitCode !== null) {
      startPool();
    }
    const finalStatus = await waitForHealthyStatus(10_000);
    const finalJudgement = healthyStatusVerdict(finalStatus);
    if (finalJudgement.ok) {
      pass("status-running", finalJudgement.detail);
    } else {
      fail("status-running", `final ${finalJudgement.detail}`);
    }

    // The operator's spelling of the same question.
    const cli = cliStatus(sandbox);
    if (cli.exit !== 0) {
      fail("cli-status", `taskctl loop exited ${cli.exit}: ${cli.err.trim()}`);
    } else {
      let cliReport = null;
      try {
        cliReport = JSON.parse(cli.out);
      } catch {
        cliReport = null;
      }
      if (cliReport === null) {
        fail("cli-status", `taskctl loop did not emit JSON: ${cli.out.trim().slice(0, 200)}`);
      } else {
        const cliJudgement = healthyStatusVerdict(cliReport);
        if (cliJudgement.ok) {
          pass("cli-status", `taskctl loop reports ${cliJudgement.detail}`);
        } else {
          fail("cli-status", `taskctl loop did not report a healthy live verdict — ${cliJudgement.detail}`);
        }
      }
    }

    // Let the last dispatch settle before judging the queues.
    await sleep(Math.max(1500, options.turnMs + 1000));

    const agentLog = readJsonl(sandbox.agentLog);
    const intervals = intervalsByCard(agentLog, deadAt);

    // --- duplicate dispatch: two turns for one card must never overlap.
    const duplicates = [];
    for (const [card, list] of intervals) {
      const pairs = overlappingPairs(list);
      if (pairs.length > 0) duplicates.push(`${card} (${list.length} turns)`);
    }
    if (duplicates.length === 0) {
      pass("duplicate-dispatch", `${intervals.size} card(s), no overlapping turns`);
    } else {
      fail("duplicate-dispatch", `overlapping turns for ${duplicates.join(", ")}`);
    }

    // --- no lost card: every seeded card was dispatched, or is still queued.
    const queueRows = readCards(sandbox.stateDir).value.cards;
    const queued = new Set(queueRows.map((row) => String(row.card)));
    const dispatched = new Set(intervals.keys());
    const lost = seeded.filter((card) => !dispatched.has(card) && !queued.has(card));
    if (lost.length === 0) {
      pass("lost-card", `${seeded.length} seeded card(s) accounted for`);
    } else {
      fail("lost-card", `no dispatch and no queue row for ${lost.join(", ")}`);
    }
  } finally {
    for (const child of pools) {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    // Orphaned fake agents keep their own pids in the log; stop them too.
    for (const record of readJsonl(sandbox.agentLog)) {
      if (record.event === "turn_start" && alive(record.pid)) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
    if (options.keep) {
      process.stdout.write(`loop-soak: kept sandbox ${sandbox.dir}\n`);
    } else {
      rmSync(sandbox.dir, { recursive: true, force: true });
    }
  }

  const total = checks.length + failures.length;
  process.stdout.write(
    `loop-soak: ${total} check(s) — ${checks.length} ok, ${failures.length} failed ` +
      `(${options.durationSec}s)\n`,
  );
  for (const failure of failures) process.stdout.write(`  - ${failure.check}: ${failure.detail}\n`);
  return failures.length === 0 ? 0 : 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
