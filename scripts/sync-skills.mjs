#!/usr/bin/env node
/**
 * Sync the single source of truth for each skill (under `skills/`) into the plugin
 * directories that distribute it (`plugins/<target>/skills/<skill>/`).
 *
 * Those copies are GENERATED — never edit them by hand. `--check` verifies they are in
 * sync without writing anything, and is wired into CI (`npm run check:skills`).
 *
 * Since the plugin-distribution change (design/plugin-distribution-plan.md) the
 * repository root *is* the board's plugin root for claude / codex / cursor / pi: each
 * harness's manifest sits next to the one `skills/` tree and points at it, so those
 * four hosts need no generated copy at all. What remains here are the two directories
 * that genuinely need a `skills/` beside them:
 *
 *   * `plugins/openclaw` — OpenClaw is installed as a native plugin whose manifest must
 *     live beside its own `skills/`;
 *   * `plugins/loop` — the marketplace lists skills as plugins, and a plugin whose
 *     source directory carried both skills could not be installed for the loop alone.
 *     A bundle target is not a host: it exists so `meerkat-loop` can be resolved as its
 *     own marketplace entry.
 *
 * OpenClaw receives the board skill only, **never** `meerkat-loop`: it already runs an
 * equivalent supervisor in the openclaw-team framework, and installing both would be two
 * supervisors racing one board (the split is T-20261012-163500-loopdecouple-b).
 *
 * This script is also the entry point for the other half of "the skill is up to date":
 * the loop's execution body and templates are *generated into* `skills/meerkat-loop/` from
 * this repository's own `scripts/`, `src/shared/` and `scripts/install/templates/`, by
 * `scripts/sync-loop.mjs`. `--check` covers both directions, so one command and one CI
 * step guard the whole generated surface.
 *
 * No dependencies; Node builtins only.
 */

import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { syncLoop } from "./sync-loop.mjs";

/**
 * Which host plugin directories receive a generated copy of which skill.
 *
 * Only OpenClaw needs one. The other harnesses read `skills/` at the repository root
 * through their own manifest (`.claude-plugin/`, `.cursor-plugin/`, the root
 * `package.json`'s `pi` field, `.opencode/`) — a copy beside them would be exactly the
 * duplication this table exists to avoid. `meerkat-loop` therefore has no host target
 * left; it is still distributed, via {@link SKILL_BUNDLES} and `install.sh`.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SKILL_HOSTS = Object.freeze({
  "meerkat-taskpanel": Object.freeze(["openclaw"]),
  "meerkat-loop": Object.freeze([]),
});

/**
 * Non-host bundle directories that carry a skill copy — the per-skill marketplace
 * bundles. `plugins/loop` holds the loop skill and nothing else, so
 * `.claude-plugin/marketplace.json` can list `meerkat-loop` as its own plugin.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SKILL_BUNDLES = Object.freeze({
  "meerkat-loop": Object.freeze(["loop"]),
});

/** The board skill — the default for every function that takes a skill name. */
export const DEFAULT_SKILL = "meerkat-taskpanel";

/** Hosts that receive a generated copy of the board skill. Kept for callers that only
 * need "the hosts", e.g. `scripts/build.mjs`'s summary line. */
export const DEFAULT_HOSTS = SKILL_HOSTS[DEFAULT_SKILL];

/** Directory name of the board skill, inside `skills/` and inside a host's `skills/`. */
export const SKILL_DIR_NAME = DEFAULT_SKILL;

/**
 * Absolute path to a skill source of truth.
 * @param {string} root repository root
 * @param {string} [skill] skill directory name
 * @returns {string}
 */
export function resolveSkillSource(root, skill = DEFAULT_SKILL) {
  return join(resolve(root), "skills", skill);
}

/**
 * The distribution table, flattened: one `{skill, kind, target}` row per copy.
 *
 * @returns {Array<{skill: string, kind: "host"|"bundle", target: string}>}
 */
export function skillTargets() {
  const rows = [];
  for (const [skill, hosts] of Object.entries(SKILL_HOSTS)) {
    for (const host of hosts) rows.push({ skill, kind: "host", target: host });
  }
  for (const [skill, bundles] of Object.entries(SKILL_BUNDLES)) {
    for (const bundle of bundles) rows.push({ skill, kind: "bundle", target: bundle });
  }
  return rows;
}

/**
 * Recursive file listing, as paths relative to `dir`, sorted, using `/` separators.
 * Returns an empty array if `dir` does not exist.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir) {
  const out = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(dir, abs).split(sep).join("/"));
      }
    }
  }

  await walk(resolve(dir));
  return out.sort();
}

/**
 * Byte-compare two directories.
 * @param {string} a source directory
 * @param {string} b destination directory
 * @returns {Promise<{equal: boolean, missing: string[], extra: string[], differing: string[]}>}
 *   `missing`  — present in `a`, absent in `b`
 *   `extra`    — present in `b`, absent in `a`
 *   `differing`— present in both, bytes differ
 */
