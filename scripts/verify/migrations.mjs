#!/usr/bin/env node
/**
 * The append-only SQL migration gate.
 *
 * `src/core/storage/migrations/*.sql` is an append-only history: the runner
 * records each file's checksum in `schema_migrations`, and a database refuses to
 * open if an applied migration changed. That check only fires at *runtime*, on a
 * database that already applied the old file. This script moves the same verdict
 * forward to the earliest possible point — the pre-commit hook — so a migration
 * that jumps a number, repeats one, silently edits a shipped file, or is deleted
 * is refused before it is ever committed.
 *
 *   node scripts/verify/migrations.mjs                    # check this checkout
 *   node scripts/verify/migrations.mjs --dir <dir>        # check another tree
 *   node scripts/verify/migrations.mjs --no-git           # sequence/name checks only
 *
 * Rules:
 *   1. every file is named `NNNN_lower_snake_name.sql`;
 *   2. version numbers are unique;
 *   3. versions are contiguous from `0001` (no gap, nothing before 0001);
 *   4. a file present in git `HEAD` is byte-identical to it (checksum), and is
 *      not deleted. (Line endings are normalised, exactly as the runner does.)
 *
 * The checksum function is imported from the runner itself, so this gate cannot
 * drift from what the database enforces. Node builtins only; offline.
 *
 * Exit codes: 0 clean; 1 a rule above is violated; 2 bad usage or an unreadable
 * migrations directory.
 */

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { MIGRATION_FILE_PATTERN } from "../../src/core/storage/schema.mjs";
import { checksumFor } from "../../src/core/storage/migrations-runner.mjs";

/** Repository root, resolved from this file (`scripts/verify/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the shipped migrations live, relative to the tree root. */
export const DEFAULT_MIGRATIONS_DIR = "src/core/storage/migrations";

/** `0001` … the zero-padded expected version for a 1-based count. */
function expectedVersion(index) {
  return String(index).padStart(4, "0");
}

/**
 * Read every `.sql` file in a directory.
 *
 * @param {string} dir
 * @returns {Promise<{name: string, path: string, content: string}[]>} sorted by name
 */
export async function listMigrationFiles(dir) {
  const entries = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const files = [];
  for (const name of entries) {
    files.push({ name, path: join(dir, name), content: await readFile(join(dir, name), "utf8") });
  }
  return files;
}

/**
 * The committed (`HEAD`) content of each migration file, keyed by bare filename.
 *
 * Returns `null` when there is no git history to compare against (not a
 * repository, no `HEAD` yet, or the directory is outside the tree) — the caller
 * then runs the sequence/name checks only, rather than failing.
 *
 * @param {{root?: string, dirName?: string}} [options]
 * @returns {Map<string, string>|null}
 */
