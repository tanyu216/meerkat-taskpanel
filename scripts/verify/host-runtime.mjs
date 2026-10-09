#!/usr/bin/env node
/**
 * Host runtime claim-path verification — the offline mock harness.
 *
 * `scripts/verify/profiles.mjs` proves the *install* landed (skill paths, frontmatter,
 * wrapper, detector contract). It never runs what the install *generated*. This probe
 * closes that gap: it drives the generated runtime glue — the Claude SessionStart hook,
 * the Codex claim trigger, and each host's `wake-*.sh` — against **fake host CLIs and a
 * fake `taskctl` shim**, so the "trigger → claim → wake" path is executed and asserted
 * without a real `claude` / `codex` / `pi`, a board, or a network.
 *
 *   node scripts/verify/host-runtime.mjs [--home <dir>] [--host <host>] [--quiet]
 *
 * How it works (all throwaway, never `$HOME`):
 *
 *   1. a temp *prefix* is the install root and the `HOME` of every spawned process;
 *   2. `install.sh --target <host> --prefix <tmp> --agent-name alice --skip-node-check`
 *      generates the real bundle from the real templates;
 *   3. the generated `taskctl` shim is replaced by a *canned* shim (the board boundary),
 *      and fake `claude` / `codex` / `pi` executables are put on `PATH` (the wake
 *      boundary). Both record their argv, so assertions read the *actual* invocation,
 *      never just the exit code;
 *   4. each scenario runs the generated script and asserts exit code + recorded argv +
 *      stdout.
 *
 * Deterministic and offline by construction: no clock, no randomness, no sockets — the
 * only nondeterminism is the temp dir, which `--home` pins for byte-identical re-runs.
 *
 * What is *not* covered here (honest boundary): the real host CLIs' own behaviour (see
 * the supplementary `scripts/verify/host-cli.mjs`, which skips when a CLI is absent) and
 * the real board's claim semantics (`docker/verify-in-container.sh` +
 * `scripts/verify/install-e2e.sh` drive the real `taskctl`/`taskd`). This probe pins the
 * *generated shell glue* between them.
 *
 * Exits 0 only when every assertion passes.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { wakeCommand } from "../../src/shared/scheduling.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** agent name every install is rendered with; the shim / hook must carry it. */
const AGENT = "alice";

/** Host → {dot-dir, has detection of which generated forms exist}. */
const HOSTS = {
  claude: { dir: ".claude", hook: ".claude/hooks/meerkat-taskpanel-session-start.sh", trigger: null, wake: ".claude/bin/wake-claude.sh", shim: ".claude/bin/taskctl", cli: "claude" },
  codex: { dir: ".codex", hook: null, trigger: ".codex/meerkat-taskpanel-claim.sh", wake: ".codex/bin/wake-codex.sh", shim: ".codex/bin/taskctl", cli: "codex" },
  pi: { dir: ".agents", hook: null, trigger: null, wake: ".agents/bin/wake-pi.sh", shim: null, cli: "pi" },
};

/**
 * The canned board shim. Replaces `<home>/<host>/bin/taskctl` after install: it records
 * every argv and answers `issue list` / `issue candidates` from env, so a scenario can
 * put the trigger in front of a held card, a foreign held card, or an empty pool.
 */
const FAKE_SHIM = `#!/usr/bin/env node
// Canned taskctl shim written by scripts/verify/host-runtime.mjs — not the real shim.
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (process.env.FAKE_SHIM_LOG) appendFileSync(process.env.FAKE_SHIM_LOG, JSON.stringify(argv) + "\\n");
const exit = Number(process.env.FAKE_SHIM_EXIT || "0");
if (exit !== 0) process.exit(exit);
const write = (v) => process.stdout.write(JSON.stringify(v));
if (argv.includes("list")) {
  const held = process.env.FAKE_SHIM_HELD === "1";
  write({ ok: true, data: { tasks: held ? [{ identifier: "T-HELD", assignee: { display_name: process.env.FAKE_SHIM_HELD_NAME || "Alice" } }] : [] } });
} else if (argv.includes("candidates")) {
  const ids = String(process.env.FAKE_SHIM_CANDIDATES || "").split(",").map((s) => s.trim()).filter(Boolean);
  write({ ok: true, data: { candidates: ids.map((identifier) => ({ identifier })) } });
} else {
  write({ ok: true, data: {} });
}
`;

