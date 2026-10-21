#!/usr/bin/env node
/**
 * SUPPLEMENTARY verification: the four-host SESSION-RESUME capability matrix.
 *
 *   node scripts/verify/host-resume-matrix.mjs [options]
 *
 * Options:
 *   --host <h1,h2>       restrict to some of claude,codex,pi,opencode,cursor (default: all)
 *   --timeout <ms>       per-probe timeout (default 60000)
 *   --e2e                also run the "new session -> remember a marker -> resume reads it
 *                        back" round trip (needs working credentials; OFF by default)
 *   --container          also probe inside the `meerkat-taskpanel:verify` image via
 *                        spawnSync("docker", …) — flag level only (no credentials there)
 *   --image <ref>        container image for --container (default meerkat-taskpanel:verify)
 *   --json               print the full result tree as JSON
 *   --evidence-dir <dir> write one raw-text evidence file per cell (command + output + rc)
 *   -h, --help
 *
 * WHAT THIS DOES / WHY IT EXISTS
 * -----------------------------
 * The team twice mis-read the hosts: "codex/pi have no resume" was really our own wake
 * scripts not being wired. This script makes that claim falsifiable. It records, per host
 * and per capability dimension, the exact command, the matched help text and the exit code,
 * then optionally proves the capability end to end with a marker round trip.
 *
 * Dimensions (columns): version | continue-last | resume-by-id | fork | non-interactive.
 *
 * RELATION TO THE OTHER VERIFY ASSETS (the card asks for this explicitly)
 *   * scripts/verify/host-runtime.mjs — OFFLINE mock harness: drives the generated glue
 *     (hooks, wake-*.sh) against FAKE CLIs and asserts argv. It never touches a real CLI,
 *     and it says nothing about resume. This script is the real-CLI counterpart.
 *   * scripts/verify/host-cli.mjs — drives the real CLIs too, but only for plugin/marketplace
 *     *recognition*; it has no resume dimension. Same isolation tricks are reused here
 *     (throwaway HOME, SKIP-on-absent), so the two are complementary and coexist.
 *   * src/foundation/scheduling.mjs#wakeCommand — the production consumer. It emits
 *     `claude -p [--resume <sid>]` / `codex exec [resume <sid>]` /
 *     `pi --print [--session <sid>]` (pi has no `run` subcommand — `--print` is its
 *     headless entry) / `opencode run [--session <sid>]` /
 *     `cursor-agent -p [--resume <sid>]`; this matrix is the evidence that those flags
 *     are real in the CLI versions we pin.
 *
 * A `null` dimension means the host does not offer that capability (Cursor has no fork
 * flag); it renders as `➖` and is excluded from the row's pass/fail decision.
 *
 * EVIDENCE DISCIPLINE
 *   * Every probe runs in a throwaway HOME. Nothing touches the real ~/.claude, ~/.codex,
 *     ~/.pi, ~/.config/opencode, ~/.cursor.
 *   * `--e2e` copies ONLY the minimum provider config / auth into the throwaway home and
 *     deletes it afterwards. Credentials are never printed into stdout or evidence; the
 *     e2e fixtures below are generated literals ("MK-<HOST>-<rand>"), not secrets.
 *     Cursor's e2e reads `CURSOR_API_KEY` from the environment and SKIPs without it.
 *   * A host whose CLI is absent is SKIPPED (blocked), not failed — safe to run anywhere.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

const IMAGE = "meerkat-taskpanel:verify";

/** Keep host CLIs off the network where we can, and their output machine-readable. */
const QUIET_ENV = { NO_COLOR: "1", CI: "1", OPENCLAW_DISABLE_UPDATE_CHECK: "1" };

/**
 * Per-host probe table. `bins` is the executable name; `help` is the list of argv tails
 * whose combined output we scan; `dims` maps each capability to a RegExp that must match
 * the help text; `nonInteractive` additionally carries the concrete headless invocation.
 *
 * @type {Array<{host:string, bin:string, dotDir:string, configEnv:string, help:string[][],
 *   dims:{continueLast:RegExp, resumeById:RegExp, fork:RegExp, nonInteractive:RegExp},
 *   headless:string}>}
 */
