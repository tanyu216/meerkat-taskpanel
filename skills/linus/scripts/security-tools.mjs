#!/usr/bin/env node
/**
 * Detect the free security tools the team's scan needs — and, only when asked, install
 * or upgrade them.
 *
 * `--check` (the default) reads PATH, runs each tool's version command and compares it
 * with the recorded floor in `../assets/security/toolchain.json`. The same pass reads the
 * project's CI configuration and reports, per arm, whether the pipeline already runs a
 * scanner. It never writes, never reaches the network and never invokes a package manager.
 *
 * `--install` (missing tools) and `--upgrade` (behind the recorded recommendation) are
 * explicit, name the tools they act on, and print the command when this host has no
 * supported manager.
 *
 * `--ci-plan` shows the workflow file that would close a CI gap; `--ci-write` creates it,
 * one self-contained file per arm, and only for GitHub Actions. It never parses, appends
 * to or overwrites an existing YAML file, and any conflict aborts every write.
 *
 * Exit: 0 the check ran / the requested actions succeeded, 1 a required tool is missing,
 * behind or unreadable, or a CI write was refused, 2 usage, 3 an action was requested and
 * no manager is available.
 */

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./lib/entry-guard.mjs";
import { writeAtomic } from "./lib/atomic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX = resolve(HERE, "..", "assets", "security", "toolchain.json");
const ASSET_ROOT = resolve(HERE, "..", "assets", "security");
const MANAGERS = ["brew", "go", "pipx", "gh"];

const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, BLOCKED: 3 };

/** Recognised CI providers, in priority order. Fixed patterns — no glob engine. */
const CI_MARKERS = [
  { provider: "github-actions", dirs: [{ dir: ".github/workflows", pattern: /\.ya?ml$/i }] },
  { provider: "gitlab", files: [".gitlab-ci.yml"] },
  { provider: "circleci", files: [".circleci/config.yml", ".circleci/config.yaml"] },
  { provider: "travis", files: [".travis.yml"] },
  { provider: "azure-pipelines", files: ["azure-pipelines.yml", ".azure-pipelines.yml"] },
  { provider: "bitbucket", files: ["bitbucket-pipelines.yml"] },
  { provider: "jenkins", files: ["Jenkinsfile"] },
  { provider: "buildkite", files: [".buildkite/pipeline.yml", ".buildkite/pipeline.yaml"] },
];

/** Markers that say "this project runs CI somewhere we cannot judge". */
const CI_UNKNOWN_FILES = [
  ".cirrus.yml",
  "appveyor.yml",
  ".appveyor.yml",
  "cloudbuild.yml",
  "cloudbuild.yaml",
  "buildspec.yml",
  "buildspec.yaml",
  ".woodpecker.yml",
  ".drone.yml",
  ".drone.yaml",
];
const CI_UNKNOWN_DIRS = [".teamcity"];
/** A CI file bigger than this is not scanned; the arm is reported, not guessed. */
const CI_TEXT_LIMIT = 1024 * 1024;

const USAGE = `security-tools — check the free security tools the scan needs

  node security-tools.mjs [--check] [--print] [--install] [--upgrade]
                          [--project <dir>] [--tool <id>]... [--host github|other]
                          [--ci-plan|--ci-write] [--ci-arm <arm>]...
                          [--include-optional] [--dry-run] [--json]

  --check            detect only (the default): PATH, version, floor, and CI coverage
  --print            also print the command for every tool that is not ok
  --install          install a missing required tool (explicit; names one with --tool)
  --upgrade          upgrade a tool behind its recorded recommendation
  --ci-plan          show the workflow file that would close a CI gap; writes nothing
  --ci-write         create that file (GitHub Actions only; never overwrites)
  --ci-arm <arm>     restrict --ci-plan/--ci-write to one arm; repeatable
  --dry-run          print what --install/--upgrade would run, execute nothing
  --project <dir>    the project whose host decides the SAST default (default: cwd)
  --tool <id>        act on one tool; repeatable
  --host github|other  override the host read from <dir>/.git/config
  --include-optional also require the optional arms (SBOM)
  --json             print the report as JSON

Exit: ${EXIT.PASS} ok · ${EXIT.FAIL} a required tool needs attention, or a CI write was refused · ${EXIT.USAGE} usage · ${EXIT.BLOCKED} no supported package manager`;

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
    ciPlan: false,
    ciWrite: false,
    ciArms: [],
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
      case "--ci-plan": opts.ciPlan = true; break;
      case "--ci-write": opts.ciWrite = true; break;
      case "--ci-arm": opts.ciArms.push(take()); break;
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

