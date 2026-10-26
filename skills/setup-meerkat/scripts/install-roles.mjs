#!/usr/bin/env node
/**
 * Install (or validate) a team roles root.
 *
 * The template ships with this skill; the loop never ships one. Files are written
 * atomically, the manifest last (the commit point), and an existing different file
 * is a conflict unless `--force`. No file is ever deleted: removing a role is an
 * explicit operator action, not a side effect of an install.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntryPoint } from "./lib/entry-guard.mjs";
import { writeAtomic } from "./lib/atomic.mjs";
import {
  isAgentKind,
  loopSkillDir,
  NATIVE_KINDS,
  nativeAgentFile,
  nativeAgentFormat,
  piToolsForLanes,
  toolsForLanes,
} from "./lib/agent-kinds.mjs";
import { readTeam, relativeTo, validateRolesRoot } from "./lib/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, "..");

const USAGE = `install-roles — install or validate a Meerkat team roles root

  node install-roles.mjs [--scope global|project] [--home <dir>] [--actor-kind <kind>]
                         [--project <dir>] [--source <dir> | --team <name>]
                         [--role <id>]... [--agent <id>=<name>]...
                         [--reviewer <name>] [--native-agent-defs auto|none|all]
                         [--dry-run] [--force] [--json]
  node install-roles.mjs --validate <roles-root> [--json]

Global requires the loop skill (its roles/ directory). Project writes
<project>/.meerkat/roles and wins over global. Exit: 0 ok, 3 conflict, 2 usage.`;

function parse(argv) {
  const opts = {
    scope: "global",
    home: process.env.HOME ?? "",
    actorKind: "claude",
    project: process.cwd(),
    source: null,
    team: "standard",
    roles: [],
    agents: new Map(),
    reviewer: null,
    nativeDefs: "auto",
    dryRun: false,
    force: false,
    json: false,
    validate: null,
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
      case "--scope": opts.scope = take(); break;
      case "--home": opts.home = take(); break;
      case "--actor-kind": opts.actorKind = take(); break;
      case "--project": opts.project = resolve(take()); break;
      case "--source": opts.source = resolve(take()); break;
      case "--team": opts.team = take(); break;
      case "--role": opts.roles.push(take()); break;
      case "--agent": {
        const pair = take();
        const equals = pair.indexOf("=");
        if (equals <= 0) throw new Error("--agent expects <role-id>=<agent-name>");
        opts.agents.set(pair.slice(0, equals), pair.slice(equals + 1));
        break;
      }
      case "--reviewer": opts.reviewer = take(); break;
      case "--native-agent-defs": opts.nativeDefs = take(); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      case "--json": opts.json = true; break;
      case "--validate": opts.validate = resolve(take()); break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/** @param {object} role @param {string} kind */
function isReviewerRole(role) {
  return Array.isArray(role.lanes) && role.lanes.includes("reviewer");
}

/** @param {string} kind @param {string} ext */
function defaultTemplate(kind, ext) {
  if (kind === "claude") {
    return `---
name: {{NATIVE_AGENT}}
description: "Meerkat TaskPanel role — {{AGENT}} ({{TITLE}}). {{SUMMARY}}"
tools: {{TOOLS}}
model: inherit
---

You are {{AGENT}} on a Meerkat TaskPanel team. Read your role workflow:
{{WORKFLOW}}
{{SELF_CHECK_LINE}}

Do not decide an unauthorized question yourself: write an agent question comment,
keep the card in_progress, and stop. The project session decides or escalates.
`;
  }
  return `name = "{{NATIVE_AGENT}}"
description = "Meerkat TaskPanel role — {{AGENT}} ({{TITLE}})."

developer_instructions = """
You are {{AGENT}} on a Meerkat TaskPanel team. Read your role workflow:
{{WORKFLOW}}
{{SELF_CHECK_LINE}}

Do not decide an unauthorized question yourself: write an agent question comment,
keep the card in_progress, and stop. The project session decides or escalates.
"""
`;
}

/** @param {string} source @param {string} kind */
function loadTemplate(source, kind) {
  const ext = nativeAgentFormat(kind) === "markdown" ? "md" : "toml";
  const path = join(source, "agents", kind, `role.${ext}.tmpl`);
  try {
    return readFileSync(path, "utf8");
  } catch {
    return defaultTemplate(kind, ext);
  }
}

