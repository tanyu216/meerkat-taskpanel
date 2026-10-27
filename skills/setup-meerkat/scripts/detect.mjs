#!/usr/bin/env node
/**
 * Read-only detection for `/setup-meerkat`.
 *
 * It answers: what is installed, which board is this CLI pointed at, is that
 * board local or remote, which skills/loop state/supervisor exist, which roles
 * root is effective, what is the fixed human name, and is the Matt Pocock setup
 * skill present. It never writes, never starts a board (`TASKD_NO_AUTOSTART=1`)
 * and never calls a board command other than `--version`.
 */

import { accessSync, existsSync, readdirSync, readFileSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { isEntryPoint } from "./lib/entry-guard.mjs";
import { parseEnvText } from "./lib/env-merge.mjs";
import {
  AGENT_KINDS,
  agentBase,
  configFile,
  isAgentKind,
  loopStateDir,
  loopSkillDir,
  serverRoot,
  shimFile,
  skillDir,
} from "./lib/agent-kinds.mjs";
import { readTeam } from "./lib/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "http://localhost:9527";
const STALE_POOL_MS = 5 * 60 * 1000;

const USAGE = `detect — read-only Meerkat TaskPanel discovery

  node detect.mjs [--json] [--home <dir>] [--project <dir>]
                  [--actor-kind <kind|all>] [--checkout <dir>]
                  [--url <url>] [--env-file <path>] [--timeout-ms <n>]
                  [--no-network] [--taskctl <path>] [--fail-on-missing]

Exit: 0 detection ran, 1 with --fail-on-missing, 2 usage.`;

function parse(argv) {
  const opts = {
    json: false,
    home: process.env.HOME ?? homedir(),
    project: process.cwd(),
    actorKind: "claude",
    checkout: null,
    url: null,
    envFile: null,
    timeoutMs: 1000,
    network: true,
    taskctl: null,
    rolesDir: null,
    failOnMissing: false,
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
      case "--json": opts.json = true; break;
      case "--home": opts.home = resolve(take()); break;
      case "--project": opts.project = resolve(take()); break;
      case "--actor-kind": opts.actorKind = take(); break;
      case "--checkout": opts.checkout = resolve(take()); break;
      case "--url": opts.url = take(); break;
      case "--env-file": opts.envFile = resolve(take()); break;
      case "--timeout-ms": opts.timeoutMs = Number.parseInt(take(), 10); break;
      case "--no-network": opts.network = false; break;
      case "--taskctl": opts.taskctl = resolve(take()); break;
      case "--roles-dir": opts.rolesDir = resolve(take()); break;
      case "--fail-on-missing": opts.failOnMissing = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const readJson = (path) => {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const executable = (path) => {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const looksLikeCheckout = (dir) =>
  typeof dir === "string" &&
  existsSync(join(dir, "src", "cli", "index.mjs")) &&
  existsSync(join(dir, "skills"));

function which(command, env) {
  const path = env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return null;
}

function isLoopback(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (host.startsWith("::ffff:127.")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d+$/.test(part));
}

function pointerPath(home, env) {
  if (typeof env.TASKD_RUNTIME_POINTER === "string" && env.TASKD_RUNTIME_POINTER !== "") {
    return resolve(env.TASKD_RUNTIME_POINTER);
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "MeerkatTaskPanel", "runtime.json");
  }
  const state = env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, "MeerkatTaskPanel", "runtime.json")
    : join(home, ".local", "state", "MeerkatTaskPanel", "runtime.json");
  return state;
}

function resolveCheckout(opts, config) {
  const candidates = [
    ["flag", opts.checkout],
    ["env-root", process.env.MEERKAT_TASKPANEL_ROOT],
    ["env-repo", process.env.MEERKAT_TASKPANEL_REPO],
    ["cwd", process.cwd()],
    ["config", config.MEERKAT_TASKPANEL_REPO],
  ];
  for (const [source, dir] of candidates) {
    if (typeof dir === "string" && looksLikeCheckout(dir)) {
      return { found: true, path: resolve(dir), source };
    }
  }
  return { found: false, path: null, source: null };
}

function resolveEnvFile(opts, checkout, home, kind, env) {
  const explicit = opts.envFile ?? (env.MEERKAT_TASKPANEL_ENV_FILE ? resolve(env.MEERKAT_TASKPANEL_ENV_FILE) : null);
  if (explicit) return explicit;
  const runtime = join(serverRoot(home), ".env");
  if (existsSync(runtime)) return runtime;
  if (checkout?.found) {
    const local = join(checkout.path, ".env");
    if (existsSync(local)) return local;
  }
  return null;
}

function resolveUrl(opts, env, envFile, home) {
  if (opts.url) return { url: opts.url, source: "flag" };
  if (env.TASKD_URL) return { url: env.TASKD_URL, source: "env" };
  const file = envFile ? parseEnvText(readText(envFile) ?? "") : new Map();
  if (file.get("TASKD_URL")) return { url: file.get("TASKD_URL"), source: "env-file" };
  const pointer = readJson(pointerPath(home, env));
  if (pointer && typeof pointer.url === "string" && pointer.url !== "") {
    return { url: pointer.url, source: "pointer", pointer };
  }
  return { url: DEFAULT_URL, source: "default" };
}

async function probeHealth(url, timeoutMs) {
  try {
    const response = await fetch(`${String(url).replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json();
    const ok = body?.status === "ok" || body?.data?.status === "ok";
    return {
      reachable: ok,
      health: ok ? { status: "ok", version: body?.version ?? body?.data?.version ?? null } : null,
      error: ok ? null : `unexpected /health response (HTTP ${response.status})`,
    };
  } catch (err) {
    return { reachable: false, health: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function runVersion(command, args, env) {
  const run = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 2000,
    env: { ...env, TASKD_NO_AUTOSTART: "1" },
  });
  if (run.error || run.status !== 0) {
    return { version: null, schemaVersion: null, error: run.error?.message ?? run.stderr?.trim() ?? `exit ${run.status}` };
  }
  try {
    const body = JSON.parse(run.stdout);
    return {
      version: body?.data?.version ?? null,
      schemaVersion: body?.data?.schema_version ?? null,
      error: null,
    };
  } catch {
    return { version: null, schemaVersion: null, error: "unparseable --version output" };
  }
}

function detectTaskctl(opts, checkout, home, kind, env) {
  const candidates = [];
  if (opts.taskctl) candidates.push(["flag", opts.taskctl]);
  const onPath = which("taskctl", env);
  if (onPath) candidates.push(["path", onPath]);
  const runtime = join(serverRoot(home), "bin", "taskctl");
  if (executable(runtime)) candidates.push(["server", runtime]);
  const shim = shimFile(home, kind);
  if (executable(shim)) candidates.push(["shim", shim]);
  if (checkout?.found) candidates.push(["checkout", join(checkout.path, "src", "cli", "index.mjs")]);

  for (const [source, path] of candidates) {
    const command = path.endsWith(".mjs") ? process.execPath : path;
    const args = path.endsWith(".mjs")
      ? [path, "--version", "--json"]
      : ["--version", "--json"];
    const result = runVersion(command, args, env);
    if (result.version) return { found: true, path, source, ...result };
  }
  return { found: false, path: null, source: null, version: null, schemaVersion: null, error: "taskctl not found" };
}

function detectSkill(home, kind, name) {
  const path = join(skillDir(home, kind, name), "SKILL.md");
  return { installed: existsSync(path), path: existsSync(path) ? path : null };
}

function detectLoopState(home, kind) {
  // The loop itself ships with the toolkit; what an install leaves here is its
  // state directory (queue, ledger, sessions.state.json).
  const path = loopStateDir(home, kind);
  return { installed: existsSync(path), path: existsSync(path) ? path : null };
}

function detectSupervisor(home, kind) {
  const base = agentBase(home, kind);
  const scheduling = join(base, "scheduling");
  const units = [];
  for (const system of ["launchd", "systemd", "cron"]) {
    const dir = join(scheduling, system);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSafe(dir)) units.push(join(dir, name));
    } catch {
      // ignore
    }
  }
  const state = readJson(join(loopStateDir(home, kind), "sessions.state.json"));
  const pid = Number.isInteger(state?.poolPid) ? state.poolPid : null;
  let alive = false;
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  const beat = Date.parse(String(state?.heartbeatAt ?? ""));
  const fresh = Number.isFinite(beat) && Date.now() - beat <= STALE_POOL_MS;
  return {
    installed: units.length > 0,
    state: loopStateDir(home, kind),
    units,
    running: alive && fresh,
    poolPid: pid,
    reason: alive ? (fresh ? null : "heartbeat is stale") : pid === null ? "no pool pid" : "pool pid is gone",
  };
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function rolesAt(dir) {
  if (!dir || !existsSync(join(dir, "manifest.json"))) {
    return { present: false, manifest: null, roles: 0, valid: false, warnings: [], errors: [] };
  }
  const team = readTeam(dir);
  return {
    present: true,
    manifest: join(dir, "manifest.json"),
    roles: team.roles.length,
    valid: team.ok,
    warnings: team.warnings,
    errors: team.errors,
  };
}

function detectHuman(opts, home, kind, env, envFile) {
  const candidates = [];
  if (env.TASKCTL_HUMAN) candidates.push(["env", env.TASKCTL_HUMAN]);
  const settings = readJson(join(home, ".claude", "settings.json"));
  if (settings?.env?.TASKCTL_HUMAN) candidates.push(["settings", settings.env.TASKCTL_HUMAN]);
  const config = parseEnvText(readText(configFile(home, kind)) ?? "");
  if (config.get("TASKCTL_HUMAN")) candidates.push(["config", config.get("TASKCTL_HUMAN")]);
  if (config.get("MEERKAT_TASKPANEL_HUMAN_NAME")) candidates.push(["installer-config", config.get("MEERKAT_TASKPANEL_HUMAN_NAME")]);
  const shim = readText(shimFile(home, kind));
  if (shim) {
    const match =
      shim.match(/^human="\$\{TASKCTL_HUMAN:-([^}]*)\}"/m) ??
      shim.match(/^human="([^"]+)"/m) ??
      shim.match(/TASKCTL_HUMAN[=:]\s*["']?([^"'\n]+)/m);
    if (match && match[1].trim() !== "" && !match[1].includes("{{")) candidates.push(["shim", match[1]]);
  }
  if (envFile) {
    const file = parseEnvText(readText(envFile) ?? "");
    if (file.get("TASKCTL_HUMAN")) candidates.push(["env-file", file.get("TASKCTL_HUMAN")]);
    if (file.get("MEERKAT_TASKPANEL_HUMAN_NAME")) candidates.push(["env-file-installer", file.get("MEERKAT_TASKPANEL_HUMAN_NAME")]);
  }
  for (const [source, name] of candidates) {
    const value = String(name).trim();
    if (value !== "") return { configured: true, name: value, source };
  }
  const fallback = env.USER || env.LOGNAME || "local";
  return { configured: false, name: fallback, source: "fallback" };
}

function detectMatt(project, home) {
  const skill = join(home, ".claude", "skills", "setup-matt-pocock-skills", "SKILL.md");
  const candidates = [
    join(project, "docs", "agents", "issue-tracker.md"),
    join(project, "docs", "agents", "issue-tracer.md"),
    join(project, "team", "issue-tracer.md"),
    join(project, "team", "issue-tracker.md"),
  ];
  let tracker = null;
  for (const path of candidates) {
    const text = readText(path);
    if (text === null) continue;
    const mentions = /meerkat|taskctl|taskpanel/i.test(text);
    tracker = { path, exists: true, mentionsTaskpanel: mentions, unrelated: !mentions };
    break;
  }
  return {
    skill: { installed: existsSync(skill), path: existsSync(skill) ? skill : null },
    tracker: tracker ?? { path: null, exists: false, mentionsTaskpanel: false, unrelated: false },
  };
}

/**
 * The extension directories `pi-subagents` installs into (its docs name the first).
 * Pi has no native subagent mechanism, and the loop's project session needs one to
 * spawn the worker/reviewer. A directory check is a heuristic, not a load test.
 */
const PI_SUBAGENT_DIRS = [
  join(".pi", "agent", "extensions", "subagent"),
  join(".pi", "agent", "extensions", "pi-subagents"),
];
const PI_SUBAGENTS_INSTALL = "pi install npm:pi-subagents";

/** @param {string} home */
function detectPiSubagents(home) {
  const candidates = PI_SUBAGENT_DIRS.map((rel) => join(home, rel));
  const found = candidates.find((dir) => existsSync(dir)) ?? null;
  return {
    installed: found !== null,
    extensionDir: found ?? candidates[0],
    recommended: found === null ? PI_SUBAGENTS_INSTALL : null,
  };
}

function humanReport(report) {
  const lines = [];
  lines.push(`detect: ${report.actorKind} on ${report.home}`);
  lines.push(`  checkout:  ${report.checkout.found ? report.checkout.path : "not found"} (${report.checkout.source ?? "-"})`);
  lines.push(`  taskctl:   ${report.taskctl.found ? `${report.taskctl.path} ${report.taskctl.version ?? ""}` : "not found"}`);
  lines.push(`  server:    ${report.server.url} (${report.server.urlSource}); ${report.server.class}; ${report.server.probed ? (report.server.reachable ? "reachable" : "unreachable") : "not probed"}`);
  lines.push(`  skills:    board=${report.skills.board.installed} loop=${report.skills.loop.installed} setup=${report.skills.setup.installed}`);
  lines.push(`  loop state: ${report.loopState.installed ? report.loopState.path : "not installed"}`);
  lines.push(`  supervisor: ${report.supervisor.running ? "running" : "not running"}${report.supervisor.reason ? ` (${report.supervisor.reason})` : ""}`);
  lines.push(`  roles:     global=${report.roles.global.present} project=${report.roles.project.present}${report.roles.explicit.present ? ` explicit=${report.roles.explicit.present}` : ""}`);
  lines.push(`  human:     ${report.human.name}${report.human.configured ? ` (${report.human.source})` : " (fallback; confirm)"}`);
  lines.push(`  matt:      skill=${report.mattPocock.skill.installed} tracker=${report.mattPocock.tracker.exists ? report.mattPocock.tracker.path : "none"}`);
  if (report.actorKind === "pi" || report.actorKind === "all") {
    lines.push(
      `  pi subagents: ${report.piSubagents.installed ? report.piSubagents.extensionDir : `missing (${report.piSubagents.recommended})`}`,
    );
  }
  if (report.missing.length > 0) lines.push(`  missing:   ${report.missing.join(", ")}`);
  for (const warning of report.warnings) lines.push(`  warning:   ${warning}`);
  return lines.join("\n");
}

async function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`detect: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const kindAll = opts.actorKind === "all";
  const kind = kindAll ? "claude" : opts.actorKind;
  if (!isAgentKind(kind)) {
    console.error(`detect: unknown actor kind ${JSON.stringify(opts.actorKind)}`);
    return 2;
  }

  const env = process.env;
  const config = parseEnvText(readText(configFile(opts.home, kind)) ?? "");
  const checkout = resolveCheckout(opts, config);
  const envFile = resolveEnvFile(opts, checkout, opts.home, kind, env);
  const resolved = resolveUrl(opts, env, envFile, opts.home);
  const loopback = isLoopback(new URL(resolved.url).hostname);
  const health = opts.network
    ? await probeHealth(resolved.url, Math.max(100, opts.timeoutMs))
    : { reachable: false, health: null, error: "network probe disabled" };
  const taskctl = detectTaskctl(opts, checkout, opts.home, kind, env);
  const skills = {
    board: detectSkill(opts.home, kind, "meerkat-taskpanel"),
    loop: detectSkill(opts.home, kind, "meerkat-loop"),
    setup: detectSkill(opts.home, kind, "setup-meerkat"),
  };
  const skillsByKind = {};
  for (const candidate of Object.keys(AGENT_KINDS)) {
    skillsByKind[candidate] = {
      board: detectSkill(opts.home, candidate, "meerkat-taskpanel").installed,
      loop: detectSkill(opts.home, candidate, "meerkat-loop").installed,
      setup: detectSkill(opts.home, candidate, "setup-meerkat").installed,
    };
  }
  const loopState = detectLoopState(opts.home, kind);
  const supervisor = detectSupervisor(opts.home, kind);
  const explicitRoles = opts.rolesDir
    ?? (env.MEERKAT_TASKPANEL_ROLES_DIR ? resolve(env.MEERKAT_TASKPANEL_ROLES_DIR) : null);
  const roles = {
    global: rolesAt(join(loopSkillDir(opts.home, kind), "roles")),
    project: rolesAt(join(opts.project, ".meerkat", "roles")),
    explicit: rolesAt(explicitRoles),
  };
  // The loader's precedence, resolved once so a caller need not re-derive it.
  const effectiveRoles =
    roles.explicit.present
      ? { source: "explicit", ...roles.explicit }
      : roles.project.present
        ? { source: "project", ...roles.project }
        : roles.global.present
          ? { source: "loop-skill", ...roles.global }
          : null;
  roles.effective = effectiveRoles;
  const human = detectHuman(opts, opts.home, kind, env, envFile);
  const mattPocock = detectMatt(opts.project, opts.home);
  const piSubagents = detectPiSubagents(opts.home);

  const missing = [];
  if (!taskctl.found) missing.push("taskctl");
  if (opts.network && !health.reachable) missing.push("server");
  if (!skills.board.installed) missing.push("board-skill");
  if (!skills.loop.installed) missing.push("loop-skill");
  if (!skills.setup.installed) missing.push("setup-skill");
  if (!loopState.installed) missing.push("loop-state");
  if (!supervisor.installed) missing.push("supervisor");
  if (
    !roles.global.present &&
    !roles.project.present &&
    !roles.explicit.present
  ) {
    missing.push("roles");
  }
  if (kind === "pi" && !piSubagents.installed) missing.push("pi-subagents");

  const warnings = [];
  const hostname = new URL(resolved.url).hostname.toLowerCase();
  if (hostname === "0.0.0.0" || hostname === "[::]" || hostname === "::") {
    warnings.push("the board URL uses an unspecified address (0.0.0.0 / ::); use the machine's LAN address or a hostname");
  }
  if (!human.configured) warnings.push("the fixed human name is not configured; --as-human would fall back to the OS user");
  if (opts.network && loopback && !health.reachable) warnings.push("the board is configured loopback but is not reachable; a local taskd may need to start");
  if (opts.network && !loopback && !health.reachable) warnings.push("the remote board is unreachable; do not fall back to localhost without the operator");
  if (checkout.found && checkout.path === process.cwd() && !opts.checkout) warnings.push("using the current directory as the checkout");
  if (kind === "pi" && !piSubagents.installed) {
    warnings.push(
      `pi has no subagent extension; the loop's project session cannot spawn worker/reviewer subagents — install it with \`${PI_SUBAGENTS_INSTALL}\``,
    );
  }

  const actions = [];
  if (!taskctl.found || !skills.board.installed || !skills.loop.installed) actions.push("install-or-repair");
  if (opts.network && !health.reachable && loopback) actions.push("start-local-server");
  if (opts.network && !health.reachable && !loopback) actions.push("ask-remote-url");
  if (!human.configured) actions.push("configure-human-name");
  if (roles.effective === null) actions.push("install-roles");
  if (kind === "pi" && !piSubagents.installed) actions.push("install-pi-subagents");
  if (mattPocock.skill.installed && !mattPocock.tracker.exists) actions.push("offer-matt-integration");
  if (mattPocock.tracker.exists && mattPocock.tracker.unrelated) actions.push("ask-tracker-overwrite");

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    home: opts.home,
    actorKind: opts.actorKind,
    projectDir: opts.project,
    checkout: {
      ...checkout,
      version: checkout.found ? readJson(join(checkout.path, "package.json"))?.version ?? null : null,
    },
    taskctl,
    server: {
      url: resolved.url,
      urlSource: resolved.source,
      loopback,
      class: loopback ? "loopback" : "remote",
      probed: opts.network,
      reachable: health.reachable,
      health: health.health,
      envFile,
      runtimePointer: pointerPath(opts.home, env),
      error: opts.network ? health.error : null,
    },
    human,
    skills,
    skillsByKind,
    loopState,
    supervisor,
    roles,
    mattPocock,
    piSubagents,
    missing,
    actions,
    warnings,
  };

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(humanReport(report));
  return opts.failOnMissing && missing.length > 0 ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
