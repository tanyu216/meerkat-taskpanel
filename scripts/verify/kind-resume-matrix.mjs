#!/usr/bin/env node
/**
 * SUPPLEMENTARY verification: the three-agent-kind SESSION-RESUME capability matrix.
 *
 *   node scripts/verify/kind-resume-matrix.mjs [options]
 *
 * Options:
 *   --actor-kind <k1,k2>       restrict to a subset of claude,codex,pi (default: all)
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
 * The team twice mis-read the agent kinds: "codex/pi have no resume" was really our own wake
 * scripts not being wired. This script makes that claim falsifiable. It records, per agent kind
 * and per capability dimension, the exact command, the matched help text and the exit code,
 * then optionally proves the capability end to end with a marker round trip.
 *
 * Dimensions (columns): version | continue-last | resume-by-id | fork | non-interactive.
 *
 * RELATION TO THE OTHER VERIFY ASSETS (the card asks for this explicitly)
 *   * scripts/verify/kind-runtime.mjs — OFFLINE mock harness: drives the generated glue
 *     (hooks, wake-*.sh) against FAKE CLIs and asserts argv. It never touches a real CLI,
 *     and it says nothing about resume. This script is the real-CLI counterpart.
 *   * scripts/verify/kind-cli.mjs — drives the real CLIs too, but only for plugin/marketplace
 *     *recognition*; it has no resume dimension. Same isolation tricks are reused here
 *     (throwaway HOME, SKIP-on-absent), so the two are complementary and coexist.
 *   * src/foundation/scheduling.mjs#wakeCommand — the production consumer. It emits
 *     `claude -p [--resume <sid>]` / `codex exec [resume <sid>]` /
 *     `pi --print [--session <sid>]` (pi has no `run` subcommand — `--print` is its
 *     headless entry); this matrix is the evidence that those flags
 *     are real in the CLI versions we pin.
 *
 * A `null` dimension means the agent kind does not offer that capability; it renders as
 * `➖` and is excluded from the row's pass/fail decision.
 *
 * EVIDENCE DISCIPLINE
 *   * Every probe runs in a throwaway HOME. Nothing touches the real ~/.claude, ~/.codex,
 *     ~/.pi.
 *   * `--e2e` copies ONLY the minimum provider config / auth into the throwaway home and
 *     deletes it afterwards. Credentials are never printed into stdout or evidence; the
 *     e2e fixtures below are generated literals ("MK-<KIND>-<rand>"), not secrets.
 *   * An agent kind whose CLI is absent is SKIPPED (blocked), not failed — safe to run anywhere.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

const IMAGE = "meerkat-taskpanel:verify";

/** Keep agent CLIs off the network where we can, and their output machine-readable. */
const QUIET_ENV = { NO_COLOR: "1", CI: "1", OPENCLAW_DISABLE_UPDATE_CHECK: "1" };

/**
 * Per-agent-kind probe table. `bins` is the executable name; `help` is the list of argv tails
 * whose combined output we scan; `dims` maps each capability to a RegExp that must match
 * the help text; `nonInteractive` additionally carries the concrete headless invocation.
 *
 * @type {Array<{actorKind:string, bin:string, dotDir:string, configEnv:string, help:string[][],
 *   dims:{continueLast:RegExp, resumeById:RegExp, fork:RegExp, nonInteractive:RegExp},
 *   headless:string}>}
 */
