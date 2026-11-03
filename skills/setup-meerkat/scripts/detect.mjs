#!/usr/bin/env node
/**
 * Read-only detection for `/setup-meerkat`.
 *
 * It answers: what is installed, which board is this CLI pointed at, is that
 * board local or remote, which skills/loop state/supervisor exist, which role
 * skills live on which agent kind, what is the fixed human name, and is the Matt
 * Pocock setup skill present. It never writes, never starts a board (`TASKD_NO_AUTOSTART=1`)
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
  LOOP_KINDS,
  PLATFORM_CAPABILITIES,
  ROLE_CAPABILITY_TAGS,
  agentBase,
  effectiveKindOrder,
  isAgentKind,
  kindConfigFile,
  loopStateDir,
  normalizeKindOrder,
  serverRoot,
  shimFile,
  skillDir,
} from "./lib/agent-kinds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "http://localhost:9527";
const STALE_POOL_MS = 5 * 60 * 1000;

const USAGE = `detect — read-only Meerkat TaskPanel discovery

  node detect.mjs [--json] [--home <dir>] [--project <dir>]
                  [--actor-kind <kind|all>] [--checkout <dir>]
                  [--url <url>] [--env-file <path>] [--timeout-ms <n>]
                  [--roles-dir <dir>] [--no-network] [--taskctl <path>]
                  [--fail-on-missing]

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

/**
 * The directory that owns `<program root>/.env.<kind>`.
 *
 * The per-kind config follows the running program, not the agent home, so the
 * detector walks the same rungs: an explicit override, the installed tree, a
 * named checkout, the shim's rendered CLI path, then cwd when it is a checkout.
 * A legacy `<agent-dir>/meerkat-taskpanel.env` is deliberately not a rung.
 */
function resolveKindConfigDir(opts, home, kind, env) {
  const override = env.MEERKAT_TASKPANEL_CONFIG_DIR;
  if (typeof override === "string" && override.trim() !== "") {
    return { dir: resolve(override), source: "env-config-dir" };
  }

  const installed = serverRoot(home);
  if (existsSync(join(installed, "src", "cli", "index.mjs"))) {
    return { dir: installed, source: "installed-tree" };
  }

  const named = [
    ["flag", opts.checkout],
    ["env-root", env.MEERKAT_TASKPANEL_ROOT],
    ["env-repo", env.MEERKAT_TASKPANEL_REPO],
  ];
  for (const [source, dir] of named) {
    if (typeof dir === "string" && looksLikeCheckout(dir)) {
      return { dir: resolve(dir), source };
    }
  }

  // The installed shim renders `exec node "<root>/src/cli/index.mjs"`.
  const shim = readText(shimFile(home, kind));
  const rendered = shim?.match(/exec node "([^"]+)\/src\/cli\/index\.mjs"/);
  if (rendered && existsSync(join(rendered[1], "src", "cli", "index.mjs"))) {
    return { dir: resolve(rendered[1]), source: "shim" };
  }

  if (looksLikeCheckout(process.cwd())) {
    return { dir: resolve(process.cwd()), source: "cwd" };
  }
  return { dir: null, source: null };
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

/** The marker every role skill carries; anything else is not a role. */
const ROLE_SCHEMA = "meerkat-role";

/**
 * The role skills installed for one kind: `skills/<role>/role.json` carrying the
 * schema marker. A malformed or unmarked file is skipped, never fatal.
 */