/** Every recognised CI file under the project, plus the markers we refuse to judge. */
function listCiFiles(projectDir) {
  const files = [];
  let provider = null;
  for (const marker of CI_MARKERS) {
    const found = [];
    for (const dir of marker.dirs ?? []) {
      const full = join(projectDir, dir.dir);
      if (!existsSync(full)) continue;
      let names;
      try {
        names = readdirSync(full);
      } catch {
        names = [];
      }
      for (const name of names.sort()) {
        if (dir.pattern.test(name)) found.push(`${dir.dir}/${name}`);
      }
    }
    for (const file of marker.files ?? []) {
      if (existsSync(join(projectDir, file))) found.push(file);
    }
    if (found.length === 0) continue;
    if (provider === null) provider = marker.provider;
    files.push(...found);
  }
  const unknown = [
    ...CI_UNKNOWN_FILES.filter((file) => existsSync(join(projectDir, file))),
    ...CI_UNKNOWN_DIRS.filter((dir) => existsSync(join(projectDir, dir))),
  ];
  if (provider === null) provider = unknown.length > 0 ? "unknown" : "none";
  return { provider, files, unknown };
}

function readCiTexts(projectDir, files) {
  const texts = [];
  for (const file of files) {
    try {
      const text = readFileSync(join(projectDir, file), "utf8");
      if (text.length <= CI_TEXT_LIMIT) texts.push({ file, lines: text.split("\n") });
    } catch {
      // unreadable: this file contributes no evidence
    }
  }
  return texts;
}

/** The `ciMatch` tokens that appear on a non-comment line, with the first evidence. */
function matchArm(entry, texts) {
  const tokens = (entry.ciMatch ?? []).map((token) => token.toLowerCase());
  const matches = [];
  const evidence = [];
  for (const { file, lines } of texts) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trimStart().startsWith("#")) continue;
      const lower = line.toLowerCase();
      for (const token of tokens) {
        if (matches.includes(token) || !lower.includes(token)) continue;
        matches.push(token);
        evidence.push({ file, line: index + 1 });
      }
    }
  }
  return { matches, evidence };
}

/**
 * Per-arm CI coverage. A recognised pipeline is judged by token match; an unrecognised
 * one is reported `unknown` rather than guessed at, and no pipeline at all is `absent`
 * — an absence this skill does not treat as a finding.
 */
function detectCi(matrix, projectDir, opts) {
  const scan = listCiFiles(projectDir);
  const judged = scan.provider !== "none" && scan.provider !== "unknown";
  const texts = judged ? readCiTexts(projectDir, scan.files) : [];
  const named = new Set(opts.ciArms);
  const arms = {};
  for (const [name, entry] of Object.entries(matrix.arms ?? {})) {
    const optional = entry.optional === true;
    let state = "absent";
    let found = { matches: [], evidence: [] };
    if (scan.provider === "unknown") {
      state = "unknown";
    } else if (judged) {
      found = matchArm(entry, texts);
      state = found.matches.length > 0 ? "covered" : "missing";
    }
    arms[name] = { optional, state, matches: found.matches, evidence: found.evidence };
  }
  const missing = Object.entries(arms)
    .filter(([name, arm]) => arm.state === "missing"
      && (arm.optional !== true || opts.includeOptional === true || named.has(name)))
    .map(([name]) => name);
  const writable = scan.provider === "github-actions"
    && missing.every((name) => typeof matrix.arms[name]?.ciAsset === "string");
  return {
    detected: scan.provider !== "none",
    provider: scan.provider,
    files: scan.files,
    unknown: scan.unknown,
    writable,
    arms,
    missing,
  };
}