export const KINDS = [
  {
    actorKind: "claude",
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
    actorKind: "codex",
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
    actorKind: "pi",
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

/** Run one agent kind's help probes in a throwaway HOME; return the concatenated output. */
function gatherHelp(kind, timeoutMs) {
  const home = mkdtempSync(join(tmpdir(), `trm-resume-${kind.actorKind}-`));
  mkdirSync(join(home, kind.dotDir), { recursive: true });
  const env = {
    ...process.env,
    ...QUIET_ENV,
    HOME: home,
    ...(kind.configEnv ? { [kind.configEnv]: join(home, kind.dotDir) } : {}),
  };
  const chunks = [];
  const transcripts = [];
  try {
    for (const args of kind.help) {
      const r = spawnSync(kind.bin, args, { env, encoding: "utf8", timeout: timeoutMs, input: "" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      chunks.push(out);
      transcripts.push({
        cmd: `${kind.bin} ${args.join(" ")}`,
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

/** Probe one agent kind: version + the four capability dimensions (flag level). */
export function probeKind(kind, timeoutMs) {
  const binPath = which(kind.bin);
  if (!binPath) {
    return {
      actorKind: kind.actorKind,
      status: "SKIP",
      reason: `${kind.bin} not on PATH`,
      version: null,
      env: "host",
      dims: {},
      headless: kind.headless,
    };
  }

  const v = spawnSync(kind.bin, ["--version"], { encoding: "utf8", timeout: timeoutMs, input: "" });
  const version = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim().split("\n")[0] || "(unknown)";
  const { text, transcripts } = gatherHelp(kind, timeoutMs);

  const dims = {};
  for (const [key, re] of Object.entries(kind.dims)) {
    // `null` means the agent kind does not offer this capability; it is neither a pass
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
    actorKind: kind.actorKind,
    status: Object.values(dims).every((d) => d.ok) ? "PASS" : "PARTIAL",
    version,
    env: "host",
    dims,
    probes: transcripts,
    headless: kind.headless,
  };
}

/* ------------------------------------------------------------------ e2e round trips */

/** The isolated-home fixtures. Only these files (never the whole config dir) are copied. */
const E2E_FIXTURES = {
  claude: [], // auth arrives via ANTHROPIC_* env
  codex: ["config.toml", "cc-switch-model-catalog.json"],
  pi: ["agent/auth.json", "agent/models-store.json"],
};

/** The per-agent-kind dot-directory under an isolated HOME. */
const E2E_DIRS = { claude: ".claude", codex: ".codex", pi: ".pi" };

function isolatedHome(kind) {
  const home = mkdtempSync(join(tmpdir(), `trm-e2e-${kind}-`));
  const dir = E2E_DIRS[kind] ?? ".claude";
  mkdirSync(join(home, dir), { recursive: true });
  for (const rel of E2E_FIXTURES[kind] ?? []) {
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

const MARK = (kind) => `MK-${kind.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ASK = (m) => `Remember the token ${m}. Reply with exactly: STORED`;
const RECALL = "What token did I ask you to remember? Reply with only the token, nothing else.";

/**
 * Marker round trip for one agent kind. Returns a list of step results; each carries the command,
 * the exit code and whether the marker came back. A step whose model turn is refused (auth,
 * network) is reported as `blocked` with the upstream message — never silently "passed".
 */
export function e2eKind(kindName, timeoutMs) {
  const mark = MARK(kindName);
  const home = isolatedHome(kindName);
  const cwd = mkdtempSync(join(tmpdir(), `trm-e2e-${kindName}-cwd-`));
  const env = {
    ...process.env,
    ...QUIET_ENV,
    HOME: home,
    ...(kindName === "codex" ? { CODEX_HOME: join(home, ".codex") } : {}),
    ...(kindName === "claude" ? { CLAUDE_CONFIG_DIR: join(home, ".claude") } : {}),
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
    if (kindName === "claude") {
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
    } else if (kindName === "codex") {
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
    } else if (kindName === "pi") {
      const a = runIn("pi", ["--print", ASK(mark)], env, cwd, timeoutMs);
      push("new session (pi --print)", a);
      const b = runIn("pi", ["--print", "--continue", RECALL], env, cwd, timeoutMs);
      push("continue-last (pi --print --continue)", b);
    } else {
      return { actorKind: kindName, marker: mark, status: "blocked", reason: "no CLI (see flag-level probe)", steps: [] };
    }

    const recalled = steps.filter((s) => /resume-by-id|continue-last/.test(s.step));
    // Every resume step that ran must read the marker back.
    const green = recalled.length > 0 && recalled.every((s) => s.readBack);
    const refused = steps.some((s) => s.rc !== 0 && !s.readBack && /4\d\d|forbidden|unauthor|not allowed|api key/i.test(s.excerpt));
    return {
      actorKind: kindName,
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
    "for b in claude codex pi; do printf '%s=' $b; command -v $b || echo MISSING; done",
    "echo '--- install ---'",
    "npm i -g @anthropic-ai/claude-code@2.1.292 @openai/codex@0.161.0 @earendil-works/pi-coding-agent@1.0.4 2>&1 | tail -5",
    // Each probe is wrapped in `timeout` — a CLI that ignores --help and opens a TUI
    // would otherwise block the whole container run.
    "tt() { timeout 30 \"$@\" 2>&1 | head -40; }",
    "echo '--- versions ---'",
    "for b in claude codex pi; do printf '## %s :: ' $b; tt $b --version | head -1 || echo MISSING; done",
    "echo '--- resume flags ---'",
    "echo '-- claude --help --'; tt claude --help | grep -iE -- '--resume|--continue|--fork-session|--print' | head -6",
    "echo '-- codex exec resume --help --'; tt codex exec resume --help | grep -iE 'SESSION_ID|--last' | head -4",
    "echo '-- codex exec fork --help --'; tt codex exec fork --help | grep -iE 'SESSION_ID' | head -2",
    "echo '-- pi --help --'; tt pi --help | grep -iE -- '--continue|--resume|--fork|--print' | head -6",
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
  const head = `| actor kind | ${cols.join(" | ")} |`;
  const sep = `| --- | ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => {
    if (r.status === "SKIP") return `| ${r.actorKind} | ${r.version ?? "n/a"} | ${cols.slice(1).map(() => "⚪ blocked").join(" | ")} |`;
    const cells = Object.keys(DIM_LABELS).map((k) => (!r.dims[k] ? "➖" : r.dims[k].ok ? "✅" : "❌"));
    return `| ${r.actorKind} | ${r.version} | ${cells.join(" | ")} |`;
  });
  return [head, sep, ...body].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "actor-kind": { type: "string", multiple: true, short: "H" },
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
      "Usage: node scripts/verify/kind-resume-matrix.mjs [--actor-kind claude,codex,pi] [--e2e] [--container]\n" +
        "       [--json] [--evidence-dir DIR]\n\n" +
        "  Flag-level resume matrix for claude|codex|pi; --e2e adds marker round trips.\n",
    );
    return 0;
  }

  const timeoutMs = Number(values.timeout ?? 60_000);
  const wanted = (values["actor-kind"] ?? []).flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
  const kinds = wanted.length ? KINDS.filter((k) => wanted.includes(k.actorKind)) : KINDS;
  const image = values.image ?? IMAGE;

  const rows = kinds.map((k) => probeKind(k, timeoutMs));
  let e2e = null;
  if (values.e2e) {
    e2e = [];
    for (const k of kinds) {
      if (!which(k.bin)) continue;
      e2e.push(e2eKind(k.actorKind, Math.max(timeoutMs, 240_000)));
    }
  }
  const container = values.container ? containerProbe(image, 900_000) : null;

  const result = { generatedAt: new Date().toISOString(), rows, e2e, container };

  if (values["evidence-dir"]) {
    const dir = resolve(values["evidence-dir"]);
    mkdirSync(dir, { recursive: true });
    for (const r of rows) {
      const lines = [`# ${r.actorKind} (${r.env})`, `status: ${r.status}`, `version: ${r.version}`, ""];
      for (const [k, d] of Object.entries(r.dims)) lines.push(`${DIM_LABELS[k]}: ${d.ok ? "YES" : "NO"} (${d.evidence})`);
      lines.push("", "## help transcripts");
      for (const p of r.probes ?? []) lines.push(`$ ${p.cmd}   # rc=${p.rc}`, p.excerpt, "");
      writeFileSync(join(dir, `flags-${r.actorKind}.txt`), lines.join("\n"));
    }
    for (const e of e2e ?? []) {
      writeFileSync(
        join(dir, `e2e-${e.actorKind}.txt`),
        [`# e2e ${e.actorKind}`, `status: ${e.status}`, `marker: ${e.marker}`, `reason: ${e.reason}`, "",
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
      process.stdout.write(`${r.status.padEnd(8)} ${r.actorKind.padEnd(9)} ${r.version ?? "-"}\n`);
    }
    for (const e of e2e ?? []) process.stdout.write(`e2e ${e.status.padEnd(8)} ${e.actorKind} — ${e.reason}\n`);
    if (container) process.stdout.write(`container probe rc=${container.rc}\n`);
  }

  return rows.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(await main());
}