/** @param {string} template @param {object} role @param {string} workflow @param {string} selfCheck */
function renderTemplate(template, role, workflow, selfCheck) {
  const selfLine = selfCheck ? `Self-check: ${selfCheck}` : "";
  return template
    .replaceAll("{{NATIVE_AGENT}}", role.nativeAgent)
    .replaceAll("{{AGENT}}", role.agent)
    .replaceAll("{{TITLE}}", role.title)
    .replaceAll("{{SUMMARY}}", role.summary)
    .replaceAll("{{TOOLS}}", toolsForLanes(role.lanes))
    .replaceAll("{{WORKFLOW}}", workflow)
    .replaceAll("{{SELF_CHECK_LINE}}", selfLine)
    .replaceAll("{{PI_TOOLS}}", piToolsForLanes(role.lanes));
}

/** @param {Buffer} left @param {string} right */
function sameBytes(left, right) {
  return left.equals(Buffer.from(right, "utf8"));
}

/**
 * @param {string} target
 * @param {string} text
 * @param {{dryRun: boolean, force: boolean}} opts
 * @returns {{action: "written"|"unchanged"|"conflict"|"would-write", changed: boolean}}
 */
function placeText(target, text, opts) {
  if (existsSync(target)) {
    let current;
    try {
      current = readFileSync(target);
    } catch {
      current = null;
    }
    if (current !== null && sameBytes(current, text)) return { action: "unchanged", changed: false };
    if (opts.force !== true) return { action: "conflict", changed: false };
    if (!opts.dryRun) writeAtomic(target, text, { mode: statSync(target).mode & 0o777 });
    return { action: opts.dryRun ? "would-write" : "written", changed: true };
  }
  if (!opts.dryRun) writeAtomic(target, text);
  return { action: opts.dryRun ? "would-write" : "written", changed: true };
}