function ciTargetPath(asset) {
  return `.github/workflows/security-${basename(asset)}`;
}

/** A unified diff for a file that does not exist yet. */
function newFileDiff(target, content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [
    "--- /dev/null",
    `+++ b/${target}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/**
 * What each selected arm would take: a whole workflow file for GitHub Actions, a
 * provider-neutral command snippet everywhere else. Nothing is written here.
 */
function planCi(ci, matrix, host, selection, projectDir) {
  const proposed = [];
  const snippets = [];
  const writes = [];
  for (const name of selection) {
    const entry = matrix.arms?.[name] ?? {};
    const asset = ci.provider === "github-actions" ? entry.ciAsset : null;
    if (typeof asset === "string") {
      let content;
      try {
        content = readFileSync(join(ASSET_ROOT, asset), "utf8");
      } catch {
        return { error: `cannot read the CI asset ${asset}` };
      }
      const target = ciTargetPath(asset);
      const full = join(projectDir, target);
      const current = existsSync(full) ? readFileSync(full, "utf8") : null;
      const action = current === null ? "create" : (current === content ? "unchanged" : "conflict");
      writes.push({ arm: name, target, full, content, action });
      proposed.push({
        arm: name,
        target,
        action,
        diff: action === "create" ? newFileDiff(target, content) : null,
      });
      continue;
    }
    const id = name === "sast" ? (host.github ? entry.github : entry.other) : entry.default;
    snippets.push({ arm: name, tool: id ?? null, command: matrix.tools?.[id]?.ciCommand ?? null });
  }
  return { proposed, snippets, writes };
}

/** All-or-nothing: one conflict anywhere aborts every write. */
function writeCi(writes, dryRun) {
  const conflict = writes.find((entry) => entry.action === "conflict");
  if (conflict !== undefined) {
    return {
      ok: false,
      actions: writes.map((entry) => ({
        arm: entry.arm,
        target: entry.target,
        action: entry.action === "conflict" ? "conflict" : "skipped",
        error: entry.action === "conflict"
          ? "the file exists with different content; refusing to overwrite"
          : null,
      })),
    };
  }
  const actions = [];
  for (const entry of writes) {
    if (entry.action === "unchanged") {
      actions.push({ arm: entry.arm, target: entry.target, action: "unchanged", error: null });
      continue;
    }
    if (dryRun) {
      actions.push({ arm: entry.arm, target: entry.target, action: "would-create", error: null });
      continue;
    }
    try {
      mkdirSync(dirname(entry.full), { recursive: true });
      writeAtomic(entry.full, entry.content);
      actions.push({ arm: entry.arm, target: entry.target, action: "written", error: null });
    } catch (err) {
      actions.push({
        arm: entry.arm,
        target: entry.target,
        action: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: actions.every((entry) => entry.error === null), actions };
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
  const ci = report.ci;
  if (ci !== undefined) {
    lines.push("");
    lines.push(`ci: ${ci.provider}${ci.files.length > 0 ? ` (${ci.files.join(", ")})` : ""}`);
    for (const [arm, entry] of Object.entries(ci.arms)) {
      const evidence = entry.evidence?.[0];
      const matched = entry.matches?.length > 0
        ? `  ${entry.matches.join(", ")}${evidence ? ` (${evidence.file}:${evidence.line})` : ""}`
        : "";
      lines.push(`  ${arm.padEnd(18)} ${entry.state}${matched}`);
    }
    for (const entry of ci.proposed ?? []) lines.push(`  ${entry.action} ${entry.target}`);
    for (const entry of ci.snippets ?? []) lines.push(`  ${entry.arm} (${entry.tool ?? "—"}): ${entry.command ?? "—"}`);
    for (const entry of ci.actions ?? []) {
      lines.push(`  ${entry.action} ${entry.target}${entry.error ? `: ${entry.error}` : ""}`);
    }
    if (ci.error) lines.push(`  error: ${ci.error}`);
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
  if (opts.ciPlan && opts.ciWrite) {
    console.error("security-tools: --ci-plan and --ci-write are mutually exclusive");
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
  for (const arm of opts.ciArms) {
    if (!matrix.arms?.[arm]) {
      console.error(`security-tools: the matrix has no arm "${arm}"`);
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

  const ci = detectCi(matrix, projectDir, opts);
  const namedCi = new Set(opts.ciArms);
  const ciSelection = namedCi.size > 0
    ? ci.missing.filter((name) => namedCi.has(name))
    : ci.missing;

  let proposed = [];
  let snippets = [];
  let ciActions = [];
  let ciError = null;
  if (opts.ciPlan || opts.ciWrite) {
    const plan = planCi(ci, matrix, host, ciSelection, projectDir);
    if (plan.error !== undefined) {
      ciError = plan.error;
    } else if (opts.ciPlan) {
      ({ proposed, snippets } = plan);
    } else if (ci.provider === "none") {
      ciError = `no CI configuration found in ${projectDir}`;
    } else if (ci.provider === "unknown") {
      ({ snippets } = plan);
      ciError = `the CI configuration is not one this skill recognises (${ci.unknown.join(", ")}); compose the addition by hand`;
    } else if (ci.provider !== "github-actions") {
      ({ snippets } = plan);
      ciError = `cannot write a ${ci.provider} pipeline from this script; compose the addition in that provider's own file, from the printed commands`;
    } else {
      const written = writeCi(plan.writes, opts.dryRun);
      ciActions = written.actions;
      if (!written.ok) {
        ciError = "a target file exists with different content; nothing was written";
      }
    }
  }

  const attention = new Set(["missing", "outdated", "update-available", "unknown"]);
  const requiredOk = tools.every((entry) => !entry.required || !attention.has(entry.state));
  const blocked = actions.filter((action) => action.action === "no-manager");
  const failed = actions.filter((action) => action.executed && !action.ok);

  let exitCode;
  if (opts.dryRun) exitCode = EXIT.PASS;
  else if (blocked.length > 0) exitCode = EXIT.BLOCKED;
  else if (failed.length > 0 || ciError !== null) exitCode = EXIT.FAIL;
  else if (opts.install || opts.upgrade || opts.print || opts.ciPlan || opts.ciWrite) exitCode = EXIT.PASS;
  else exitCode = requiredOk ? EXIT.PASS : EXIT.FAIL;

  const ciReport = {
    detected: ci.detected,
    provider: ci.provider,
    files: ci.files,
    writable: ci.writable,
    arms: ci.arms,
    missing: ci.missing,
    ok: ci.missing.length === 0 && ciError === null,
  };
  if (ci.unknown.length > 0) ciReport.unknown = ci.unknown;
  if (opts.ciPlan) {
    ciReport.proposed = proposed;
    ciReport.snippets = snippets;
  }
  if (opts.ciWrite) ciReport.actions = ciActions;
  if (ciError !== null) ciReport.error = ciError;

  const report = {
    version: 1,
    project: projectDir,
    host,
    tools: tools.map(({ tool, ...rest }) => rest),
    actions,
    ci: ciReport,
    warnings: [
      ...tools
        .filter((entry) => entry.state === "unknown")
        .map((entry) => `${entry.id}: the version could not be read`),
      ...(ci.provider === "unknown"
        ? [`ci: an unrecognised CI configuration was found (${ci.unknown.join(", ")}); coverage was not judged`]
        : []),
      ...(ciError !== null ? [`ci: ${ciError}`] : []),
    ],
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
