#!/usr/bin/env node
/**
 * Read-only configuration audit for `/setup-meerkat` round 2.
 *
 * Configuration is layered: process env > `.env.<actor-kind>` > shared `.env` > default.
 * The layer a key lands in is part of its meaning: a loop key in the shared file makes the
 * board loader refuse the file, and a board key in the per-kind file is silently ignored.
 * This script reports those mislayers, silent duplicates, the token pair and a few
 * advisory findings. It never writes, never calls the board, and never prints a secret
 * value (tokens are shown as `<set>`).
 *
 * Node builtins only: the installed skill has no checkout.
 *
 * Usage:
 *   node audit-config.mjs [--home <dir>] [--actor-kind <kind>] [--env-file <path>]
 *     [--config-dir <path>] [--json] [--fail-on-conflict]
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { isEntryPoint } from "./lib/entry-guard.mjs";
import { parseEnvText } from "./lib/env-merge.mjs";
import { agentDir, isAgentKind, serverRoot, kindConfigFile } from "./lib/agent-kinds.mjs";

const DEFAULT_URL = "http://localhost:9527";
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/i;
const LOOP_PREFIX = "MEERKAT_TASKPANEL_";
const PER_KIND_BOARD_KEYS = new Set(["TASKCTL_AGENT", "TASKCTL_HUMAN", "MEERKAT_TASKPANEL_REPO"]);
const SHIM_IDENTITY_KEYS = new Set([
  "TASKCTL_ACTOR_KIND",
  "TASKCTL_SESSION_ID",
  "TASKCTL_AGENT_PLATFORM",
]);

const USAGE = `audit-config — read-only Meerkat TaskPanel configuration audit

  node audit-config.mjs [--home <dir>] [--actor-kind <kind>]
                        [--env-file <path>] [--config-dir <path>]
                        [--json] [--fail-on-conflict]

Exit: 0 audit ran, 1 with --fail-on-conflict and findings, 2 usage.`;

function parse(argv) {
  const opts = {
    home: process.env.HOME ?? homedir(),
    actorKind: "claude",
    envFile: null,
    configDir: null,
    json: false,
    failOnConflict: false,
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
      case "--home": opts.home = resolve(take()); break;
      case "--actor-kind": opts.actorKind = take(); break;
      case "--env-file": opts.envFile = resolve(take()); break;
      case "--config-dir": opts.configDir = resolve(take()); break;
      case "--json": opts.json = true; break;
      case "--fail-on-conflict": opts.failOnConflict = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/** One file's KEY=VALUE lines, duplicates preserved. */
function readLines(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = [];
  String(text)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      const equals = line.indexOf("=");
      if (equals <= 0) {
        lines.push({ key: null, value: null, line: index + 1, malformed: true });
        return;
      }
      const key = line.slice(0, equals).trim().replace(/^export\s+/, "");
      let value = line.slice(equals + 1).trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      lines.push({ key, value, line: index + 1 });
    });
  return lines;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Mask a value when the key looks secret; otherwise keep it for the report. */
function shown(key, value) {
  if (value === undefined || value === null) return null;
  return SECRET_KEY.test(key) ? "<set>" : value;
}

function isLoopbackHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function urlClass(value) {
  try {
    const url = new URL(value);
    return isLoopbackHost(url.hostname) ? "loopback" : "remote";
  } catch {
    return "invalid";
  }
}

function addConflict(list, entry) {
  list.push({
    severity: entry.severity ?? "error",
    ...entry,
  });
}

/** Report duplicate keys in one file (last one wins for the per-kind loader). */
function duplicates(lines, file, layer, severity, why) {
  const byKey = new Map();
  for (const row of lines) {
    if (!row.key) continue;
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key).push(row);
  }
  const out = [];
  for (const [key, rows] of byKey) {
    if (rows.length < 2) continue;
    out.push({
      key,
      file,
      layer,
      line: rows[1].line,
      severity,
      why,
    });
  }
  return out;
}