export const HOSTS = [
  {
    host: "claude",
    bin: "claude",
    dotDir: ".claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    help: [["--help"]],
    dims: {
      continueLast: /-c, --continue\b/,
      resumeById: /--resume <session-id>/,
      fork: /--fork-session/,
      nonInteractive: /-p, --print\b/,
    },
    headless: "claude -p --output-format json <prompt>",
  },
  {
    host: "codex",
    bin: "codex",
    dotDir: ".codex",
    configEnv: "CODEX_HOME",
    help: [["exec", "--help"], ["exec", "resume", "--help"], ["exec", "fork", "--help"]],
    dims: {
      continueLast: /--last\b/,
      resumeById: /SESSION_ID/,
      fork: /^\s*fork\s+\S+/m,
      nonInteractive: /non-interactively/i,
    },
    headless: "codex exec --json --skip-git-repo-check <prompt>",
  },
  {
    host: "pi",
    bin: "pi",
    dotDir: ".pi",
    configEnv: null, // pi reads ~/.pi; isolated via HOME only
    help: [["--help"]],
    dims: {
      continueLast: /--continue, -c\b/,
      resumeById: /--session <path\|id>/,
      fork: /--fork <path\|id>/,
      nonInteractive: /--print, -p\b/,
    },
    headless: "pi --print <prompt>",
  },
  {
    host: "opencode",
    bin: "opencode",
    dotDir: ".config/opencode",
    configEnv: null,
    help: [["--help"], ["run", "--help"]],
    dims: {
      continueLast: /--continue\b|-c, --continue/,
      resumeById: /--session\b/,
      fork: /--fork\b/,
      nonInteractive: /run\b/,
    },
    headless: "opencode run <prompt>",
  },
  {
    // Cursor's documented flag surface (`-p/--print`, `--resume [chatId]`,
    // `--continue`, `--workspace`). It has no fork flag, so `fork: null` records
    // "not offered" rather than inventing a capability. An absent CLI SKIPs.
    host: "cursor",
    bin: "cursor-agent",
    dotDir: ".cursor",
    configEnv: null,
    help: [["--help"]],
    dims: {
      continueLast: /--continue\b/,
      resumeById: /--resume\b/,
      fork: null,
      nonInteractive: /-p, --print\b/,
    },
    headless: "cursor-agent -p <prompt>",
  },
];

const DIM_LABELS = {
  continueLast: "continue-last",
  resumeById: "resume-by-id",
  fork: "fork",
  nonInteractive: "non-interactive",
};

function tail(text, lines = 30) {
  const t = String(text ?? "").trim();
  return t ? t.split("\n").slice(-lines).join("\n") : "";
}