function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`install-roles: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  if (opts.validate) {
    const report = validateRolesRoot(opts.validate);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`install-roles: ${report.ok ? "valid" : "invalid"} — ${report.root}`);
      for (const warning of report.warnings) console.log(`  warning: ${warning}`);
      for (const error of report.errors) console.error(`  error: ${error}`);
      for (const role of report.roles) {
        console.log(`  ${role.id}: ${role.agent} (${role.lanes.join(", ")})`);
      }
    }
    return report.ok ? 0 : 1;
  }

  if (!isAgentKind(opts.actorKind)) {
    console.error(`install-roles: unknown actor kind ${JSON.stringify(opts.actorKind)}`);
    return 2;
  }
  if (opts.scope !== "global" && opts.scope !== "project") {
    console.error("install-roles: --scope must be global or project");
    return 2;
  }
  if (opts.nativeDefs !== "auto" && opts.nativeDefs !== "none" && opts.nativeDefs !== "all") {
    console.error("install-roles: --native-agent-defs must be auto, none or all");
    return 2;
  }

  const source = opts.source ?? join(SKILL_ROOT, "assets", "team", opts.team);
  const team = readTeam(source);
  if (!team.ok) {
    const report = { ok: false, source, errors: team.errors, warnings: team.warnings };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.error(`install-roles: invalid team template at ${source}`);
      for (const error of team.errors) console.error(`  error: ${error}`);
    }
    return 1;
  }

  const selectedIds = new Set(opts.roles.length > 0 ? opts.roles : team.roles.map((role) => role.id));
  for (const id of selectedIds) {
    if (!team.roles.some((role) => role.id === id)) {
      console.error(`install-roles: no role ${JSON.stringify(id)} in the template`);
      return 1;
    }
  }
  for (const id of opts.agents.keys()) {
    if (!team.roles.some((role) => role.id === id)) {
      console.error(`install-roles: --agent names unknown role ${JSON.stringify(id)}`);
      return 1;
    }
  }

  const selected = team.roles
    .filter((role) => selectedIds.has(role.id))
    .map((role) => {
      const next = { ...role };
      if (opts.agents.has(role.id)) next.agent = opts.agents.get(role.id);
      if (opts.reviewer && isReviewerRole(role)) next.agent = opts.reviewer;
      return next;
    });

  const targetRoot = opts.scope === "global"
    ? join(loopSkillDir(opts.home, opts.actorKind), "roles")
    : join(opts.project, ".meerkat", "roles");

  if (opts.scope === "global" && !existsSync(join(loopSkillDir(opts.home, opts.actorKind), "SKILL.md"))) {
    console.error(
      `install-roles: the loop skill is not installed at ${loopSkillDir(opts.home, opts.actorKind)} — install it first, or use --scope project`,
    );
    return 1;
  }

  // A rename must reach the copied prose, not just the manifest's `agent` field:
  // a role file that still says `--agent Jobs` would contradict the handoff.
  const originalAgent = new Map(team.roles.map((role) => [role.id, role.agent]));
  const renames = selected
    .map((role) => [originalAgent.get(role.id), role.agent])
    .filter(([before, after]) => before && after && before !== after);
  const replaceAgentNames = (text) =>
    renames.reduce((out, [before, after]) => out.split(before).join(after), text);

  // The manifest is written last, with only the selected roles and any renames.
  const manifest = JSON.parse(JSON.stringify(team.manifest));
  manifest.roles = (manifest.roles ?? [])
    .filter((role) => selectedIds.has(role.id))
    .map((role) => {
      const copy = { ...role };
      if (opts.agents.has(role.id)) copy.agent = opts.agents.get(role.id);
      if (opts.reviewer && isReviewerRole(selected.find((entry) => entry.id === role.id) ?? {})) {
        copy.agent = opts.reviewer;
      }
      if (typeof copy.title === "string") copy.title = replaceAgentNames(copy.title);
      if (typeof copy.summary === "string") copy.summary = replaceAgentNames(copy.summary);
      if (Array.isArray(copy.responsibilities)) {
        copy.responsibilities = copy.responsibilities.map(replaceAgentNames);
      }
      if (Array.isArray(copy.boundaries)) copy.boundaries = copy.boundaries.map(replaceAgentNames);
      return copy;
    });

  const referenced = new Set(["manifest.json", "decision-policy.md"]);
  for (const role of selected) {
    for (const path of [role.workflows.worker, role.workflows.reviewer, role.selfCheck, role.reviewerPrompt]) {
      const rel = relativeTo(source, path);
      if (rel !== null) referenced.add(rel);
    }
  }
  const files = team.files.filter(
    (rel) => referenced.has(rel) || selectedIds.has(rel.split("/")[0]),
  );

  const report = {
    ok: true,
    scope: opts.scope,
    source,
    rolesRoot: targetRoot,
    team: team.team ?? opts.team,
    roles: selected.map((role) => ({
      id: role.id,
      agent: role.agent,
      nativeAgent: role.nativeAgent,
      lanes: role.lanes,
    })),
    reviewerAgent: selected.find((role) => isReviewerRole(role))?.agent ?? null,
    files: [],
    agentDefs: [],
    warnings: [...team.warnings],
    errors: [],
  };

  let conflict = false;
  for (const rel of files) {
    if (rel === "manifest.json") continue;
    const sourcePath = join(source, rel);
    let text;
    try {
      text = readFileSync(sourcePath, "utf8");
    } catch (err) {
      report.warnings.push(`cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (renames.length > 0) text = replaceAgentNames(text);
    const action = placeText(join(targetRoot, rel), text, opts);
    if (action.action === "conflict") conflict = true;
    report.files.push({ path: join(targetRoot, rel), action: action.action });
  }

  // Native agent definitions for every kind with a native format. Pi has none: its
  // subagent definitions are package-dependent, so it receives the role through the
  // handoff (and can read the Claude-compatible `.claude/agents/` file).
  const defKinds = opts.nativeDefs === "none" ? [] : [...NATIVE_KINDS];
  for (const kind of defKinds) {
    if (nativeAgentFormat(kind) === null) continue;
    for (const role of selected) {
      const workflow = role.workflows.worker ?? role.workflows.reviewer;
      const workflowRel = relativeTo(source, workflow);
      if (workflowRel === null) {
        report.warnings.push(`role ${role.id}: no workflow for a native agent definition`);
        continue;
      }
      const installedWorkflow = join(targetRoot, workflowRel);
      const selfRel = relativeTo(source, role.selfCheck);
      const installedSelf = selfRel === null ? null : join(targetRoot, selfRel);
      const target = nativeAgentFile({
        home: opts.home,
        kind,
        name: role.nativeAgent,
        projectDir: opts.scope === "project" ? opts.project : null,
      });
      if (target === null) continue;
      const text = replaceAgentNames(
        renderTemplate(loadTemplate(source, kind), role, installedWorkflow, installedSelf),
      );
      const action = placeText(target, text, opts);
      if (action.action === "conflict") conflict = true;
      report.agentDefs.push({ path: target, action: action.action, kind });
    }
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestAction = placeText(join(targetRoot, "manifest.json"), manifestText, opts);
  if (manifestAction.action === "conflict") conflict = true;
  report.files.push({ path: join(targetRoot, "manifest.json"), action: manifestAction.action });

  report.ok = !conflict;
  if (conflict) report.errors.push("one or more files differ; re-run with --force to replace them");
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`install-roles: ${conflict ? "conflict" : opts.dryRun ? "dry-run" : "ok"} — ${targetRoot}`);
    for (const entry of [...report.files, ...report.agentDefs]) {
      console.log(`  ${entry.action.padEnd(12)} ${entry.path}`);
    }
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  }
  return conflict ? 3 : 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