/** A fake host CLI: records {bin, argv} and exits 0 — the wake boundary. */
const FAKE_CLI = `#!/usr/bin/env node
// Fake host CLI written by scripts/verify/host-runtime.mjs — records argv, exits 0.
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
if (process.env.FAKE_HOST_LOG) {
  appendFileSync(process.env.FAKE_HOST_LOG, JSON.stringify({ bin: basename(process.argv[1]), argv: process.argv.slice(2) }) + "\\n");
}
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

/** @type {Array<{section: string, name: string, ok: boolean, detail: string}>} */
const results = [];
let failures = 0;

/**
 * Run one assertion. `fn` returns an error string (or throws) on failure, `null`/undefined
 * on success; `detail` is a short note shown on the PASS line for evidence.
 */
function check(section, name, fn, detail = "") {
  let error = null;
  try {
    error = fn() ?? null;
  } catch (err) {
    error = err?.message ?? String(err);
  }
  const ok = !error;
  if (!ok) failures += 1;
  results.push({ section, name, ok, detail: ok ? detail : error });
  return ok;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Never inherit a caller's agent identity: the rendered {{AGENT}} must be the only
  // source, so a scenario can assert on a known name.
  delete env.TASKCTL_AGENT;
  return { ...env, ...extra };
}

/** Spawn a script with a controlled PATH (fake bin first) and a throwaway HOME. */
function run(args, { env = {}, cwd = ROOT } = {}) {
  const res = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: baseEnv({
      HOME: ctx.home,
      PATH: `${ctx.fakeBin}:${process.env.PATH}`,
      NO_COLOR: "1",
      CI: "1",
      ...env,
    }),
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

/** Fresh per-scenario log file so recorded argv never leaks between scenarios. */
function freshLog(name) {
  const path = join(ctx.tmp, `log-${name}.jsonl`);
  writeFileSync(path, "");
  return path;
}

// ---------------------------------------------------------------------------
// Install bring-up (once per run, per selected host)
// ---------------------------------------------------------------------------

function installHost(host) {
  const res = run(
    [join(ROOT, "install.sh"), "--target", host, "--prefix", ctx.home, "--agent-name", AGENT, "--skip-node-check"],
    { env: { MEERKAT_TASKPANEL_TARGET_HOME: ctx.home } },
  );
  if (res.status !== 0) {
    throw new Error(`install.sh --target ${host} exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  // Swap in the canned shim at the boundary the generated glue actually calls.
  const spec = HOSTS[host];
  if (spec.shim) {
    const shimPath = join(ctx.home, spec.shim);
    mkdirSync(dirname(shimPath), { recursive: true });
    writeFileSync(shimPath, FAKE_SHIM);
    chmodSync(shimPath, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Every wake script: the no-prompt guard, then the exact argv it hands the host CLI. */
function checkWake(host) {
  const spec = HOSTS[host];
  const section = `wake (${host})`;
  const wakePath = join(ctx.home, spec.wake);
  const log = freshLog(`wake-${host}`);

  check(section, `${spec.wake} installed and executable`, () => {
    if (!existsSync(wakePath)) return `missing ${wakePath}`;
    const text = readFileSync(wakePath, "utf8");
    if (!text.startsWith("#!/usr/bin/env bash")) return "not a bash script";
    return null;
  }, spec.wake);

  check(section, "no prompt → exit 2, host CLI never invoked", () => {
    writeFileSync(log, "");
    const res = run(["bash", wakePath], { env: { FAKE_HOST_LOG: log } });
    if (res.status !== 2) return `exit ${res.status} (want 2); stderr=${JSON.stringify(res.stderr)}`;
    if (!/handoff prompt is required/.test(res.stderr)) return `stderr did not name the missing prompt: ${JSON.stringify(res.stderr)}`;
    const calls = readJsonl(log);
    if (calls.length) return `host CLI was invoked ${calls.length} time(s) without a prompt: ${JSON.stringify(calls)}`;
    return null;
  }, "exit 2");

  check(section, "prompt → exact argv matches wakeCommand()", () => {
    const prompt = `do T-1 (agent ${AGENT})`;
    writeFileSync(log, "");
    const res = run(["bash", wakePath, prompt], { env: { FAKE_HOST_LOG: log } });
    if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
    const calls = readJsonl(log);
    if (calls.length !== 1) return `want 1 host-CLI call, got ${calls.length}: ${JSON.stringify(calls)}`;
    const want = wakeCommand({ host, prompt });
    if (calls[0].bin !== want.command) return `invoked ${calls[0].bin}, expected ${want.command}`;
    if (JSON.stringify(calls[0].argv) !== JSON.stringify(want.args)) {
      return `argv ${JSON.stringify(calls[0].argv)} != wakeCommand().args ${JSON.stringify(want.args)}`;
    }
    return null;
  }, `${spec.cli} ${wakeCommand({ host, prompt: "…" }).args.join(" ")}`);

  check(section, "no permission-bypass flag in any executed command", () => {
    // Comment lines are dropped first: the scripts *document* the boundary by naming the
    // flag they must not use, and a naive substring scan would flag that comment.
    const commands = readFileSync(wakePath, "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    for (const bad of ["--dangerously-skip-permissions", "--dangerously-bypass", "--yolo", "--full-auto"]) {
      if (commands.includes(bad)) return `generated script runs ${bad}`;
    }
    return null;
  }, "headless permission boundary held");
}

/** Claude: the SessionStart hook (claimable list + the eight rules), non-fatal. */
function checkSessionStart() {
  const section = "session-start (claude)";
  const hookPath = join(ctx.home, HOSTS.claude.hook);
  const shimPath = join(ctx.home, HOSTS.claude.shim);

  check(section, "hook installed and executable", () => {
    if (!existsSync(hookPath)) return `missing ${hookPath}`;
    return null;
  }, HOSTS.claude.hook);

  check(section, "lists candidates through the shim (argv + output) and prints the eight rules", () => {
    const log = freshLog("session-start");
    const res = run(["bash", hookPath], { env: { FAKE_SHIM_LOG: log, FAKE_SHIM_CANDIDATES: "T-1,T-2" } });
    if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
    const calls = readJsonl(log);
    const want = ["issue", "candidates", "--assignee", AGENT];
    if (calls.length !== 1) return `want 1 shim call, got ${calls.length}: ${JSON.stringify(calls)}`;
    if (JSON.stringify(calls[0]) !== JSON.stringify(want)) return `shim argv ${JSON.stringify(calls[0])} != ${JSON.stringify(want)}`;
    if (!/claimable for alice/.test(res.stdout)) return "did not print the claimable header for the agent name";
    if (!res.stdout.includes("T-1") || !res.stdout.includes("T-2")) return "did not surface the candidates the shim returned";
    for (let n = 1; n <= 8; n += 1) {
      if (!new RegExp(`(^|\\n)${n}\\.`).test(res.stdout)) return `missing rule ${n}`;
    }
    if (!res.stdout.includes("八条规矩")) return "missing the rules header";
    return null;
  }, "shim argv = issue candidates --assignee alice; rules 1–8 printed");

  check(section, "non-fatal: a failing shim still exits 0", () => {
    const log = freshLog("session-start-fail");
    const res = run(["bash", hookPath], { env: { FAKE_SHIM_LOG: log, FAKE_SHIM_EXIT: "3" } });
    return res.status === 0 ? null : `exit ${res.status} (the hook must never block a session)`;
  }, "shim exit 3 → hook exit 0");

  check(section, "PATH-independent fallback when the shim is missing (still exit 0)", () => {
    const backup = `${shimPath}.bak`;
    // Simulate "not installed / not executable" without touching the real destination.
    writeFileSync(backup, readFileSync(shimPath));
    rmSync(shimPath);
    try {
      const res = run(["bash", hookPath]);
      if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
      if (!/taskctl shim or node not found/.test(res.stdout)) return `fallback text absent: ${JSON.stringify(res.stdout)}`;
      if (!res.stdout.includes(shimPath)) return "fallback did not name the absolute shim path (must be PATH-independent)";
      if (!res.stdout.includes(join(ROOT, "src/cli/index.mjs"))) return "fallback did not offer the repo CLI path";
      return null;
    } finally {
      writeFileSync(shimPath, readFileSync(backup));
      chmodSync(shimPath, 0o755);
      rmSync(backup);
    }
  }, "names the absolute shim path; exit 0");
}

/** Codex: the cron claim trigger — one card at a time, own cards only. */
function checkTrigger() {
  const section = "trigger (codex)";
  const triggerPath = join(ctx.home, HOSTS.codex.trigger);

  check(section, "trigger installed and executable", () => {
    if (!existsSync(triggerPath)) return `missing ${triggerPath}`;
    return null;
  }, HOSTS.codex.trigger);

  const runTrigger = (seed, env) => {
    const log = freshLog(`trigger-${seed}`);
    const res = run(["bash", triggerPath], { env: { FAKE_SHIM_LOG: log, ...env } });
    return { res, calls: readJsonl(log) };
  };

  check(section, "no held card → claims the first candidate (`issue move T-1 in_progress`)", () => {
    const { res, calls } = runTrigger("claim", { FAKE_SHIM_CANDIDATES: "T-1,T-2" });
    if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
    if (!/claiming T-1/.test(res.stdout)) return `did not announce the claim: ${JSON.stringify(res.stdout)}`;
    const move = calls.find((c) => c.includes("move"));
    if (!move) return `no move call recorded: ${JSON.stringify(calls)}`;
    const want = ["issue", "move", "T-1", "in_progress"];
    if (JSON.stringify(move) !== JSON.stringify(want)) return `move argv ${JSON.stringify(move)} != ${JSON.stringify(want)}`;
    return null;
  }, "move T-1 only");

  check(section, "held card that is mine (NFKC/whitespace/case) → skip, exit 0, no move", () => {
    // "A l i c e" must normalize to the same identity as "alice" — the board's own rule.
    const { res, calls } = runTrigger("mine", { FAKE_SHIM_HELD: "1", FAKE_SHIM_HELD_NAME: "A l i c e", FAKE_SHIM_CANDIDATES: "T-1" });
    if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
    if (!/already holding T-HELD/.test(res.stdout)) return `did not report the held card: ${JSON.stringify(res.stdout)}`;
    if (calls.some((c) => c.includes("move"))) return `claimed while already holding: ${JSON.stringify(calls)}`;
    return null;
  }, "skip + exit 0");

  check(section, "held card that is someone else's → claims the first candidate", () => {
    const { res, calls } = runTrigger("foreign", { FAKE_SHIM_HELD: "1", FAKE_SHIM_HELD_NAME: "Bob", FAKE_SHIM_CANDIDATES: "T-1" });
    if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
    const move = calls.find((c) => c.includes("move"));
    if (!move) return "did not claim even though the held card is not mine (identity filter too loose)";
    if (move[2] !== "T-1") return `claimed ${move[2]} instead of T-1`;
    return null;
  }, "identity filter is per-agent");

  check(section, "empty pool → exit 0, nothing claimed", () => {
    const { res, calls } = runTrigger("empty", { FAKE_SHIM_CANDIDATES: "" });
    if (res.status !== 0) return `exit ${res.status}; stderr=${JSON.stringify(res.stderr)}`;
    if (!/no claimable cards/.test(res.stdout)) return `did not report an empty pool: ${JSON.stringify(res.stdout)}`;
    if (calls.some((c) => c.includes("move"))) return "claimed with an empty pool";
    return null;
  }, "exit 0");

  check(section, "shim missing → exit 1 (the trigger's explicit contract)", () => {
    const shimPath = join(ctx.home, HOSTS.codex.shim);
    const backup = `${shimPath}.bak`;
    writeFileSync(backup, readFileSync(shimPath));
    rmSync(shimPath);
    try {
      const res = run(["bash", triggerPath]);
      if (res.status !== 1) return `exit ${res.status} (want 1)`;
      if (!/taskctl shim not found/.test(res.stderr)) return `stderr did not name the missing shim: ${JSON.stringify(res.stderr)}`;
      return null;
    } finally {
      writeFileSync(shimPath, readFileSync(backup));
      chmodSync(shimPath, 0o755);
      rmSync(backup);
    }
  }, "exit 1");
}

/** Hosts that ship neither form: assert the *absence* explicitly, with the reason. */
function checkAbsences() {
  check("coverage map", "claude ships no cron trigger (SessionStart hook instead)", () => {
    return existsSync(join(ctx.home, ".claude/meerkat-taskpanel-claim.sh")) ? "unexpected claude claim trigger" : null;
  }, "N/A — Claude uses the SessionStart hook");

  check("coverage map", "codex ships no SessionStart hook (cron trigger instead)", () => {
    return existsSync(join(ctx.home, ".codex/hooks")) ? "unexpected codex hooks dir" : null;
  }, "N/A — Codex has no hooks; the trigger is the automation");

  check("coverage map", "pi ships no hook, trigger or shim", () => {
    for (const rel of [".agents/hooks", ".agents/meerkat-taskpanel-claim.sh", ".agents/bin/taskctl"]) {
      if (existsSync(join(ctx.home, rel))) return `unexpected ${rel}`;
    }
    return null;
  }, "N/A — pi has no hooks and no shim; only its external wake path applies");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ctx = { home: "", tmp: "", fakeBin: "" };

function setup(homeArg) {
  const tmp = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-hostruntime-"));
  ctx.tmp = tmp;
  ctx.home = homeArg ? resolve(homeArg) : join(tmp, "home");
  mkdirSync(ctx.home, { recursive: true });
  ctx.fakeBin = join(tmp, "bin");
  mkdirSync(ctx.fakeBin, { recursive: true });
  for (const cli of ["claude", "codex", "pi"]) {
    const p = join(ctx.fakeBin, cli);
    writeFileSync(p, FAKE_CLI);
    chmodSync(p, 0o755);
  }
  return { tmp };
}

function cleanup(tmp) {
  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      host: { type: "string", multiple: true, short: "H" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/host-runtime.mjs [--home <dir>] [--host <host>] [--quiet]\n\n" +
        "  Offline mock harness: drives the generated SessionStart hook / claim trigger /\n" +
        "  wake scripts against fake host CLIs. Never touches $HOME, never uses the network.\n" +
        `  --host <host>  only these hosts (${Object.keys(HOSTS).join(", ")}); repeatable or comma-separated\n`,
    );
    return 0;
  }

  const wanted = (values.host ?? []).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  const hosts = wanted.length ? wanted : Object.keys(HOSTS);
  const unknown = hosts.filter((h) => !(h in HOSTS));
  if (unknown.length) {
    process.stderr.write(`host-runtime: unknown host(s): ${unknown.join(", ")} (expected ${Object.keys(HOSTS).join(", ")})\n`);
    return 2;
  }

  const { tmp } = setup(values.home);
  let installError = null;
  try {
    process.stdout.write(`host-runtime: home = ${ctx.home}\n`);
    for (const host of hosts) {
      try {
        installHost(host);
      } catch (err) {
        installError = err.message;
        failures += 1;
        results.push({ section: `install (${host})`, name: "install.sh bring-up", ok: false, detail: err.message });
      }
    }

    if (!installError) {
      if (hosts.includes("claude")) {
        checkSessionStart();
        checkWake("claude");
      }
      if (hosts.includes("codex")) {
        checkTrigger();
        checkWake("codex");
      }
      if (hosts.includes("pi")) {
        checkWake("pi");
      }
      checkAbsences();
    }
  } finally {
    cleanup(tmp);
  }

  if (!values.quiet) {
    let current = "";
    for (const row of results) {
      if (row.section !== current) {
        current = row.section;
        process.stdout.write(`\n${current}\n`);
      }
      process.stdout.write(`  ${row.ok ? "PASS" : "FAIL"}  ${row.name}${row.detail ? `  — ${row.detail}` : ""}\n`);
    }
  }

  const total = results.length;
  const passed = total - failures;
  process.stdout.write(`\nhost-runtime: ${passed}/${total} assertions passed (${hosts.join(", ")})\n`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
