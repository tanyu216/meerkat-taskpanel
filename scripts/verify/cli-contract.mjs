#!/usr/bin/env node
/**
 * The CLI contract, frozen as a machine-checked snapshot.
 *
 * `test/fixtures/contract/api.snapshot.json` freezes the HTTP surface. This is
 * its CLI twin: the surface an **orchestrator** binds to — the loop spawns
 * `taskctl --json`, so a renamed verb, a dropped flag or a retyped argument is a
 * break for it exactly as a route rename is for an HTTP client.
 *
 * What is frozen:
 *
 *   * every group and command name;
 *   * each command's positionals;
 *   * each flag's `flag` / `as` / `value` / `required` / `repeat` / `short`;
 *   * the global flags (the same shape);
 *   * the **keys** of the success and error envelopes, the error payload and
 *     the `--version --json` data — keys, never the version number, so a release
 *     does not move the contract.
 *
 * What is deliberately **not** frozen: `summary`, `usage`, help prose and flag
 * enum values. Those are documentation, not the shape a caller binds to.
 *
 * The snapshot is deterministic (every list sorted by name, keys written in a
 * fixed construction order), so two runs on the same tree are byte-identical and
 * a diff means a surface change.
 *
 *   node scripts/verify/cli-contract.mjs             # compare live vs committed; 0 or 1
 *   node scripts/verify/cli-contract.mjs --update    # rewrite the committed snapshot
 *   node scripts/verify/cli-contract.mjs --print     # the live snapshot, to stdout
 *   node scripts/verify/cli-contract.mjs --file <f>  # another snapshot path
 *
 * Exit: 0 matches · 1 drift · 2 usage or unreadable snapshot.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { registry } from "../../src/cli/commands/index.mjs";
import { versionPayload } from "../../src/cli/index.mjs";
import { errorEnvelope, successEnvelope } from "../../src/cli/output/json.mjs";
import { DomainError } from "../../src/foundation/errors.mjs";
import { isEntryPoint } from "../../src/foundation/entry-guard.mjs";

export const ROOT = resolve(import.meta.dirname, "../..");
/** The snapshot layout generation — bumped only by a breaking layout change. */
export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_FILE = "test/fixtures/contract/cli.snapshot.json";

const byName = (a, b) => a.name.localeCompare(b.name);
const byFlag = (a, b) => a.flag.localeCompare(b.flag);

/**
 * One flag, as a caller sees it.
 *
 * `key` (the handler's camelCase option) is deliberately omitted: it is an
 * internal binding, not part of the surface a script builds against.
 *
 * @param {object} flag
 */
export function flagShape(flag) {
  return {
    flag: flag.flag,
    as: flag.as ?? null,
    value: flag.value ?? null,
    required: flag.required === true,
    repeat: flag.repeat === true,
    short: flag.short ?? null,
  };
}

/** One command: its name, positionals and flags (sorted). */
function commandShape(command) {
  return {
    name: command.name,
    positionals: Array.isArray(command.positionals) ? [...command.positionals] : [],
    flags: (command.flags ?? []).map(flagShape).sort(byFlag),
  };
}

/** The live CLI surface. */
export function buildSnapshot() {
  const errorProbe = errorEnvelope(new DomainError("VALIDATION_FAILED", { message: "probe" }));
  return {
    schema: SNAPSHOT_SCHEMA,
    envelope: {
      error: Object.keys(errorProbe).sort(),
      error_fields: Object.keys(errorProbe.error).sort(),
      success: Object.keys(successEnvelope({})).sort(),
      version_data: Object.keys(versionPayload()).sort(),
    },
    globals: registry.globals.map(flagShape).sort(byFlag),
    groups: registry.groups
      .map((group) => ({
        name: group.name,
        default_command: group.defaultCommand ?? null,
        commands: group.commands.map(commandShape).sort(byName),
      }))
      .sort(byName),
  };
}

/** Stable text for the snapshot file. */
export function serializeSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** @param {string} file absolute path */
export function readSnapshot(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Every difference between two snapshots, as `{kind, detail}`.
 *
 * A generic path walk is enough because both sides are the same deterministic
 * layout: arrays are compared element by element (they are sorted by name), and
 * objects by key.
 *
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [path]
 * @param {Array<{kind: string, detail: string}>} [out]
 */
export function diffSnapshots(actual, expected, path = "", out = []) {
  const at = path === "" ? "(root)" : path;
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    out.push({ kind: "changed", detail: `${at}: list-vs-object` });
    return out;
  }
  if (Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      out.push({ kind: "changed", detail: `${at}: length ${expected.length} → ${actual.length}` });
    }
    const n = Math.max(actual.length, expected.length);
    for (let i = 0; i < n; i += 1) {
      if (i >= actual.length) out.push({ kind: "removed", detail: `${at}[${i}] ${describeValue(expected[i])}` });
      else if (i >= expected.length) out.push({ kind: "added", detail: `${at}[${i}] ${describeValue(actual[i])}` });
      else diffSnapshots(actual[i], expected[i], `${path}[${i}]`, out);
    }
    return out;
  }
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of [...keys].sort()) {
      const child = path === "" ? key : `${path}.${key}`;
      if (!(key in expected)) out.push({ kind: "added", detail: `${child} = ${describeValue(actual[key])}` });
      else if (!(key in actual)) out.push({ kind: "removed", detail: `${child} (was ${describeValue(expected[key])})` });
      else diffSnapshots(actual[key], expected[key], child, out);
    }
    return out;
  }
  if (actual !== expected) {
    out.push({ kind: "changed", detail: `${at}: ${describeValue(expected)} → ${describeValue(actual)}` });
  }
  return out;
}