function audit(opts) {
  const home = opts.home;
  const kind = opts.actorKind;
  const envPath = (name) => {
    const value = process.env[name];
    return value && value.trim() !== "" ? resolve(value) : null;
  };
  const configRoot = opts.configDir ?? envPath("MEERKAT_TASKPANEL_CONFIG_DIR") ?? serverRoot(home);
  const sharedFile = opts.envFile ?? envPath("MEERKAT_TASKPANEL_ENV_FILE") ?? join(configRoot, ".env");
  const perKindFile = isAgentKind(kind) ? kindConfigFile(configRoot, kind) : join(configRoot, `.env.${kind}`);
  const conflicts = [];
  const recommendations = [];
  const layers = [];

  const sharedLines = readLines(sharedFile);
  const perKindLines = readLines(perKindFile);
  layers.push({ name: "process-env", present: true, path: null, keys: [] });
  layers.push({ name: "shared", present: sharedLines !== null, path: sharedFile, keys: [] });
  layers.push({ name: "per-kind", present: perKindLines !== null, path: perKindFile, keys: [] });

  if (sharedLines) {
    for (const row of sharedLines) {
      if (row.malformed) {
        addConflict(conflicts, {
          key: null,
          file: sharedFile,
          layer: "shared",
          line: row.line,
          severity: "error",
          why: "the board loader requires KEY=VALUE on every non-comment line",
        });
        continue;
      }
      layers[1].keys.push(row.key);
      if (row.key.startsWith(LOOP_PREFIX)) {
        addConflict(conflicts, {
          key: row.key,
          file: sharedFile,
          layer: "shared",
          line: row.line,
          severity: "error",
          why: "loop policy belongs in .env.<actor-kind>; the board loader refuses MEERKAT_TASKPANEL_* here",
        });
      }
    }
    for (const entry of duplicates(sharedLines, sharedFile, "shared", "error", "the board loader refuses a repeated key")) {
      addConflict(conflicts, entry);
    }
  }

  if (perKindLines) {
    for (const row of perKindLines) {
      if (row.malformed) {
        addConflict(conflicts, {
          key: null,
          file: perKindFile,
          layer: "per-kind",
          line: row.line,
          severity: "warn",
          why: "this line is not KEY=VALUE and is skipped",
        });
        continue;
      }
      layers[2].keys.push(row.key);
      if (row.key.startsWith("TASKD_")) {
        addConflict(conflicts, {
          key: row.key,
          file: perKindFile,
          layer: "per-kind",
          line: row.line,
          severity: "warn",
          why: "TASKD_* in the per-kind file is ignored by both the board and the loop",
        });
      } else if (row.key.startsWith("TASKCTL_") && !PER_KIND_BOARD_KEYS.has(row.key) && !SHIM_IDENTITY_KEYS.has(row.key)) {
        addConflict(conflicts, {
          key: row.key,
          file: perKindFile,
          layer: "per-kind",
          line: row.line,
          severity: "warn",
          why: "the board takes only TASKCTL_AGENT and TASKCTL_HUMAN from the per-kind file",
        });
      }
      if (SHIM_IDENTITY_KEYS.has(row.key)) {
        addConflict(conflicts, {
          key: row.key,
          file: perKindFile,
          layer: "per-kind",
          line: row.line,
          severity: "warn",
          why: "identity is injected by the shim / harness, not install-wide configuration",
        });
      }
    }
    for (const entry of duplicates(perKindLines, perKindFile, "per-kind", "warn", "the last value wins silently")) {
      addConflict(conflicts, entry);
    }
  }

  // The token pair is read from the shared layer and the process env; the per-kind file
  // contributes nothing to the board's credential.
  const sharedVars = sharedLines ? parseEnvText(readFileSync(sharedFile, "utf8")) : new Map();
  const hasToken = Boolean(process.env.TASKD_TOKEN || sharedVars.get("TASKD_TOKEN"));
  const hasTokenFile = Boolean(process.env.TASKD_TOKEN_FILE || sharedVars.get("TASKD_TOKEN_FILE"));
  if (hasToken && hasTokenFile) {
    addConflict(conflicts, {
      key: "TASKD_TOKEN",
      file: sharedFile,
      layer: "shared",
      line: null,
      severity: "error",
      why: "set exactly one of TASKD_TOKEN and TASKD_TOKEN_FILE",
    });
  }
  const tokenFile = process.env.TASKD_TOKEN_FILE || sharedVars.get("TASKD_TOKEN_FILE");
  if (tokenFile) {
    const path = resolve(tokenFile);
    if (!existsSync(path)) {
      addConflict(conflicts, {
        key: "TASKD_TOKEN_FILE",
        file: sharedFile,
        layer: "shared",
        line: null,
        severity: "error",
        why: "the token file does not exist",
      });
    } else {
      try {
        const mode = statSync(path).mode & 0o777;
        if (mode !== 0o600) {
          recommendations.push({
            key: "TASKD_TOKEN_FILE",
            file: path,
            layer: "shared",
            action: "chmod 600",
            why: `the token file mode is ${mode.toString(8).padStart(4, "0")}, not 0600`,
          });
        }
      } catch {
        // A stat failure is not a configuration conflict.
      }
    }
  }

  // The board address: process env > shared .env > runtime pointer > default. The per-kind
  // file does not contribute it.
  const pointerPath =
    process.env.TASKD_RUNTIME_POINTER ??
    join(configRoot, "runtime.json");
  const pointer = readJson(pointerPath);
  const configuredUrls = [
    ["process env", process.env.TASKD_URL, null],
    ["shared .env", sharedVars.get("TASKD_URL"), sharedFile],
    [
      "runtime pointer",
      pointer && typeof pointer === "object" ? pointer.url ?? pointer.board_url ?? null : null,
      pointerPath,
    ],
  ].filter(([, value]) => typeof value === "string" && value !== "");
  if (configuredUrls.length > 0) {
    const winner = configuredUrls[0];
    const distinct = new Set(configuredUrls.map(([, value]) => value));
    if (distinct.size > 1) {
      recommendations.push({
        key: "TASKD_URL",
        file: winner[2],
        layer: winner[0],
        action: `keep ${winner[0]} (${shown("TASKD_URL", winner[1])})`,
        why: `the address is set in ${configuredUrls.map(([source]) => source).join(", ")}; the first wins`,
      });
    }
  }

  const effectiveUrl = configuredUrls[0]?.[1] ?? DEFAULT_URL;
  const host = sharedVars.get("TASKD_HOST") ?? process.env.TASKD_HOST;
  const allowList = sharedVars.get("TASKD_ALLOW_LIST_ENABLED") ?? process.env.TASKD_ALLOW_LIST_ENABLED;
  if (host && !isLoopbackHost(host) && !/^(1|true|yes)$/i.test(String(allowList ?? ""))) {
    recommendations.push({
      key: "TASKD_HOST",
      file: sharedFile,
      layer: "shared",
      action: "set TASKD_ALLOW_CIDRS or bind loopback",
      why: `${host} is not loopback and the allow-list is off`,
    });
  }

  // Identity: the per-kind file against the host's own settings (Claude only).
  const kindHuman = perKindLines ? parseEnvText(readFileSync(perKindFile, "utf8")).get("TASKCTL_HUMAN") : null;
  if (kind === "claude" && kindHuman) {
    const settings = readJson(join(home, ".claude", "settings.json"));
    const settingsHuman = settings && settings.env ? settings.env.TASKCTL_HUMAN : null;
    if (settingsHuman && settingsHuman !== kindHuman) {
      addConflict(conflicts, {
        key: "TASKCTL_HUMAN",
        file: perKindFile,
        layer: "per-kind",
        line: null,
        severity: "warn",
        why: `the per-kind file says ${shown("TASKCTL_HUMAN", kindHuman)}; the host settings say ${shown("TASKCTL_HUMAN", settingsHuman)}`,
      });
    }
  }

  // Kind order should name kinds that exist on this machine.
  const order = perKindLines ? parseEnvText(readFileSync(perKindFile, "utf8")).get("MEERKAT_TASKPANEL_AGENT_KIND_ORDER") : null;
  if (order) {
    const missing = String(order)
      .split(/[,\s]+/)
      .filter(Boolean)
      .filter((entry) => !isAgentKind(entry) || !existsSync(join(home, agentDir(entry))));
    if (missing.length > 0) {
      recommendations.push({
        key: "MEERKAT_TASKPANEL_AGENT_KIND_ORDER",
        file: perKindFile,
        layer: "per-kind",
        action: `drop ${missing.join(", ")} or install the kind`,
        why: "the order names a kind with no installed agent directory",
      });
    }
  }

  // Deprecated key and the roles-directory override.
  const allKeys = new Set([
    ...(sharedLines ?? []).map((row) => row.key),
    ...(perKindLines ?? []).map((row) => row.key),
  ]);
  if (allKeys.has("MEERKAT_TASKPANEL_REVIEWER")) {
    recommendations.push({
      key: "MEERKAT_TASKPANEL_REVIEWER",
      file: perKindFile,
      layer: "per-kind",
      action: "remove it; the role catalog's default_reviewer owns this",
      why: "the key is deprecated and ignored",
    });
  }
  const rolesDir = perKindLines ? parseEnvText(readFileSync(perKindFile, "utf8")).get("MEERKAT_TASKPANEL_ROLES_DIR") : null;
  if (rolesDir) {
    let valid = false;
    try {
      valid = readdirSync(rolesDir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && existsSync(join(rolesDir, entry.name, "role.json")),
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      recommendations.push({
        key: "MEERKAT_TASKPANEL_ROLES_DIR",
        file: perKindFile,
        layer: "per-kind",
        action: "remove it or point it at directories carrying role.json",
        why: "a roles tree without role.json markers is retired",
      });
    }
  }

  return {
    version: 1,
    home,
    actorKind: kind,
    configRoot,
    effectiveUrl: shown("TASKD_URL", effectiveUrl),
    effectiveUrlClass: urlClass(effectiveUrl),
    layers,
    conflicts,
    recommendations,
  };
}

function render(report) {
  const lines = [];
  lines.push(`config: ${report.configRoot}`);
  lines.push(`url:    ${report.effectiveUrl} (${report.effectiveUrlClass})`);
  for (const conflict of report.conflicts) {
    const where = conflict.file ? `${conflict.file}${conflict.line ? `:${conflict.line}` : ""}` : conflict.layer;
    lines.push(`${conflict.severity}  ${conflict.key ?? "(line)"}  ${where}  ${conflict.why}`);
  }
  for (const item of report.recommendations) {
    lines.push(`info  ${item.key}  ${item.file ?? item.layer}  ${item.action} — ${item.why}`);
  }
  if (report.conflicts.length === 0 && report.recommendations.length === 0) {
    lines.push("config: OK");
  }
  return lines.join("\n");
}

function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    process.stderr.write(`audit-config: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const report = audit(opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${render(report)}\n`);
  return opts.failOnConflict && report.conflicts.length > 0 ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