/** Is `bin` on PATH? Uses a login shell so nvm-installed CLIs are found. */
function which(bin) {
  const r = spawnSync("/bin/sh", ["-lc", `command -v ${bin}`], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

/** Run one host's help probes in a throwaway HOME; return the concatenated output. */
function gatherHelp(host, timeoutMs) {
  const home = mkdtempSync(join(tmpdir(), `trm-resume-${host.host}-`));
  mkdirSync(join(home, host.dotDir), { recursive: true });
  const env = {
    ...process.env,
    ...QUIET_ENV,
    HOME: home,
    ...(host.configEnv ? { [host.configEnv]: join(home, host.dotDir) } : {}),
  };
  const chunks = [];
  const transcripts = [];
  try {
    for (const args of host.help) {
      const r = spawnSync(host.bin, args, { env, encoding: "utf8", timeout: timeoutMs, input: "" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      chunks.push(out);
      transcripts.push({
        cmd: `${host.bin} ${args.join(" ")}`,
        rc: r.status,
        error: r.error?.message ?? null,
        excerpt: tail(out, 20),
      });
    }
    return { text: chunks.join("\n"), transcripts };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Probe one host: version + the four capability dimensions (flag level). */
export function probeHost(host, timeoutMs) {
  const binPath = which(host.bin);
  if (!binPath) {
    return {
      host: host.host,
      status: "SKIP",
      reason: `${host.bin} not on PATH`,
      version: null,
      env: "host",
      dims: {},
      headless: host.headless,
    };
  }

  const v = spawnSync(host.bin, ["--version"], { encoding: "utf8", timeout: timeoutMs, input: "" });
  const version = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim().split("\n")[0] || "(unknown)";
  const { text, transcripts } = gatherHelp(host, timeoutMs);

  const dims = {};
  for (const [key, re] of Object.entries(host.dims)) {
    // `null` means the host does not offer this capability; it is neither a pass
    // nor a failure, and it must not drag the whole row to PARTIAL.
    if (re === null) continue;
    const m = text.match(re);
    const matched = m ? (text.split("\n").find((l) => re.test(l)) || "").trim() : null;
    dims[key] = {
      ok: !!m,
      evidence: matched ? `matched: ${matched.replace(/\s+/g, " ").slice(0, 90)}` : "no match in help output",
    };
  }

  return {
    host: host.host,
    status: Object.values(dims).every((d) => d.ok) ? "PASS" : "PARTIAL",
    version,
    env: "host",
    dims,
    probes: transcripts,
    headless: host.headless,
  };
}

/* ------------------------------------------------------------------ e2e round trips */

/** The isolated-home fixtures. Only these files (never the whole config dir) are copied. */
const E2E_FIXTURES = {
  claude: [], // auth arrives via ANTHROPIC_* env
  codex: ["config.toml", "cc-switch-model-catalog.json"],
  pi: ["agent/auth.json", "agent/models-store.json"],
  cursor: [], // auth arrives via CURSOR_API_KEY
};

/** The per-host dot-directory under an isolated HOME. */
const E2E_DIRS = { claude: ".claude", codex: ".codex", pi: ".pi", opencode: ".config/opencode", cursor: ".cursor" };

function isolatedHome(host) {
  const home = mkdtempSync(join(tmpdir(), `trm-e2e-${host}-`));
  const dir = E2E_DIRS[host] ?? ".claude";
  mkdirSync(join(home, dir), { recursive: true });
  for (const rel of E2E_FIXTURES[host] ?? []) {
    const src = join(homedir(), dir, rel);
    const dst = join(home, dir, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  return home;
}

function runIn(bin, args, env, cwd, timeoutMs) {
  const r = spawnSync(bin, args, { env, encoding: "utf8", timeout: timeoutMs, cwd, input: "" });
  return { rc: r.status, out: r.stdout ?? "", err: r.stderr ?? "", error: r.error?.message ?? null };
}

const MARK = (host) => `MK-${host.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ASK = (m) => `Remember the token ${m}. Reply with exactly: STORED`;
const RECALL = "What token did I ask you to remember? Reply with only the token, nothing else.";

/**
 * Marker round trip for one host. Returns a list of step results; each carries the command,
 * the exit code and whether the marker came back. A step whose model turn is refused (auth,
 * network) is reported as `blocked` with the upstream message — never silently "passed".
 */
export function e2eHost(hostName, timeoutMs) {
  const mark = MARK(hostName);
  const home = isolatedHome(hostName);
  const cwd = mkdtempSync(join(tmpdir(), `trm-e2e-${hostName}-cwd-`));
  const env = {
    ...process.env,
    ...QUIET_ENV,
    HOME: home,
    ...(hostName === "codex" ? { CODEX_HOME: join(home, ".codex") } : {}),
    ...(hostName === "claude" ? { CLAUDE_CONFIG_DIR: join(home, ".claude") } : {}),
  };
  const steps = [];
  const push = (name, res, extra = {}) => {
    steps.push({
      step: name,
      rc: res.rc,
      marker: mark,
      readBack: res.out.includes(mark),
      excerpt: tail(`${res.out || res.err}`, 6),
      ...extra,
    });
  };

  try {
    if (hostName === "claude") {
      const a = runIn("claude", ["-p", "--output-format", "json", ASK(mark)], env, cwd, timeoutMs);
      let sid = null;
      try { sid = JSON.parse(a.out).session_id; } catch { /* non-JSON = refused turn */ }
      push("new session (claude -p)", a, { sessionId: sid });
      if (sid) {
        push("resume-by-id (claude -p --resume <sid>)",
          runIn("claude", ["-p", "--resume", sid, "--output-format", "json", RECALL], env, cwd, timeoutMs));
        push("continue-last (claude -p -c)",
          runIn("claude", ["-p", "-c", "--output-format", "json", RECALL], env, cwd, timeoutMs));
        const d = runIn("claude", ["-p", "--resume", sid, "--fork-session", "--output-format", "json", "Reply with exactly: FORKED"], env, cwd, timeoutMs);
        let nsid = null;
        try { nsid = JSON.parse(d.out).session_id; } catch { /* ignore */ }
        push("fork (claude -p --resume <sid> --fork-session)", d, { forkedSessionId: nsid, forkIsNew: !!nsid && nsid !== sid });
      }
    } else if (hostName === "codex") {
      const a = runIn("codex", ["exec", "--json", "--skip-git-repo-check", ASK(mark)], env, cwd, timeoutMs);
      const tid = (a.out.match(/"thread_id":"([0-9a-f-]+)"/) || [])[1] ?? null;
      push("new session (codex exec)", a, { threadId: tid });
      if (tid) {
        push("resume-by-id (codex exec resume <id>)",
          runIn("codex", ["exec", "resume", tid, "--json", "--skip-git-repo-check", RECALL], env, cwd, timeoutMs));
        push("continue-last (codex exec resume --last)",
          runIn("codex", ["exec", "resume", "--last", "--json", "--skip-git-repo-check", RECALL], env, cwd, timeoutMs));
        const d = runIn("codex", ["exec", "fork", tid, "--json", "--skip-git-repo-check", "Reply with exactly: FORKED"], env, cwd, timeoutMs);
        const ntid = (d.out.match(/"thread_id":"([0-9a-f-]+)"/) || [])[1] ?? null;
        push("fork (codex exec fork <id>)", d, { forkedThreadId: ntid, forkIsNew: !!ntid && ntid !== tid });
      }
    } else if (hostName === "pi") {
      const a = runIn("pi", ["--print", ASK(mark)], env, cwd, timeoutMs);
      push("new session (pi --print)", a);
      const b = runIn("pi", ["--print", "--continue", RECALL], env, cwd, timeoutMs);
      push("continue-last (pi --print --continue)", b);
    } else if (hostName === "cursor") {
      // Cursor's headless auth is `CURSOR_API_KEY`; without one the turn would be
      // refused upstream, so say so instead of spending a call.
      if (!process.env.CURSOR_API_KEY) {
        return { host: hostName, marker: mark, status: "blocked", reason: "CURSOR_API_KEY is not set", steps: [] };
      }
      const a = runIn("cursor-agent", ["-p", "--trust", "--output-format", "json", ASK(mark)], env, cwd, timeoutMs);
      let sid = null;
      try {
        const parsed = JSON.parse(a.out);
        sid = parsed.session_id ?? parsed.sessionId ?? null;
      } catch {
        /* non-JSON = refused turn */
      }
      push("new session (cursor-agent -p)", a, { sessionId: sid });
      if (sid) {
        push("resume-by-id (cursor-agent -p --resume <sid>)",
          runIn("cursor-agent", ["-p", "--trust", "--resume", sid, "--output-format", "json", RECALL], env, cwd, timeoutMs));
        push("continue-last (cursor-agent -p --continue)",
          runIn("cursor-agent", ["-p", "--trust", "--continue", "--output-format", "json", RECALL], env, cwd, timeoutMs));
      }
    } else {
      return { host: hostName, marker: mark, status: "blocked", reason: "no CLI (see flag-level probe)", steps: [] };
    }

    const recalled = steps.filter((s) => /resume-by-id|continue-last/.test(s.step));
    // Cursor's proof is the documented one-shot `-p` call; a resume is a bonus when
    // the JSON output carries a session id. Every step that ran must read the marker.
    const green =
      hostName === "cursor"
        ? steps.length > 0 && steps.every((s) => s.readBack)
        : recalled.length > 0 && recalled.every((s) => s.readBack);
    const refused = steps.some((s) => s.rc !== 0 && !s.readBack && /4\d\d|forbidden|unauthor|not allowed|api key/i.test(s.excerpt));
    return {
      host: hostName,
      marker: mark,
      status: green ? "PASS" : refused ? "blocked" : "FAIL",
      reason: green ? "marker read back after resume" : refused ? "model turn refused upstream (auth/provider) — flag level only" : "marker not read back",
      steps,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------- container probe */

/** Flag-level probe inside the verify image. Runs docker via spawnSync (never a shell line). */
function containerProbe(image, timeoutMs) {
  const inner = [
    "set -u",
    "export NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NO_COLOR=1",
    // The image runs as the unprivileged `node` user and /usr/local/lib/node_modules is
    // root-owned, so a bare `npm i -g` dies with EACCES. Point the global prefix at a
    // writable dir under $HOME and put its bin/ on PATH.
    'export NPM_CONFIG_PREFIX="$HOME/.npm-global"',
    'export PATH="$HOME/.npm-global/bin:$PATH"',
    'echo "NODE=$(node -v) USER=$(id -un) PREFIX=$NPM_CONFIG_PREFIX"',
    "for b in claude codex pi opencode; do printf '%s=' $b; command -v $b || echo MISSING; done",
    "echo '--- install ---'",
    "npm i -g @anthropic-ai/claude-code@2.1.292 @openai/codex@0.161.0 @earendil-works/pi-coding-agent@1.0.4 2>&1 | tail -5",
    // Each probe is wrapped in `timeout` — a CLI that ignores --help and opens a TUI
    // (opencode does) would otherwise block the whole container run.
    "tt() { timeout 30 \"$@\" 2>&1 | head -40; }",
    "echo '--- versions ---'",
    "for b in claude codex pi opencode; do printf '## %s :: ' $b; tt $b --version | head -1 || echo MISSING; done",
    "echo '--- resume flags ---'",
    "echo '-- claude --help --'; tt claude --help | grep -iE -- '--resume|--continue|--fork-session|--print' | head -6",
    "echo '-- codex exec resume --help --'; tt codex exec resume --help | grep -iE 'SESSION_ID|--last' | head -4",
    "echo '-- codex exec fork --help --'; tt codex exec fork --help | grep -iE 'SESSION_ID' | head -2",
    "echo '-- pi --help --'; tt pi --help | grep -iE -- '--continue|--resume|--fork|--print' | head -6",
    "echo '--- opencode (separate, may need a TTY) ---'",
    "timeout 120 npm i -g opencode-ai 2>&1 | tail -3; printf 'opencode bin='; command -v opencode || echo MISSING",
    "printf 'opencode --version :: '; timeout 30 opencode --version 2>&1 | head -1 || echo '(timed out / needs TTY)'",
  ].join("\n");

  const r = spawnSync("docker", ["run", "--rm", image, "bash", "-lc", inner], { encoding: "utf8", timeout: timeoutMs });
  return {
    env: "container",
    image,
    rc: r.status,
    error: r.error?.message ?? null,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
  };
}

/* ------------------------------------------------------------------------- report */

function renderMatrix(rows) {
  const cols = ["version", ...Object.values(DIM_LABELS)];
  const head = `| host | ${cols.join(" | ")} |`;
  const sep = `| --- | ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => {
    if (r.status === "SKIP") return `| ${r.host} | ${r.version ?? "n/a"} | ${cols.slice(1).map(() => "⚪ blocked").join(" | ")} |`;
    const cells = Object.keys(DIM_LABELS).map((k) => (!r.dims[k] ? "➖" : r.dims[k].ok ? "✅" : "❌"));
    return `| ${r.host} | ${r.version} | ${cells.join(" | ")} |`;
  });
  return [head, sep, ...body].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string", multiple: true, short: "H" },
      timeout: { type: "string" },
      e2e: { type: "boolean", default: false },
      container: { type: "boolean", default: false },
      image: { type: "string" },
      json: { type: "boolean", default: false },
      "evidence-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/host-resume-matrix.mjs [--host claude,codex] [--e2e] [--container]\n" +
        "       [--json] [--evidence-dir DIR]\n\n" +
        "  Flag-level resume matrix for claude|codex|pi|opencode|cursor; --e2e adds marker round trips.\n",
    );
    return 0;
  }

  const timeoutMs = Number(values.timeout ?? 60_000);
  const wanted = (values.host ?? []).flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
  const hosts = wanted.length ? HOSTS.filter((h) => wanted.includes(h.host)) : HOSTS;
  const image = values.image ?? IMAGE;

  const rows = hosts.map((h) => probeHost(h, timeoutMs));
  let e2e = null;
  if (values.e2e) {
    e2e = [];
    for (const h of hosts) {
      if (h.host === "opencode") continue; // handled by the flag-level probe / blocked conclusion
      if (!which(h.bin)) continue;
      e2e.push(e2eHost(h.host, Math.max(timeoutMs, 240_000)));
    }
  }
  const container = values.container ? containerProbe(image, 900_000) : null;

  const result = { generatedAt: new Date().toISOString(), rows, e2e, container };

  if (values["evidence-dir"]) {
    const dir = resolve(values["evidence-dir"]);
    mkdirSync(dir, { recursive: true });
    for (const r of rows) {
      const lines = [`# ${r.host} (${r.env})`, `status: ${r.status}`, `version: ${r.version}`, ""];
      for (const [k, d] of Object.entries(r.dims)) lines.push(`${DIM_LABELS[k]}: ${d.ok ? "YES" : "NO"} (${d.evidence})`);
      lines.push("", "## help transcripts");
      for (const p of r.probes ?? []) lines.push(`$ ${p.cmd}   # rc=${p.rc}`, p.excerpt, "");
      writeFileSync(join(dir, `flags-${r.host}.txt`), lines.join("\n"));
    }
    for (const e of e2e ?? []) {
      writeFileSync(
        join(dir, `e2e-${e.host}.txt`),
        [`# e2e ${e.host}`, `status: ${e.status}`, `marker: ${e.marker}`, `reason: ${e.reason}`, "",
          ...e.steps.map((s) => [`## ${s.step}  rc=${s.rc}  readBack=${s.readBack}`,
            s.sessionId ? `session_id=${s.sessionId}` : "", s.threadId ? `thread_id=${s.threadId}` : "",
            s.forkIsNew !== undefined ? `forkIsNew=${s.forkIsNew}` : "", s.excerpt, ""].filter(Boolean).join("\n"))].join("\n"),
      );
    }
    if (container) writeFileSync(join(dir, "container-flags.txt"), `# container ${container.image}\nrc=${container.rc}\n\n${container.output}\n`);
    writeFileSync(join(dir, "matrix.md"), `${renderMatrix(rows)}\n`);
    process.stdout.write(`evidence written to ${dir}\n`);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${renderMatrix(rows)}\n\n`);
    for (const r of rows) {
      process.stdout.write(`${r.status.padEnd(8)} ${r.host.padEnd(9)} ${r.version ?? "-"}\n`);
    }
    for (const e of e2e ?? []) process.stdout.write(`e2e ${e.status.padEnd(8)} ${e.host} — ${e.reason}\n`);
    if (container) process.stdout.write(`container probe rc=${container.rc}\n`);
  }

  return rows.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}
