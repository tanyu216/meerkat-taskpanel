#!/usr/bin/env node
/**
 * The md migrator's executable runner (F6 ruling).
 *
 *   node src/core/storage/md/migrate-cli.mjs import --dir <cards> [--db <file>] [--project <id>]
 *   node src/core/storage/md/migrate-cli.mjs export --db <file> --out <dir> [--project <id>]
 *   node src/core/storage/md/migrate-cli.mjs check  --dir <cards> [--db <file>]
 *
 * This file contains *no* business logic: it parses argv, opens a database,
 * calls `importMd`/`exportMd` and prints the result (human-readable, or `--json`
 * for a script). M2 adds `taskctl export --md` as a thin alias of this.
 *
 * Exit codes: 0 success · 1 the run failed · 2 bad usage · 3 `check` found
 * differences. Warnings alone do not fail a run.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DomainError, isDomainError, toErrorPayload } from "../../../shared/errors.mjs";
import { openDatabase, closeDatabase } from "../driver.mjs";
import { applyMigrations } from "../migrations-runner.mjs";
import { resolveDbPath } from "../paths.mjs";
import { createRepositories } from "../repositories/index.mjs";
import { exportMd } from "./export.mjs";
import { importMd, parseCard } from "./import.mjs";
import { loadProjectRegistry } from "./project-registry.mjs";
import { readdirSync } from "node:fs";

const USAGE = `Usage: node src/core/storage/md/migrate-cli.mjs <command> [options]

Commands:
  import --dir <cards>   Import markdown cards into the board
  export --out <dir>     Export the board back to markdown cards
  check  --dir <cards>   Parse cards and report differences (writes nothing)

Options:
  --dir <path>       directory of markdown cards
  --out <path>       directory to write cards into
  --db <path>        database file (default: $TASKD_DB or <dataDir>/board.sqlite)
  --project <id>     restrict to (or default to) a project id
  --target <path>    workspace path to use when a card has none
  --projects <path>  project registry (projects.json) — resolve a card's
                     'project' NAME to its id; store root/git rules in meta_json
  --create-project   create a project for a name the registry does not have
                     (without it, an unresolved name is a warning and a skip)
  --resume           accept a card whose content changed since it was imported
  --json             machine-readable output
  -h, --help         this text`;

/**
 * Parse argv into an options object. Unknown flags are a usage error, not a
 * silent no-op.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const options = { command: null, json: false, resume: false };
  const takesValue = new Set(["--dir", "--out", "--db", "--project", "--target", "--projects"]);
  const flagOnly = new Set(["--json", "--resume", "--help", "-h", "--dry-run", "--create-project"]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new DomainError("VALIDATION_FAILED", { message: `${arg} needs a value`, details: { flag: arg } });
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (flagOnly.has(arg)) {
      if (arg === "--json") options.json = true;
      else if (arg === "--resume") options.resume = true;
      else if (arg === "--dry-run") options.dryRun = true;
      else if (arg === "--create-project") options.createProject = true;
      else options.help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new DomainError("VALIDATION_FAILED", { message: `unknown option ${arg}`, details: { flag: arg } });
    }
    if (options.command === null) options.command = arg;
    else {
      throw new DomainError("VALIDATION_FAILED", {
        message: `unexpected argument ${arg}`,
        details: { argument: arg, command: options.command },
      });
    }
  }
  return options;
}

/** Open (and migrate) the database named by the options. */
async function openBoard(options) {
  const path = resolveDbPath({ ...(options.db === undefined ? {} : { dbPath: options.db }) });
  const db = await openDatabase({ path });
  applyMigrations(db);
  return { db, path };
}

/**
 * Run one command.
 *
 * @param {string[]} argv
 * @param {{stdout?: (text: string) => void, stderr?: (text: string) => void}} [io]
 * @returns {Promise<number>} the exit code
 */
/**
 * The real stdio, in one place so `main` can be called with an injected pair and
 * still be the same function.
 */
export function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

