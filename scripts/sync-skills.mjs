#!/usr/bin/env node
/**
 * Sync the single source of truth for the skill (`skills/meerkat-taskpanel/`) into each
 * host's plugin directory (`plugins/<host>/skills/meerkat-taskpanel/`).
 *
 * Those copies are GENERATED — never edit them by hand. `--check` verifies they are in
 * sync without writing anything, and is wired into CI (`npm run check:skills`).
 *
 * No dependencies; Node builtins only.
 */

import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Hosts that receive a generated copy of the skill. */
export const DEFAULT_HOSTS = ["claude", "codex", "openclaw", "pi"];

/** Directory name of the skill inside `skills/` and inside each host's `skills/`. */
export const SKILL_DIR_NAME = "meerkat-taskpanel";

/**
 * Absolute path to the skill source of truth.
 * @param {string} root repository root
 * @returns {string}
 */
export function resolveSkillSource(root) {
  return join(resolve(root), "skills", SKILL_DIR_NAME);
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

/**
 * Sync (or verify) the skill into each host's plugin directory.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root (defaults to this file's parent dir)
 * @param {string[]} [options.hosts] host directory names (defaults to DEFAULT_HOSTS)
 * @param {boolean} [options.check] when true, compare only — never write
 * @param {string} [options.baseDir] directory containing `plugins/` (defaults to root);
 *   `scripts/build.mjs` uses this to sync into `dist/plugins/`.
 * @returns {Promise<{ok: boolean, check: boolean, source: string, hosts: Array<object>}>}
 */
export async function syncSkills({
  root = defaultRoot(),
  hosts = DEFAULT_HOSTS,
  check = false,
  baseDir,
} = {}) {
  const source = resolveSkillSource(root);
  const base = resolve(baseDir ?? root);

  const results = [];
  for (const host of hosts) {
    const dest = join(base, "plugins", host, "skills", SKILL_DIR_NAME);

    if (check) {
      const diff = await compareDirs(source, dest);
      results.push({ host, source, dest, ...diff });
      continue;
    }

    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest, { recursive: true });
    const diff = await compareDirs(source, dest);
    results.push({ host, source, dest, ...diff });
  }

  return {
    ok: results.every((r) => r.equal),
    check,
    source,
    hosts: results,
  };
}

/** Repository root implied by this file's location (scripts/ → up one level). */
function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Human-readable report for one host result. */
function formatHost(r) {
  if (r.equal) return `  OK      ${r.host} → ${r.dest}`;
  const lines = [`  DIFFERS ${r.host} → ${r.dest}`];
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

Copies skills/meerkat-taskpanel/ into plugins/<host>/skills/meerkat-taskpanel/ for every host.

Options:
  --check        Only verify the generated copies are in sync; do not write.
  --root <dir>   Repository root (default: this repository).
  -h, --help     Show this help.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const report = await syncSkills({ root: opts.root, check: opts.check });

  const header = report.check
    ? `Checking skill sync (source: ${report.source})`
    : `Syncing skill (source: ${report.source})`;
  console.log(header);
  for (const r of report.hosts) console.log(formatHost(r));

  if (report.ok) {
    console.log(report.check ? "skill sync: OK" : "skill sync: OK (all hosts written)");
    return 0;
  }

  console.error(
    report.check
      ? "\nskill sync: OUT OF DATE — run `node scripts/sync-skills.mjs` and commit the result."
      : "\nskill sync: FAILED — generated copies do not match the source.",
  );
  return 1;
}

// Only run when executed directly, so tests can import the functions above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

export { main as run };
