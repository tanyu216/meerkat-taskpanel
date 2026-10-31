#!/usr/bin/env node
/**
 * Move one role skill between agent platforms.
 *
 * Installation location is the routing: a role skill under `<home>/<agent-dir>/
 * skills/<role>/` runs on that kind. This script copies the skill to another
 * kind and — only when `--confirm-remove` is given — deletes the source copy.
 * It never deletes a role the caller did not name, and it never edits another
 * checkout.
 *
 * A re-run is idempotent: an identical target is reported `unchanged`, and a
 * differing target is a conflict unless `--force` is given.
 *
 * Usage:
 *   node route-role.mjs --role turing --to codex [--from claude] [--home <dir>]
 *                       [--dry-run] [--confirm-remove] [--force] [--json]
 *
 * Node builtins only; no checkout imports.
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { isEntryPoint } from "./lib/entry-guard.mjs";

const ROLE_SCHEMA = "meerkat-role";
/** The kinds a role can be installed on, in the supervisor's fixed order. */
export const KINDS = Object.freeze([
  { kind: "claude", dir: ".claude" },
  { kind: "codex", dir: ".codex" },
  { kind: "pi", dir: ".agents" },
]);

const USAGE = `Usage: node route-role.mjs --role <id> --to <claude|codex|pi> [options]

  --role <id>         the role skill to move (jobs, linus, turing, reviewer, worker, …)
  --to <kind>         the kind that should carry it
  --from <kind>       the copy to move (default: the first kind carrying it)
  --home <dir>        the agent home (default: $HOME)
  --dry-run           print the plan and change nothing
  --confirm-remove    delete the source copy after a successful copy (ask first!)
  --force             replace a differing target copy
  --json              machine-readable report

Nothing is ever deleted without --confirm-remove, and only the named role's
directory is touched. Exit: 0 ok, 1 conflict/failure, 2 usage.`;

function parse(argv) {
  const opts = {
    role: null,
    to: null,
    from: null,
    home: process.env.HOME ?? homedir(),
    dryRun: false,
    confirmRemove: false,
    force: false,
    json: false,
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
      case "--role": opts.role = take(); break;
      case "--to": opts.to = take(); break;
      case "--from": opts.from = take(); break;
      case "--home": opts.home = resolve(take()); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--confirm-remove": opts.confirmRemove = true; break;
      case "--force": opts.force = true; break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

/** The role's skill directory on one kind, when it carries a marked role.json. */
export function roleAt(home, kindDir, role) {
  const dir = join(home, kindDir, "skills", role);
  const roleJson = join(dir, "role.json");
  if (!existsSync(roleJson)) return null;
  try {
    const raw = JSON.parse(readFileSync(roleJson, "utf8"));
    if (raw?.schema !== ROLE_SCHEMA || String(raw.id ?? "") !== role) return null;
  } catch {
    return null;
  }
  return dir;
}

/** The kinds carrying the role, in the fixed order. */
export function carryingKinds(home, role) {
  return KINDS.filter(({ dir }) => roleAt(home, dir, role) !== null).map(({ kind }) => kind);
}

/** Compare two directories by file set and bytes. */
function sameTree(a, b) {
  const walk = (root, prefix = "") => {
    const out = new Map();
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) for (const [key, value] of walk(root, rel)) out.set(key, value);
      else if (entry.isFile()) out.set(rel, readFileSync(join(root, rel)));
    }
    return out;
  };
  const left = statSync(a).isDirectory() ? walk(a) : new Map();
  const right = statSync(b).isDirectory() ? walk(b) : new Map();
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || !value.equals(right.get(key))) return false;
  }
  return true;
}

/**
 * @returns {{ok: boolean, changed: string[], unchanged: string[], removed: string|null,
 *            source: string|null, target: string, kept: boolean, error: string|null}}
 */
export function routeRole({ home, role, to, from = null, dryRun = false, confirmRemove = false, force = false }) {
  const targetKind = KINDS.find((entry) => entry.kind === to);
  if (targetKind === undefined) return fail(`unknown target kind ${JSON.stringify(to)}`);
  const carrying = carryingKinds(home, role);
  if (carrying.length === 0) return fail(`no kind carries role ${JSON.stringify(role)} under ${home}`);
  const sourceKind = from ?? carrying[0];
  if (!carrying.includes(sourceKind)) return fail(`role ${role} is not installed on ${sourceKind}`);
  if (sourceKind === to) {
    return {
      ok: true,
      changed: [],
      unchanged: [roleAt(home, targetKind.dir, role)],
      removed: null,
      source: null,
      target: roleAt(home, targetKind.dir, role),
      kept: true,
      error: null,
    };
  }
  const sourceDir = roleAt(home, KINDS.find((entry) => entry.kind === sourceKind).dir, role);
  const targetDir = join(home, targetKind.dir, "skills", role);
  const report = {
    ok: true,
    changed: [],
    unchanged: [],
    removed: null,
    source: sourceDir,
    target: targetDir,
    kept: !confirmRemove,
    error: null,
  };

  if (existsSync(targetDir)) {
    if (sameTree(sourceDir, targetDir)) {
      report.unchanged.push(targetDir);
    } else if (!force) {
      return { ...report, ok: false, error: `target differs: ${targetDir} (pass --force to replace it)` };
    } else if (!dryRun) {
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true });
      report.changed.push(targetDir);
    } else {
      report.changed.push(targetDir);
    }
  } else if (!dryRun) {
    cpSync(sourceDir, targetDir, { recursive: true });
    report.changed.push(targetDir);
  } else {
    report.changed.push(targetDir);
  }

  // The source goes only on an explicit confirmation, and only after the copy
  // exists. A dry run never removes even when --confirm-remove was passed.
  if (confirmRemove && !dryRun && existsSync(targetDir)) {
    rmSync(sourceDir, { recursive: true, force: true });
    report.removed = sourceDir;
    report.kept = false;
  }
  return report;
}

function fail(error) {
  return { ok: false, changed: [], unchanged: [], removed: null, source: null, target: "", kept: true, error };
}

function main(argv) {
  let opts;
  try {
    opts = parse(argv);
  } catch (err) {
    console.error(`route-role: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.role === null || opts.to === null) {
    console.error("route-role: --role and --to are required");
    console.error(USAGE);
    return 2;
  }
  const report = routeRole(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    if (report.error !== null) console.error(`route-role: ${report.error}`);
    for (const path of report.changed) console.log(`${opts.dryRun ? "would copy" : "copied"} ${path}`);
    for (const path of report.unchanged) console.log(`unchanged ${path}`);
    if (report.removed !== null) console.log(`removed ${report.removed}`);
    else if (report.ok && report.kept && report.changed.length + report.unchanged.length > 0 && report.source !== null && report.source !== report.target) {
      console.log(`kept ${report.source} (pass --confirm-remove after the copy is verified)`);
    }
  }
  return report.ok ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`route-role: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