export function readGitBaseline(options = {}) {
  const { root = ROOT, dirName = DEFAULT_MIGRATIONS_DIR } = options;
  const relDir = relative(root, resolve(root, dirName));
  if (relDir === "" || relDir.startsWith("..") || relDir.startsWith(`..${sep}`)) return null;

  let names;
  try {
    const out = execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD", "--", relDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    names = out.split("\n").filter((line) => line.endsWith(".sql"));
  } catch {
    return null;
  }

  const baseline = new Map();
  for (const relPath of names) {
    try {
      const content = execFileSync("git", ["-C", root, "show", `HEAD:${relPath}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      baseline.set(relPath.split("/").at(-1), content);
    } catch {
      return null;
    }
  }
  return baseline;
}

/**
 * The pure core: given the files on disk and their committed baseline, report
 * every violation. This is the same function the CLI and the tests call.
 *
 * @param {{files: {name: string, content: string}[], baseline?: Map<string, string>|null}} options
 * @returns {{ok: boolean, versions: string[], checksums: Record<string, string>, errors: {code: string, message: string, [k: string]: unknown}[]}}
 */
export function analyzeMigrations(options) {
  const { files, baseline = null } = options;
  /** @type {{code: string, message: string, [k: string]: unknown}[]} */
  const errors = [];
  const versions = [];
  const checksums = {};

  if (files.length === 0) {
    errors.push({ code: "NO_MIGRATIONS", message: "no migration files found" });
    return { ok: false, versions, checksums, errors };
  }

  // 1. names, collecting the well-formed ones for the numbering checks.
  const wellFormed = [];
  for (const file of files) {
    const match = MIGRATION_FILE_PATTERN.exec(file.name);
    if (match === null) {
      errors.push({
        code: "BAD_NAME",
        message: `migration file must be named NNNN_lower_snake_name.sql: ${file.name}`,
        name: file.name,
      });
      continue;
    }
    wellFormed.push({ name: file.name, version: match[1], checksum: checksumFor(file.content) });
  }

  // 2. duplicates. Keep one entry per version for the sequence check so a
  //    duplicate does not also masquerade as a hole.
  const byVersion = new Map();
  for (const entry of wellFormed) {
    if (byVersion.has(entry.version)) {
      errors.push({
        code: "DUPLICATE_VERSION",
        message: `two migration files claim version ${entry.version}: ${byVersion.get(entry.version).name} and ${entry.name}`,
        version: entry.version,
        names: [byVersion.get(entry.version).name, entry.name],
      });
      continue;
    }
    byVersion.set(entry.version, entry);
  }

  // 3. contiguity from 0001: the set must be exactly 0001 … 000N.
  const sorted = [...byVersion.values()].sort((a, b) => (a.version < b.version ? -1 : 1));
  for (const entry of sorted) {
    versions.push(entry.version);
    checksums[entry.version] = entry.checksum;
  }
  if (sorted.length > 0) {
    const last = Number(sorted.at(-1).version);
    const missing = [];
    for (let n = 1; n <= last; n += 1) {
      if (!byVersion.has(expectedVersion(n))) missing.push(expectedVersion(n));
    }
    if (missing.length > 0) {
      errors.push({
        code: "SEQUENCE_GAP",
        message: `migration numbering has a gap — missing ${missing.join(", ")} (versions must be contiguous from 0001)`,
        missing,
      });
    }
  }

  // 4. the baseline: nothing already committed may move or disappear.
  if (baseline !== null) {
    const present = new Set(files.map((file) => file.name));
    for (const file of files) {
      const prior = baseline.get(file.name);
      if (prior === undefined) continue; // a new migration is the normal case
      if (checksumFor(prior) !== checksumFor(file.content)) {
        errors.push({
          code: "CHECKSUM_DRIFT",
          message: `migration ${file.name} changed after it was committed`,
          name: file.name,
        });
      }
    }
    for (const name of baseline.keys()) {
      if (!present.has(name)) {
        errors.push({
          code: "DELETED",
          message: `migration ${name} was deleted — migrations are append-only`,
          name,
        });
      }
    }
  }

  return { ok: errors.length === 0, versions, checksums, errors };
}

/**
 * Read the tree and analyze it end to end.
 *
 * @param {{dir?: string, root?: string, git?: boolean}} [options]
 */
export async function checkMigrations(options = {}) {
  const { root = ROOT, git = true } = options;
  const dir = options.dir === undefined ? resolve(root, DEFAULT_MIGRATIONS_DIR) : resolve(options.dir);
  const files = await listMigrationFiles(dir);
  const baseline = git ? readGitBaseline({ root, dirName: dir }) : null;
  const result = analyzeMigrations({ files, baseline });
  return { ...result, dir, files: files.length, baseline: baseline === null ? 0 : baseline.size };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      base: { type: "string" },
      "no-git": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      "Usage: node scripts/verify/migrations.mjs [--dir <dir>] [--base <root>] [--no-git]\n\n" +
        "  --dir <dir>    migrations directory (default: src/core/storage/migrations)\n" +
        "  --base <root>  the tree root used to resolve the default --dir and git HEAD\n" +
        "  --no-git       skip the committed-baseline (checksum/deletion) checks\n\n" +
        "Exit: 0 clean · 1 numbering/checksum violation · 2 usage or unreadable directory\n",
    );
    return 0;
  }

  const root = values.base === undefined ? ROOT : resolve(values.base);
  const options = { root, git: values["no-git"] !== true };
  if (values.dir !== undefined) options.dir = resolve(values.dir);

  let result;
  try {
    result = await checkMigrations(options);
  } catch (err) {
    const why = err !== null && err.code === "ENOENT" ? "directory not found" : err.message;
    process.stderr.write(`migrations: FAILED — ${why}\n`);
    return 2;
  }

  if (!result.ok) {
    process.stderr.write(`migrations: FAILED — ${result.errors.length} problem(s)\n`);
    for (const error of result.errors) {
      process.stderr.write(`  [${error.code}] ${error.message}\n`);
    }
    process.stderr.write(
      "migrations: migrations are append-only — add the next NNNN_*.sql instead of editing or deleting one.\n",
    );
    return 1;
  }

  const source = result.baseline > 0 ? `git HEAD baseline: ${result.baseline} file(s)` : "no git baseline";
  process.stdout.write(
    `migrations: OK — ${result.files} file(s), versions ${result.versions[0]}…${result.versions.at(-1)} (${source})\n`,
  );
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