/** A one-line rendering for a diff row. */
function describeValue(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{…}";
  return String(value);
}

/** A one-line summary of a snapshot, for the success line. */
export function describeSnapshot(snapshot) {
  const commands = snapshot.groups.reduce((n, group) => n + group.commands.length, 0);
  const flags =
    snapshot.globals.length +
    snapshot.groups.reduce(
      (n, group) => n + group.commands.reduce((m, command) => m + command.flags.length, 0),
      0,
    );
  return `${snapshot.groups.length} groups, ${commands} commands, ${flags} flags`;
}

/**
 * Compare the live surface with a snapshot file.
 *
 * @param {{file?: string}} [options]
 * @returns {{ok: boolean, path: string, changes: Array<{kind: string, detail: string}>, snapshot: object}
 *           | {kind: "read", path: string, error: string}}
 */
export function checkContract(options = {}) {
  const path = options.file ?? resolve(ROOT, SNAPSHOT_FILE);
  let committed;
  try {
    committed = readSnapshot(path);
  } catch (err) {
    return { kind: "read", path, error: err.message };
  }
  const snapshot = buildSnapshot();
  const changes = diffSnapshots(snapshot, committed);
  return { ok: changes.length === 0, path, changes, snapshot };
}

/**
 * Rewrite the snapshot file from the live surface.
 *
 * @param {{file?: string}} [options]
 */
export function updateContract(options = {}) {
  const path = options.file ?? resolve(ROOT, SNAPSHOT_FILE);
  const snapshot = buildSnapshot();
  writeFileSync(path, serializeSnapshot(snapshot), "utf8");
  return { path, snapshot };
}

/** Parse `--update`, `--print`, `--file <path>`; unknown flags are a usage error. */
function parseArgs(argv) {
  const values = { update: false, print: false, file: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--update") values.update = true;
    else if (arg === "--print") values.print = true;
    else if (arg === "--file") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) return { error: "--file needs a path" };
      values.file = next;
    } else if (arg === "--help" || arg === "-h") values.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (values.update && values.print) return { error: "--update and --print are mutually exclusive" };
  return values;
}

const USAGE =
  "Usage: node scripts/verify/cli-contract.mjs [--update | --print] [--file <path>]\n\n" +
  "  --update       rewrite the committed snapshot from the live CLI surface\n" +
  "  --print        print the live snapshot to stdout (nothing is written)\n" +
  "  --file <path>  the snapshot path (default: test/fixtures/contract/cli.snapshot.json)\n\n" +
  "Exit: 0 matches · 1 drift (the CLI surface changed; --update if intended) · 2 usage or unreadable snapshot\n";

async function main(argv) {
  const options = parseArgs(argv);
  if (options.error !== undefined) {
    process.stderr.write(`cli-contract: ${options.error}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const target = options.file === undefined ? {} : { file: resolve(process.cwd(), options.file) };

  if (options.print) {
    process.stdout.write(serializeSnapshot(buildSnapshot()));
    return 0;
  }

  if (options.update) {
    const result = updateContract(target);
    process.stdout.write(`cli-contract: UPDATED — ${describeSnapshot(result.snapshot)} → ${result.path}\n`);
    return 0;
  }

  const result = checkContract(target);

  if (result.kind === "read") {
    process.stderr.write(`cli-contract: FAILED — ${result.error}\n`);
    process.stderr.write("cli-contract: write the snapshot with: node scripts/verify/cli-contract.mjs --update\n");
    return 2;
  }

  if (!result.ok) {
    process.stderr.write(`cli-contract: FAILED — ${result.changes.length} change(s) vs ${result.path}\n`);
    for (const change of result.changes) process.stderr.write(`  [${change.kind}] ${change.detail}\n`);
    process.stderr.write(
      "cli-contract: the CLI surface moved. If that is intended, refresh the snapshot and commit it:\n" +
        "  node scripts/verify/cli-contract.mjs --update\n",
    );
    return 1;
  }

  process.stdout.write(`cli-contract: OK — ${describeSnapshot(result.snapshot)} (${result.path})\n`);
  return 0;
}

// Guarded so the module can be imported by the test suite without side effects.
if (isEntryPoint(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