export async function main(argv, io = {}) {
  const fallback = defaultIo();
  const stdout = io.stdout ?? fallback.stdout;
  const stderr = io.stderr ?? fallback.stderr;

  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr(`${err.message}\n`);
    return 2;
  }

  if (options.help === true || options.command === null) {
    stdout(`${USAGE}\n`);
    return options.command === null && options.help !== true ? 2 : 0;
  }

  const now = new Date().toISOString();
  let db = null;

  try {
    switch (options.command) {
      case "import": {
        requireOption(options, "dir");
        const registry = options.projects === undefined ? null : loadProjectRegistry(options.projects);
        const board = await openBoard(options);
        db = board.db;
        const repos = createRepositories(db);
        const result = importMd({
          db,
          repos,
          dir: options.dir,
          now,
          resume: options.resume,
          registry,
          createProject: options.createProject === true,
          ...(options.project === undefined ? {} : { projectId: options.project }),
          ...(options.target === undefined ? {} : { target: options.target }),
        });
        if (options.json) stdout(`${JSON.stringify({ ok: true, db: board.path, ...result }, null, 2)}\n`);
        else {
          stdout(
            `imported ${result.tasks} new, ${result.updated} updated, ${result.skipped} unchanged ` +
              `from ${result.files} file(s)\n` +
              `  comments ${result.comments} · sessions ${result.sessions} · reports ${result.reports} · ` +
              `relations ${result.relations} · activities ${result.activities}\n`,
          );
          for (const notice of result.notices) stdout(`  note: ${notice}\n`);
          for (const warning of result.warnings) stdout(`  warning: ${warning}\n`);
        }
        return 0;
      }

      case "export": {
        // Validate before opening anything: a usage error must not create a
        // database, least of all the default one.
        const out = options.out ?? options.dir;
        if (out === undefined) {
          stderr("export needs --out <dir>\n");
          return 2;
        }
        const board = await openBoard(options);
        db = board.db;
        const repos = createRepositories(db);
        const result = exportMd({
          repos,
          outDir: out,
          now,
          ...(options.project === undefined ? {} : { projectId: options.project }),
          dryRun: options.dryRun === true,
        });
        if (options.json) {
          stdout(
            `${JSON.stringify(
              { ok: true, out: result.outDir, count: result.count, files: result.files.map(({ identifier, path, bytes }) => ({ identifier, path, bytes })) },
              null,
              2,
            )}\n`,
          );
        } else {
          stdout(`exported ${result.count} card(s) to ${result.outDir}\n`);
        }
        return 0;
      }

      case "check": {
        requireOption(options, "dir");
        const report = await checkCards(options, { now });
        if (options.json) stdout(`${JSON.stringify(report, null, 2)}\n`);
        else {
          stdout(`checked ${report.files} card(s): ${report.cards.length} parsed\n`);
          for (const difference of report.differences) stdout(`  difference: ${difference}\n`);
          for (const warning of report.warnings) stdout(`  warning: ${warning}\n`);
        }
        return report.differences.length === 0 ? 0 : 3;
      }

      default:
        stderr(`unknown command ${JSON.stringify(options.command)}\n${USAGE}\n`);
        return 2;
    }
  } catch (err) {
    const payload = toErrorPayload(err);
    if (options.json) stdout(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`);
    else stderr(`${isDomainError(err) ? payload.code : "ERROR"}: ${payload.message}\n`);
    return 1;
  } finally {
    closeDatabase(db);
  }
}

function requireOption(options, name) {
  if (options[name] === undefined) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${options.command} needs --${name} <path>`,
      details: { flag: `--${name}` },
    });
  }
}

/**
 * `check`: parse every card, and — when a database is available — compare it
 * against what is stored. Never writes.
 */
async function checkCards(options, { now }) {
  const files = readdirSync(options.dir)
    .filter((name) => name.endsWith(".md"))
    .sort();

  const report = {
    ok: true,
    dir: options.dir,
    db: null,
    files: files.length,
    cards: [],
    warnings: [],
    differences: [],
  };

  const dbPath = resolveDbPath({ ...(options.db === undefined ? {} : { dbPath: options.db }) });
  const hasDb = existsSync(dbPath);
  /** @type {Map<string, {sourceHash: string, identifier: string}>} */
  const stored = new Map();

  let db = null;
  if (hasDb) {
    db = await openDatabase({ path: dbPath });
    applyMigrations(db);
    report.db = dbPath;
    const repos = createRepositories(db);
    for (const task of repos.tasks.list({ includeArchived: true, limit: 10_000 })) {
      if (task.sourcePath !== null) {
        stored.set(task.sourcePath, { sourceHash: task.sourceHash, identifier: task.identifier });
      }
    }
  }

  try {
    for (const name of files) {
      const text = readFileSync(join(options.dir, name), "utf8");
      let card;
      try {
        card = parseCard(text, { file: name });
      } catch (err) {
        report.ok = false;
        report.differences.push(`${name}: ${err.message}`);
        continue;
      }
      const hash = createHash("sha256").update(text).digest("hex");
      const known = stored.get(name);

      report.cards.push({
        file: name,
        identifier: card.identifier,
        status: card.status,
        comments: card.comments.length,
        sessions: card.sessions.length,
        reports: card.reports.length,
        acceptance: card.acceptance.length,
        imported: known !== undefined,
        upToDate: known === undefined ? null : known.sourceHash === hash,
      });

      if (known !== undefined && known.sourceHash !== hash) {
        report.differences.push(`${name}: stored copy is out of date (run import --resume)`);
      }
      if (card.reportMissingWarning) {
        report.warnings.push(`${name}: status is ${card.status} but there is no ## Report`);
      }
    }
  } finally {
    closeDatabase(db);
  }

  return report;
}

// Only run when invoked directly (`node migrate-cli.mjs …`), not when imported.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}

export { USAGE };
