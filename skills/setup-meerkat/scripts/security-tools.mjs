#!/usr/bin/env node
/**
 * Detect the free security tools the team's scan needs — and, only when asked, install
 * or upgrade them.
 *
 * `--check` (the default) reads PATH, runs each tool's version command and compares it
 * with the recorded floor in `../assets/security/toolchain.json`. It never writes, never
 * reaches the network and never invokes a package manager. `--install` (missing tools)
 * and `--upgrade` (behind the recorded recommendation) are explicit, name the tools they
 * act on, and print the command when this host has no supported manager.
 *
 * Exit: 0 the check ran / the requested actions succeeded, 1 a required tool is missing,
 * behind or unreadable, 2 usage, 3 an action was requested and no manager is available.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./lib/entry-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX = resolve(HERE, "..", "assets", "security", "toolchain.json");
const MANAGERS = ["brew", "go", "pipx", "gh"];

const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, BLOCKED: 3 };

const USAGE = `security-tools — check the free security tools the scan needs

  node security-tools.mjs [--check] [--print] [--install] [--upgrade]
                          [--project <dir>] [--tool <id>]... [--host github|other]
                          [--include-optional] [--dry-run] [--json]

  --check            detect only (the default): PATH, version, floor
  --print            also print the command for every tool that is not ok
  --install          install a missing required tool (explicit; names one with --tool)
  --upgrade          upgrade a tool behind its recorded recommendation
  --dry-run          print what --install/--upgrade would run, execute nothing
  --project <dir>    the project whose host decides the SAST default (default: cwd)
  --tool <id>        act on one tool; repeatable
  --host github|other  override the host read from <dir>/.git/config
  --include-optional also require the optional arms (SBOM)
  --json             print the report as JSON

Exit: ${EXIT.PASS} ok · ${EXIT.FAIL} a required tool needs attention · ${EXIT.USAGE} usage · ${EXIT.BLOCKED} no supported package manager`;

function parse(argv) {
  const opts = {
    check: true,
    print: false,
    install: false,
    upgrade: false,
    dryRun: false,
    json: false,
    project: null,
    tools: [],
    host: null,
    includeOptional: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--check": opts.check = true; break;
      case "--print": opts.print = true; break;
      case "--install": opts.install = true; break;
      case "--upgrade": opts.upgrade = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--json": opts.json = true; break;
      case "--project": opts.project = take(); break;
      case "--tool": opts.tools.push(take()); break;
      case "--host": opts.host = take(); break;
      case "--include-optional": opts.includeOptional = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/** The first executable named `name` on PATH, without spawning a shell. */
function findExecutable(name, env = process.env) {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** `[major, minor, patch]`, or `null`. */
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text));
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function probeVersion(bin, tool) {
  const pattern = new RegExp(tool.versionPattern ?? "(\\d+\\.\\d+\\.\\d+)", "i");
  const groups = Array.isArray(tool.versionArgs) ? tool.versionArgs : [];
  for (const args of groups) {
    const result = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = pattern.exec(text);
    if (match !== null) return match[1] ?? match[0];
  }
  return null;
}

/** The first `url = ...` in `<project>/.git/config`; no git process. */
function detectHost(projectDir, override) {
  const config = join(projectDir, ".git", "config");
  let remote = null;
  if (existsSync(config)) {
    try {
      const match = /^\s*url\s*=\s*(.+)$/m.exec(readFileSync(config, "utf8"));
      if (match !== null) remote = match[1].trim();
    } catch {
      remote = null;
    }
  }
  const github = override === null || override === undefined
    ? (remote ?? "").toLowerCase().includes("github.com")
    : override === "github";
  return { github, remote };
}

function resolveTools(matrix, opts, host) {
  const arms = matrix.arms ?? {};
  const selections = [];
  for (const [arm, entry] of Object.entries(arms)) {
    if (arm === "sast") {
      selections.push({ arm, id: host.github ? entry.github : entry.other, required: entry.optional !== true });
    } else if (entry.default) {
      selections.push({ arm, id: entry.default, required: entry.optional !== true });
    }
  }
  if (opts.includeOptional) {
    for (const selection of selections) selection.required = true;
  }
  if (opts.tools.length > 0) {
    const named = new Set(opts.tools);
    return [...named].map((id) => {
      let arm = "extra";
      for (const [name, entry] of Object.entries(arms)) {
        const ids = [entry.default, entry.github, entry.other, ...(entry.alternatives ?? [])].filter(Boolean);
        if (ids.includes(id)) {
          arm = name;
          break;
        }
      }
      return { arm, id, required: true };
    });
  }
  return selections;
}

function evaluate(id, tool, env) {
  if (tool.local === false) return { state: "ci", version: null, path: null };
  const path = findExecutable(id, env);
  if (path === null) return { state: "missing", version: null, path: null };
  const version = probeVersion(path, tool);
  const parsed = version === null ? null : parseVersion(version);
  if (parsed === null) return { state: "unknown", version, path };
  const min = parseVersion(tool.minVersion) ?? [0, 0, 0];
  const recommended = parseVersion(tool.recommended ?? tool.minVersion) ?? min;
  if (compareVersions(parsed, min) < 0) return { state: "outdated", version, path };
  if (compareVersions(parsed, recommended) < 0) return { state: "update-available", version, path };
  return { state: "ok", version, path };
}

function managerFor(tool, action, env) {
  const commands = tool[action] ?? {};
  for (const manager of MANAGERS) {
    if (!Array.isArray(commands[manager])) continue;
    if (findExecutable(manager, env) !== null) return { manager, command: commands[manager] };
  }
  return null;
}