function roleSkillsIn(dir, kind) {
  const found = [];
  for (const name of readdirSafe(dir)) {
    const roleJson = join(dir, name, "role.json");
    if (!existsSync(roleJson)) continue;
    const raw = readJson(roleJson);
    if (raw === null || raw.schema !== ROLE_SCHEMA) continue;
    found.push({
      id: String(raw.id ?? name).trim(),
      agent: String(raw.agent ?? raw.id ?? name).trim(),
      lanes: Array.isArray(raw.lanes) && raw.lanes.length > 0 ? [...raw.lanes] : ["worker"],
      skill: name,
      skillDir: join(dir, name),
    });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function roleSkillsAt(home, kind) {
  const skillsDir = join(agentBase(home, kind), "skills");
  const found = [];
  for (const name of readdirSafe(skillsDir)) {
    const dir = join(skillsDir, name);
    const roleJson = join(dir, "role.json");
    if (!existsSync(roleJson)) continue;
    const raw = readJson(roleJson);
    if (raw === null || raw.schema !== ROLE_SCHEMA) continue;
    found.push({
      id: String(raw.id ?? name).trim(),
      agent: String(raw.agent ?? raw.id ?? name).trim(),
      lanes: Array.isArray(raw.lanes) && raw.lanes.length > 0 ? [...raw.lanes] : ["worker"],
      skill: name,
      skillDir: dir,
    });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Installation location is the routing: the same role may sit on several kinds.
 * `installedOn` records every carrier in the effective kind order (primary
 * first, then the install-time order); `effective` is its first element. With
 * no availability probe here, `fallback` is null — the runtime fallback is the
 * supervisor's, and `rolePlatforms` below reports the capability proposal.
 */
function discoverRoles(home, primaryKind, kindOrder) {
  const installedOn = {};
  const byId = new Map();
  for (const kind of effectiveKindOrder(primaryKind, kindOrder)) {
    const roles = roleSkillsAt(home, kind);
    installedOn[kind] = roles.map((role) => role.agent);
    for (const role of roles) {
      const seen = byId.get(role.id);
      if (seen !== undefined) {
        seen.installedOn.push(kind);
        continue;
      }
      byId.set(role.id, { ...role, installedOn: [kind] });
    }
  }
  const list = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const role of list) {
    role.effective = role.installedOn[0] ?? null;
    role.fallback = null;
  }
  return {
    source: list.length > 0 ? "skills" : null,
    installedOn,
    list,
    effective: list.length > 0,
  };
}

/** Retired structures are reported, never deleted or read. */
function legacyRoles(home, project, kind, env, explicitDir = null) {
  const found = [];
  const loopSkill = skillDir(home, kind, "meerkat-loop");
  if (existsSync(loopSkill)) found.push({ kind: "skill", path: loopSkill });
  for (const [label, path] of [
    ["loop-skill-roles", join(loopSkill, "roles")],
    ["project-roles", join(project, ".meerkat", "roles")],
  ]) {
    if (existsSync(path)) found.push({ kind: label, path });
  }
  const explicit = env.MEERKAT_TASKPANEL_ROLES_DIR;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    found.push({ kind: "roles-dir-env", path: resolve(explicit.trim()) });
  } else if (typeof explicitDir === "string" && explicitDir !== "") {
    found.push({ kind: "roles-dir-flag", path: explicitDir });
  }
  return found;
}

/** A comma/whitespace list from a config value — `[]` when unset or empty. */
function splitList(value) {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The setup heuristic behind the platform question: assign each role to the platform whose
 * assumed capabilities cover its tags, honoring a per-role preference order, and fall back
 * to the single best-covering platform when nothing matches. **Never forces a split**: the
 * caller shows the proposal, `singlePlatform` is always a valid one-supervisor alternative,
 * and nothing is written here.
 *
 * @param {Array<{id: string, agent: string, lanes?: string[]}>} roles
 * @param {Record<string, {available?: boolean, capabilities?: string[]}>} platforms
 * @param {string|string[]|null|undefined} [kindOrder]
 * @returns {{status: "split"|"single"|"no-platform", byPlatform: Record<string, string[]>,
 *            assignments: Array<{roleId: string, agent: string, platform: string, tags: string[]}>,
 *            singlePlatform: string|null, singlePlatformAgents: string[]}}
 */
export function recommendRolePlatforms(roles, platforms, kindOrder) {
  const list = Array.isArray(roles) ? roles : [];
  const available = LOOP_KINDS.filter((kind) => platforms?.[kind]?.available === true);
  const order = normalizeKindOrder(kindOrder).filter((kind) => available.includes(kind));
  const preference = order.length > 0 ? order : available;
  const capabilities = (kind) => new Set(platforms?.[kind]?.capabilities ?? []);
  const tagsFor = (role) => {
    const known = ROLE_CAPABILITY_TAGS[String(role?.id ?? "").toLowerCase()];
    if (known) return [...known];
    const lanes = Array.isArray(role?.lanes) ? role.lanes : [];
    return lanes.includes("reviewer") ? ["review"] : ["implementation", "tests"];
  };

  if (available.length === 0 || list.length === 0) {
    return { status: "no-platform", byPlatform: {}, assignments: [], singlePlatform: null, singlePlatformAgents: [] };
  }

  const allTags = [...new Set(list.flatMap(tagsFor))];
  const singlePlatform =
    preference.find((kind) => allTags.every((tag) => capabilities(kind).has(tag))) ??
    available.find((kind) => allTags.every((tag) => capabilities(kind).has(tag))) ??
    preference[0];

  const assignments = [];
  for (const role of list) {
    const tags = tagsFor(role);
    const capable = available.filter((kind) => tags.every((tag) => capabilities(kind).has(tag)));
    const platform = preference.find((kind) => capable.includes(kind)) ?? capable[0] ?? singlePlatform;
    assignments.push({ roleId: role.id ?? "", agent: role.agent ?? role.id ?? "", platform, tags });
  }

  const byPlatform = {};
  for (const kind of preference) {
    const agents = assignments.filter((row) => row.platform === kind).map((row) => row.agent);
    if (agents.length > 0) byPlatform[kind] = agents;
  }
  return {
    status: Object.keys(byPlatform).length > 1 ? "split" : "single",
    byPlatform,
    assignments,
    singlePlatform,
    singlePlatformAgents: list.map((role) => role.agent ?? role.id ?? ""),
  };
}

function detectHuman(opts, home, kind, env, envFile, config) {
  const candidates = [];
  if (env.TASKCTL_HUMAN) candidates.push(["env", env.TASKCTL_HUMAN]);
  const settings = readJson(join(home, ".claude", "settings.json"));
  if (settings?.env?.TASKCTL_HUMAN) candidates.push(["settings", settings.env.TASKCTL_HUMAN]);
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

function humanReport(report) {
  const lines = [];
  lines.push(`detect: ${report.actorKind} on ${report.home}`);
  lines.push(`  checkout:  ${report.checkout.found ? report.checkout.path : "not found"} (${report.checkout.source ?? "-"})`);
  lines.push(
    `  config:    ${report.kindConfig.path ?? "not found"}${report.kindConfig.present ? "" : " (absent)"}`,
  );
  lines.push(`  taskctl:   ${report.taskctl.found ? `${report.taskctl.path} ${report.taskctl.version ?? ""}` : "not found"}`);
  lines.push(`  server:    ${report.server.url} (${report.server.urlSource}); ${report.server.class}; ${report.server.probed ? (report.server.reachable ? "reachable" : "unreachable") : "not probed"}`);
  lines.push(`  skills:    board=${report.skills.board.installed} chat=${report.skills.chat.installed} director=${report.skills.director.installed} setup=${report.skills.setup.installed}`);
  lines.push(`  loop state: ${report.loopState.installed ? report.loopState.path : "not installed"}`);
  lines.push(`  supervisor: ${report.supervisor.running ? "running" : "not running"}${report.supervisor.reason ? ` (${report.supervisor.reason})` : ""}`);
  const roleLines = report.roles.list.map(
    (role) =>
      `${role.agent}@${role.installedOn.join(",")}${role.fallback ? `→${role.effective}` : ""}`,
  );
  lines.push(`  roles:     ${roleLines.length > 0 ? roleLines.join("; ") : "none discovered"}`);
  lines.push(`  human:     ${report.human.name}${report.human.configured ? ` (${report.human.source})` : " (fallback; confirm)"}`);
  lines.push(`  matt:      skill=${report.mattPocock.skill.installed} tracker=${report.mattPocock.tracker.exists ? report.mattPocock.tracker.path : "none"}`);
  if (report.platforms) {
    const summary = Object.values(report.platforms)
      .map((platform) => `${platform.kind}=${platform.available ? "ready" : "unavailable"}`)
      .join("; ");
    lines.push(`  platforms: ${summary}`);
    if (report.rolePlatforms?.status === "split") {
      const split = Object.entries(report.rolePlatforms.byPlatform)
        .map(([kind, agents]) => `${kind}=${agents.join(",")}`)
        .join("; ");
      lines.push(`  split:     ${split} (proposed; one platform for all roles is the default)`);
    }
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
  const programRoot = resolveKindConfigDir(opts, opts.home, kind, env);
  const configPath = programRoot.dir === null ? null : kindConfigFile(programRoot.dir, kind);
  const config = parseEnvText(readText(configPath) ?? "");
  const checkout = resolveCheckout(opts, config);
  const envFile = resolveEnvFile(opts, checkout, opts.home, kind, env);
  const resolved = resolveUrl(opts, env, envFile, opts.home);
  const loopback = isLoopback(new URL(resolved.url).hostname);
  const health = opts.network
    ? await probeHealth(resolved.url, Math.max(100, opts.timeoutMs))
    : { reachable: false, health: null, error: "network probe disabled" };
  const taskctl = detectTaskctl(opts, checkout, opts.home, kind, env);
  const skills = {
    board: detectSkill(opts.home, kind, "meerkat"),
    chat: detectSkill(opts.home, kind, "meerkat-chat"),
    director: detectSkill(opts.home, kind, "meerkat-director"),
    setup: detectSkill(opts.home, kind, "setup-meerkat"),
  };
  const skillsByKind = {};
  for (const candidate of Object.keys(AGENT_KINDS)) {
    skillsByKind[candidate] = {
      board: detectSkill(opts.home, candidate, "meerkat").installed,
      chat: detectSkill(opts.home, candidate, "meerkat-chat").installed,
      director: detectSkill(opts.home, candidate, "meerkat-director").installed,
      setup: detectSkill(opts.home, candidate, "setup-meerkat").installed,
    };
  }
  const loopState = detectLoopState(opts.home, kind);
  const supervisor = detectSupervisor(opts.home, kind);
  // The install-time kind order lives in the primary kind's per-kind config.
  // `--actor-kind all` has no single primary, so the first loop kind is used.
  const primaryKind = LOOP_KINDS.includes(kind) ? kind : LOOP_KINDS[0];
  const primaryConfigRoot = resolveKindConfigDir(opts, opts.home, primaryKind, env);
  const primaryConfigPath = primaryConfigRoot.dir === null ? null : kindConfigFile(primaryConfigRoot.dir, primaryKind);
  const primaryConfig = parseEnvText(readText(primaryConfigPath) ?? "");
  const kindOrder = normalizeKindOrder(primaryConfig.get("MEERKAT_TASKPANEL_AGENT_KIND_ORDER"));
  // Role discovery: installation location is the routing, so there is no roles
  // root to resolve. Retired trees are reported for migration, never read.
  // An explicit roles directory (the `--roles-dir` / env form) still selects a
  // custom team in the new shape: a directory of role directories. It replaces
  // the scanned set, exactly as the supervisor's loader does. An old roles tree
  // (a manifest, no role.json) is reported as legacy instead of being read.
  const explicitRolesDir = opts.rolesDir
    ?? (typeof env.MEERKAT_TASKPANEL_ROLES_DIR === "string" && env.MEERKAT_TASKPANEL_ROLES_DIR.trim() !== ""
      ? resolve(env.MEERKAT_TASKPANEL_ROLES_DIR.trim())
      : null);
  const legacy = legacyRoles(opts.home, opts.project, kind, env, opts.rolesDir);
  let roles = discoverRoles(opts.home, primaryKind, kindOrder);
  if (explicitRolesDir !== null && existsSync(explicitRolesDir)) {
    const explicit = roleSkillsIn(explicitRolesDir, primaryKind);
    if (explicit.length > 0) {
      const list = explicit.map((role) => ({
        ...role,
        installedOn: [primaryKind],
        effective: primaryKind,
        fallback: null,
      }));
      roles = { source: "explicit", installedOn: { [primaryKind]: list.map((role) => role.agent) }, list, effective: true };
      // A usable explicit directory is not a retired structure.
      for (let i = legacy.length - 1; i >= 0; i -= 1) {
        if (legacy[i].kind.startsWith("roles-dir")) legacy.splice(i, 1);
      }
    }
  }
  roles.kindOrder = kindOrder;
  const human = detectHuman(opts, opts.home, kind, env, envFile, config);
  const mattPocock = detectMatt(opts.project, opts.home);
  // Per platform: what a role→platform decision needs before it is offered. `available` is
  // the hard gate (the director skill); `capabilities` is the heuristic table the
  // recommendation reads. `config` is this platform's current
  // assignment, so the interview can show the truth and propose only real diffs.
  const platforms = {};
  for (const candidate of LOOP_KINDS) {
    const kindSkills = skillsByKind[candidate];
    const platformBase = agentBase(opts.home, candidate);
    const platformSkillsDir = join(platformBase, "skills");
    const programRoot = resolveKindConfigDir(opts, opts.home, candidate, env);
    const platformConfigPath = programRoot.dir === null ? null : kindConfigFile(programRoot.dir, candidate);
    const platformConfig = parseEnvText(readText(platformConfigPath) ?? "");
    platforms[candidate] = {
      kind: candidate,
      dir: AGENT_KINDS[candidate].dir,
      skills: {
        ...kindSkills,
        names: readdirSafe(platformSkillsDir)
          .filter((name) => existsSync(join(platformSkillsDir, name, "SKILL.md")))
          .sort(),
      },
      loopState: detectLoopState(opts.home, candidate),
      supervisor: detectSupervisor(opts.home, candidate),
      config: {
        path: platformConfigPath,
        present: platformConfigPath !== null && existsSync(platformConfigPath),
        // No scan-set key: the claimable set is the discovered role skills above.
        kindOrder: splitList(platformConfig.get("MEERKAT_TASKPANEL_AGENT_KIND_ORDER")),
      },
      roles: roleSkillsAt(opts.home, candidate).map((role) => role.agent),
      capabilities: [...(PLATFORM_CAPABILITIES[candidate] ?? [])],
      available: kindSkills.director === true,
    };
  }
  const rolePlatforms = recommendRolePlatforms(roles.list, platforms, kindOrder);

  const missing = [];
  if (!taskctl.found) missing.push("taskctl");
  if (opts.network && !health.reachable) missing.push("server");
  if (!skills.board.installed) missing.push("board-skill");
  if (!skills.chat.installed) missing.push("chat-skill");
  if (!skills.director.installed) missing.push("director-skill");
  if (!skills.setup.installed) missing.push("setup-skill");
  if (!loopState.installed) missing.push("loop-state");
  if (!supervisor.installed) missing.push("supervisor");
  if (roles.list.length === 0) missing.push("role-skills");

  const warnings = [];
  const hostname = new URL(resolved.url).hostname.toLowerCase();
  if (hostname === "0.0.0.0" || hostname === "[::]" || hostname === "::") {
    warnings.push("the board URL uses an unspecified address (0.0.0.0 / ::); use the machine's LAN address or a hostname");
  }
  if (!human.configured) warnings.push("the fixed human name is not configured; --as-human would fall back to the OS user");
  if (opts.network && loopback && !health.reachable) warnings.push("the board is configured loopback but is not reachable; a local taskd may need to start");
  if (opts.network && !loopback && !health.reachable) warnings.push("the remote board is unreachable; do not fall back to localhost without the operator");
  if (checkout.found && checkout.path === process.cwd() && !opts.checkout) warnings.push("using the current directory as the checkout");
  for (const retired of legacy) {
    if (retired.kind === "roles-dir-env") {
      warnings.push(
        `MEERKAT_TASKPANEL_ROLES_DIR is set to ${retired.path}; roles are discovered from each kind's skills tree now — this path is no longer read (nothing was deleted)`,
      );
    } else {
      warnings.push(
        `${retired.path} is a retired ${retired.kind === "skill" ? "meerkat-loop skill" : "roles tree"}; role skills under <kind>/skills/<role>/ replace it — reported only, nothing was deleted`,
      );
    }
  }

  const actions = [];
  if (!taskctl.found || !skills.board.installed || !skills.director.installed) actions.push("install-or-repair");
  if (opts.network && !health.reachable && loopback) actions.push("start-local-server");
  if (opts.network && !health.reachable && !loopback) actions.push("ask-remote-url");
  if (!human.configured) actions.push("configure-human-name");
  if (roles.list.length === 0) actions.push("install-role-skills");
  if (legacy.length > 0) actions.push("report-retired-role-trees");
  if (mattPocock.skill.installed && !mattPocock.tracker.exists) actions.push("offer-matt-integration");
  if (mattPocock.tracker.exists && mattPocock.tracker.unrelated) actions.push("ask-tracker-overwrite");

  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    home: opts.home,
    actorKind: opts.actorKind,
    projectDir: opts.project,
    kindConfig: {
      path: configPath,
      present: configPath !== null && existsSync(configPath),
      programRoot: programRoot.dir,
      source: programRoot.source,
    },
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
    platforms,
    rolePlatforms,
    loopState,
    supervisor,
    roles,
    legacy,
    mattPocock,
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
