#!/usr/bin/env node
/**
 * SUPPLEMENTARY verification: drive each host's *real* CLI against this checkout.
 *
 *   node scripts/verify/host-cli.mjs [--host <host>] [--timeout <ms>]
 *
 * Why this is supplementary and not the evidence: ARCHITECTURE §9.1 requires
 * verification to run in the container, but the container image ships Node and the
 * repository only — no `claude` / `codex` / `openclaw` / `pi`, and no network to install
 * them. The container instead asserts the hosts' *detection contract* offline
 * (`scripts/verify/lib/bundle.mjs`, run by `scripts/verify/profiles.mjs`). This script is
 * the cross-check that those offline rules match what the real CLI does, and it runs
 * wherever the CLIs happen to exist (a developer host), never in CI.
 *
 * Every probe runs in a throwaway HOME (never the real `~/.claude`, `~/.codex`,
 * `~/.openclaw`, `~/.pi`) and touches no network. A host whose CLI is absent is SKIPPED,
 * not failed, so the script is safe to run anywhere.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Env that discourages any network/update behaviour in the host CLIs. */
const OFFLINE_ENV = {
  CI: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
  OPENCLAW_DISABLE_UPDATE_CHECK: "1",
  NO_COLOR: "1",
};

/**
 * One probe per host. `steps` are run in order with cwd = the repository root; `home`
 * names the dot-directory the CLI keeps its config in (relative to the throwaway HOME).
 * `expect` asserts a substring that a *recognition* run must print.
 *
 * @type {Array<{host: string, bin: string, home: string, configEnv?: string, steps: string[][], expect: (output: string) => string|null}>}
 */
export const PROBES = [
  {
    host: "openclaw",
    bin: "openclaw",
    home: ".openclaw",
    steps: [
      ["plugins", "install", join(ROOT, "plugins/claude"), "--link", "--force", "--accept-capabilities"],
      ["plugins", "inspect", "task-panel"],
    ],
    expect: (output) => {
      if (!/Format:\s*bundle/.test(output)) return "expected `Format: bundle`";
      if (!/Bundle format:\s*claude/.test(output)) return "expected `Bundle format: claude`";
      if (!/Bundle capabilities:\s*skills/.test(output)) return "expected `Bundle capabilities: skills`";
      return null;
    },
  },
  {
    host: "claude",
    bin: "claude",
    home: ".claude",
    configEnv: "CLAUDE_CONFIG_DIR",
    steps: [
      ["plugin", "marketplace", "add", ROOT, "--json"],
      ["plugin", "marketplace", "list", "--json"],
    ],
    expect: (output) => (/task-panel-marketplace/.test(output) ? null : "expected task-panel-marketplace"),
  },
  {
    host: "codex",
    bin: "codex",
    home: ".codex",
    configEnv: "CODEX_HOME",
    steps: [
      ["plugin", "marketplace", "add", ROOT],
      ["plugin", "list"],
    ],
    expect: (output) =>
      /task-panel@task-panel-marketplace/.test(output) ? null : "expected task-panel@task-panel-marketplace",
  },
  {
    host: "pi",
    bin: "pi",
    home: ".pi",
    // A path source, so nothing is fetched.
    steps: [
      ["install", join(ROOT, "plugins/pi")],
      ["list"],
    ],
    expect: (output) => (/plugins\/pi/.test(output) ? null : "expected the installed ./plugins/pi package"),
  },
];

function tail(text, lines = 15) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-lines).join("\n");
}

/** Run one host probe in an isolated HOME. Returns a result row. */
export function runProbe(probe, timeoutMs) {
  const home = mkdtempSync(join(tmpdir(), `taskpanel-hostcli-${probe.host}-`));
  // Some CLIs refuse to start when their config dir is absent (codex: "failed to
  // resolve CODEX_HOME"), so create the host's dot-directory up front.
  mkdirSync(join(home, probe.home), { recursive: true });
  const env = {
    ...process.env,
    ...OFFLINE_ENV,
    HOME: home,
    ...(probe.configEnv ? { [probe.configEnv]: join(home, probe.home) } : {}),
  };

  const transcripts = [];
  let skipped = false;
  let failed = null;

  try {
    for (const args of probe.steps) {
      const res = spawnSync(probe.bin, args, { cwd: ROOT, env, encoding: "utf8", timeout: timeoutMs });
      if (res.error?.code === "ENOENT") {
        skipped = true;
        break;
      }
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      transcripts.push(`$ ${probe.bin} ${args.join(" ")}\n${tail(out)}`);
      if (res.error) {
        failed = `${probe.bin} ${args.join(" ")}: ${res.error.message}`;
        break;
      }
      if (res.status !== 0) {
        failed = `${probe.bin} ${args.join(" ")} exited ${res.status}`;
        break;
      }
    }

    if (skipped) return { host: probe.host, status: "SKIP", detail: `${probe.bin} not on PATH`, transcripts };

    if (!failed) {
      const output = transcripts.join("\n");
      const problem = probe.expect(output);
      if (problem) failed = problem;
    }

    return {
      host: probe.host,
      status: failed ? "FAIL" : "PASS",
      detail: failed ?? "recognized",
      transcripts,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string", multiple: true, short: "H" },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/host-cli.mjs [--host <host>] [--timeout <ms>] [--json]\n\n" +
        "  Supplementary: drives each host's real CLI in a throwaway HOME. Absent CLIs are skipped.\n",
    );
    return 0;
  }

  const timeoutMs = Number(values.timeout ?? 90_000);
  const wanted = (values.host ?? []).flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  const probes = wanted.length ? PROBES.filter((p) => wanted.includes(p.host)) : PROBES;

  const results = [];
  for (const probe of probes) {
    if (!values.json) process.stdout.write(`\n== ${probe.host} (${probe.bin}) ==\n`);
    const row = runProbe(probe, timeoutMs);
    if (!values.json && row.status !== "SKIP") process.stdout.write(`${row.transcripts.join("\n\n")}\n`);
    results.push(row);
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write("\n== SUMMARY ==\n");
    for (const row of results) {
      process.stdout.write(`${row.status}  ${row.host.padEnd(9)} ${row.detail}\n`);
    }
    const ran = results.filter((r) => r.status !== "SKIP");
    process.stdout.write(
      `\n${ran.filter((r) => r.status === "PASS").length} passed, ` +
        `${ran.filter((r) => r.status === "FAIL").length} failed, ` +
        `${results.length - ran.length} skipped (CLI absent)\n`,
    );
  }

  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

// Only run when executed directly, so tests can import PROBES / runProbe.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