export async function compareDirs(a, b) {
  const [filesA, filesB] = await Promise.all([listFiles(a), listFiles(b)]);
  const setA = new Set(filesA);
  const setB = new Set(filesB);

  const missing = filesA.filter((f) => !setB.has(f));
  const extra = filesB.filter((f) => !setA.has(f));

  const differing = [];
  for (const file of filesA) {
    if (!setB.has(file)) continue;
    const [bufA, bufB] = await Promise.all([
      readFile(join(a, file)),
      readFile(join(b, file)),
    ]);
    if (!bufA.equals(bufB)) differing.push(file);
  }

  return {
    equal: missing.length === 0 && extra.length === 0 && differing.length === 0,
    missing,
    extra,
    differing,
  };
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sync (or verify) every skill into the plugin directories that distribute it.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root (defaults to this file's parent dir)
 * @param {Array<{skill: string, kind: "host"|"bundle", target: string}>} [options.targets]
 *   distribution rows (defaults to {@link skillTargets}); pass a subset to sync one skill
 * @param {boolean} [options.check] when true, compare only — never write
 * @param {string} [options.baseDir] directory containing `plugins/` (defaults to root);
 *   `scripts/build.mjs` uses this to sync into `dist/plugins/`.
 * @returns {Promise<{ok: boolean, check: boolean, results: Array<object>}>}
 */
export async function syncSkills({
  root = defaultRoot(),
  targets = skillTargets(),
  check = false,
  baseDir,
} = {}) {
  const base = resolve(baseDir ?? root);
  const results = [];

  for (const { skill, kind, target } of targets) {
    const source = resolveSkillSource(root, skill);
    const dest = join(base, "plugins", target, "skills", skill);

    if (!(await isDir(source))) {
      results.push({
        skill,
        kind,
        target,
        source,
        dest,
        equal: false,
        missing: [],
        extra: [],
        differing: [],
        error: `skill source not found: ${source}`,
      });
      continue;
    }

    if (check) {
      const diff = await compareDirs(source, dest);
      results.push({ skill, kind, target, source, dest, error: null, ...diff });
      continue;
    }

    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest, { recursive: true });
    const diff = await compareDirs(source, dest);
    results.push({ skill, kind, target, source, dest, error: null, ...diff });
  }

  return { ok: results.every((r) => r.equal), check, results };
}

/** Repository root implied by this file's location (scripts/ → up one level). */
function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Human-readable report for one sync result. */
function formatResult(r) {
  const where = `${r.skill} → plugins/${r.target}/skills/${r.skill}`;
  if (r.error) return `  ERROR    ${where}\n            ${r.error}`;
  if (r.equal) return `  OK       ${where}`;
  const lines = [`  DIFFERS  ${where}`];
  for (const f of r.missing) lines.push(`            missing:   ${f}`);
  for (const f of r.extra) lines.push(`            extra:     ${f}`);
  for (const f of r.differing) lines.push(`            differing: ${f}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { check: false, root: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") opts.check = true;
    else if (arg === "--root") opts.root = argv[++i];
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else {
      process.stderr.write(`sync-skills: unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

const USAGE = `Usage: node scripts/sync-skills.mjs [--check] [--root <dir>]

Two steps, one guard:

  1. generates the loop payload (execution body + installer templates) inside
     skills/meerkat-loop/, from scripts/, src/shared/ and scripts/install/templates/;
  2. copies each skill from skills/<skill>/ into the plugin directories that need a
     generated copy — the board skill to openclaw, and the loop skill into the
     plugins/loop bundle the marketplace lists. claude, codex, cursor and pi read the
     repository's own skills/ tree and get no copy.

Options:
  --check        Only verify both are in sync; do not write.
  --root <dir>   Repository root (default: this repository).
  -h, --help     Show this help.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const root = opts.root ?? defaultRoot();

  const loop = await syncLoop({ root, check: opts.check });
  console.log(`${opts.check ? "Checking" : "Generating"} the loop payload (source: ${loop.skill})`);
  for (const file of loop.files) {
    const label = file.state === "equal" ? "OK" : file.state;
    console.log(`  ${label.padEnd(8)} ${relative(loop.skill, file.dest)}`);
  }
  console.log(
    `  ${(loop.manifest.state === "equal" ? "OK" : loop.manifest.state).padEnd(8)} body/manifest.txt (${loop.body.length} files)`,
  );

  const report = await syncSkills({ root, check: opts.check });
  console.log(`${opts.check ? "Checking" : "Syncing"} skills (source: ${join(root, "skills")})`);
  for (const r of report.results) console.log(formatResult(r));

  if (loop.ok && report.ok) {
    console.log(
      opts.check ? "skill sync: OK" : "skill sync: OK (the loop payload and all copies written)",
    );
    return 0;
  }

  console.error(
    opts.check
      ? "\nskill sync: OUT OF DATE — run `node scripts/sync-skills.mjs` and commit the result."
      : "\nskill sync: FAILED — generated copies do not match the sources.",
  );
  return 1;
}

// Only run when executed directly, so tests can import the functions above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

export { main as run };