/** The command a human would copy when this host has no manager. */
function manualCommand(tool, action) {
  const commands = tool[action] ?? {};
  for (const manager of MANAGERS) {
    if (Array.isArray(commands[manager])) return commands[manager].join(" ");
  }
  return null;
}

function planAndRun(tools, opts, env) {
  const actions = [];
  for (const entry of tools) {
    if (!entry.required) continue;
    const install = opts.install && entry.state === "missing";
    const upgrade = opts.upgrade && (entry.state === "outdated" || entry.state === "update-available");
    if (!install && !upgrade) continue;
    const kind = install ? "install" : "upgrade";
    const resolved = managerFor(entry.tool, kind, env);
    if (resolved === null) {
      actions.push({
        tool: entry.id,
        action: "no-manager",
        command: null,
        display: manualCommand(entry.tool, kind),
        executed: false,
        ok: false,
        error: `no supported package manager; install from ${entry.tool.repo}`,
      });
      continue;
    }
    const display = resolved.command.join(" ");
    if (opts.dryRun) {
      actions.push({
        tool: entry.id,
        action: `would-${kind}`,
        command: resolved.command,
        display,
        executed: false,
        ok: true,
        error: null,
      });
      continue;
    }
    const result = spawnSync(resolved.command[0], resolved.command.slice(1), {
      encoding: "utf8",
      timeout: 600000,
    });
    const ok = result.status === 0;
    actions.push({
      tool: entry.id,
      action: kind,
      command: resolved.command,
      display,
      executed: true,
      ok,
      error: ok ? null : (String(result.stderr ?? "").trim() || `exit ${result.status}`),
    });
  }
  return actions;
}

function renderText(report, opts) {
  const lines = [`security-tools: ${report.project}`];
  for (const entry of report.tools) {
    const behind = entry.state === "outdated" || entry.state === "update-available";
    const command = opts.print || entry.state === "missing" || behind
      ? (behind ? entry.upgrade ?? entry.install : entry.install ?? entry.upgrade) ?? ""
      : "";
    lines.push(
      [
        entry.state.padEnd(16),
        entry.id.padEnd(12),
        (entry.version ?? "—").padEnd(10),
        command,
      ].join("  ").trimEnd(),
    );
  }
  for (const action of report.actions) {
    lines.push(`  ${action.action} ${action.tool}: ${action.display ?? action.error ?? ""}`);
  }
  lines.push(report.ok ? "security-tools: every required tool is ok" : "security-tools: attention needed");
  return lines.join("\n");
}

function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`security-tools: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    console.log(USAGE);
    return EXIT.PASS;
  }
  if (opts.host !== null && opts.host !== "github" && opts.host !== "other") {
    console.error(`security-tools: --host must be "github" or "other", got "${opts.host}"`);
    return EXIT.USAGE;
  }

  let matrix;
  try {
    matrix = JSON.parse(readFileSync(DEFAULT_MATRIX, "utf8"));
  } catch (err) {
    console.error(`security-tools: cannot read the toolchain matrix: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  const projectDir = resolve(opts.project ?? process.cwd());
  const host = detectHost(projectDir, opts.host);
  for (const id of opts.tools) {
    if (!matrix.tools?.[id]) {
      console.error(`security-tools: the matrix has no entry for "${id}"`);
      return EXIT.USAGE;
    }
  }
  const selections = resolveTools(matrix, opts, host);

  const tools = selections.map((selection) => {
    const tool = matrix.tools[selection.id];
    const evaluated = evaluate(selection.id, tool, process.env);
    return {
      id: selection.id,
      arm: selection.arm,
      required: selection.required,
      found: evaluated.state !== "missing" && evaluated.state !== "ci",
      path: evaluated.path,
      version: evaluated.version,
      min: tool.minVersion ?? null,
      recommended: tool.recommended ?? tool.minVersion ?? null,
      state: evaluated.state,
      manager: managerFor(tool, evaluated.state === "missing" ? "install" : "upgrade", process.env)?.manager ?? null,
      install: manualCommand(tool, "install"),
      upgrade: manualCommand(tool, "upgrade"),
      url: tool.repo ?? null,
      note: tool.note ?? null,
      tool,
    };
  });

  const actions = planAndRun(tools, opts, process.env);

  const attention = new Set(["missing", "outdated", "update-available", "unknown"]);
  const requiredOk = tools.every((entry) => !entry.required || !attention.has(entry.state));
  const blocked = actions.filter((action) => action.action === "no-manager");
  const failed = actions.filter((action) => action.executed && !action.ok);

  let exitCode;
  if (opts.dryRun) exitCode = EXIT.PASS;
  else if (blocked.length > 0) exitCode = EXIT.BLOCKED;
  else if (failed.length > 0) exitCode = EXIT.FAIL;
  else if (opts.install || opts.upgrade) exitCode = EXIT.PASS;
  else if (opts.print) exitCode = EXIT.PASS;
  else exitCode = requiredOk ? EXIT.PASS : EXIT.FAIL;

  const report = {
    version: 1,
    project: projectDir,
    host,
    tools: tools.map(({ tool, ...rest }) => rest),
    actions,
    warnings: tools
      .filter((entry) => entry.state === "unknown")
      .map((entry) => `${entry.id}: the version could not be read`),
    ok: requiredOk,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    for (const action of blocked) process.stderr.write(`security-tools: ${action.tool}: ${action.error}\n`);
    for (const warning of report.warnings) process.stderr.write(`security-tools: ${warning}\n`);
  } else {
    console.log(renderText(report, opts));
    for (const action of blocked) console.error(`security-tools: ${action.tool}: ${action.error}`);
  }

  return exitCode;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
