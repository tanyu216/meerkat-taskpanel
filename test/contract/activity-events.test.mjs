/**
 * The activity vocabulary is a two-way contract:
 *
 *   * every event a command appends belongs to `ACTIVITY_EVENTS`;
 *   * every declared event has at least one writer, so the enum never grows a
 *     dead word (the two names that had none are removed by this round).
 *
 * The scan reads `activities.append({ … event: "…" … })` call sites. Logger
 * events (`schema_stale`, `label_gc_failed`, `container_sweep`, …) are not
 * activities and are not in scope.
 *
 * The second half of the coverage question is the writer side: a *declared*
 * event proves the vocabulary is honest, not that every mutating command writes
 * a row. The last block scans each command function for a mutating repository
 * call and requires an `activities.append` in the same function, so a new
 * command cannot change board state without leaving a trail. The four helpers
 * that delegate their audit to the caller (dictionary resolution, label
 * resolution, the report insert) are named exemptions, and the exemption table
 * fails if it rots.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import { ACTIVITY_EVENTS, HISTORICAL_ACTIVITY_EVENTS } from "../../src/core/domain/enums.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", "migrations"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (entry.endsWith(".mjs")) yield path;
  }
}

/** `event name -> file:line` for every `activities.append({… event: "…" …})`. */
function producers() {
  const found = new Map();
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes("activities.append(")) continue;
      const limit = Math.min(lines.length, i + 40);
      for (let j = i; j < limit; j += 1) {
        const at = lines[j].indexOf("event:");
        if (at !== -1) {
          // One `event:` expression can name more than one literal
          // (`cond ? "report_waived" : "task_moved"`); all of them are writers.
          for (const match of lines[j].slice(at + "event:".length).matchAll(/["']([a-z_]+)["']/g)) {
            found.set(match[1], `${relative(ROOT, file)}:${j + 1}`);
          }
          break;
        }
        if (j > i && /^\s*\}\);?\s*$/.test(lines[j])) break;
      }
    }
  }
  return found;
}

describe("contract/activity-events — the catalogue and its writers agree", () => {
  it("declares the events this round adds", () => {
    for (const name of [
      "project_updated",
      "attachment_added",
      "attachment_updated",
      "attachment_removed",
      "import_completed",
      "task_reopened",
    ]) {
      assert.ok(ACTIVITY_EVENTS.includes(name), `${name} is declared`);
    }
  });

  it("drops the two names no writer ever produced", () => {
    assert.equal(ACTIVITY_EVENTS.includes("dictionary_upsert"), false);
    assert.equal(ACTIVITY_EVENTS.includes("anomaly"), false);
  });

  it("has exactly one vocabulary: no undeclared writer, no unwritten word", () => {
    // `progress` and `import_completed` were written by the markdown importer. That
    // importer is gone; the names stay declared so activity rows it already wrote
    // remain readable. The set lives in the domain enum so every consumer gate
    // reads the same one.
    const historical = new Set(HISTORICAL_ACTIVITY_EVENTS);
    const found = producers();
    const declared = new Set(ACTIVITY_EVENTS);
    const undeclared = [...found].filter(([name]) => !declared.has(name)).map(([name, at]) => `${name} at ${at}`);
    const unwritten = ACTIVITY_EVENTS.filter((name) => !found.has(name) && !historical.has(name));
    const resurrected = [...found].filter(([name]) => historical.has(name)).map(([name, at]) => `${name} at ${at}`);
    assert.deepEqual(undeclared, [], `writers outside ACTIVITY_EVENTS:\n${undeclared.join("\n")}`);
    assert.deepEqual(unwritten, [], `declared events with no writer: ${unwritten.join(", ")}`);
    assert.deepEqual(resurrected, [], `historical events must stay writerless:\n${resurrected.join("\n")}`);
  });
});

/* --------------------------------------------- every writer leaves a row */

const COMMANDS = join(SRC, "core", "commands");
const CALL = /\brepos\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const APPENDS = /\.activities\s*\.\s*append\s*\(/;
const DECL = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;

/**
 * Repository methods that write. Kept here rather than introspected: the repo
 * files are the thing being checked, and a gate that asks them what mutates
 * would agree with a method renamed into a read.
 */
const MUTATORS = {
  // The audit writer itself: a block that appends has satisfied the pairing.
  activities: ["append"],
  tasks: [
    "insert", "updateCas", "setReviewRequired", "claimCas", "moveCas", "stealStaleClaim",
    "setHeartbeat", "setReportLatest", "seedAcceptance", "setAcceptance", "archive",
  ],
  comments: ["append"],
  relations: ["insert", "remove"],
  attachments: ["insert", "setSize", "remove"],
  reports: ["insert"],
  labels: ["upsert", "addUse", "removeUse", "archive"],
  dictionary: ["upsert", "remove"],
  projects: ["create", "update", "allocateIdentifier"],
  sessions: ["upsertByNaturalKey", "close", "closeByNaturalKey"],
};

/** Reads, so an unclassified pair is a finding rather than a silent pass. */
const READERS = {
  activities: ["list"],
  comments: ["list", "listDecisions"],
  dictionary: ["getById", "list", "search"],
  labels: ["getByNorm", "list", "listUnusedActive", "referenceCount", "usedColors"],
  projects: ["get", "list"],
  relations: [
    "get", "getParent", "listAncestors", "listBlockEdges", "listBlockedBy",
    "listBlockerOf", "listByTask", "listChildren", "listOpenBlockers",
    "listParentEdges", "openEdgeCounts",
  ],
  reports: ["latestForRound", "listByTask", "listGateReports"],
  sessions: ["list", "listByTask"],
  tasks: [
    "findByIdemActive", "findByIdentifierAnyProject", "get", "list", "listReviewsOf",
    "requireAnyRef", "resolve",
  ],
};

/** Writes whose audit row belongs to the caller's event. */
const EXEMPT = [
  {
    file: "dictionary.mjs",
    fn: "resolveOrCreate",
    why: "dictionary growth rides on the task event that named the person",
  },
  {
    file: "dictionary.mjs",
    fn: "resolveActorId",
    why: "the caller's own row (comment, report, claim) carries the audit",
  },
  {
    file: "labels.mjs",
    fn: "resolveLabels",
    why: "returns its `audit` to the task event; it is not a command",
  },
  {
    file: "delivery-report.mjs",
    fn: "insertDeliveryReport",
    why: "the report_written/task_delivered row is written by the caller",
  },
];

function commands() {
  return readdirSync(COMMANDS)
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => ({ file: name, source: readFileSync(join(COMMANDS, name), "utf8") }));
}

function lineAt(source, index) {
  let line = 0;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/** Top-level `function name(…)` blocks, by line. Nested helpers stay inside. */
function blocks(source) {
  const lines = source.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = DECL.exec(lines[i]);
    if (match) found.push({ name: match[1], start: i, end: lines.length - 1 });
  }
  for (let i = 0; i < found.length - 1; i += 1) found[i].end = found[i + 1].start - 1;
  return { lines, found };
}

/** Every `repos.<repo>.<method>(` call, classified. */
function calls() {
  const out = [];
  for (const { file, source } of commands()) {
    for (const match of source.matchAll(CALL)) {
      out.push({
        file,
        repo: match[1],
        method: match[2],
        line: lineAt(source, match.index),
        source,
      });
    }
  }
  return out;
}

function isMutating({ repo, method }) {
  return (MUTATORS[repo] ?? []).includes(method);
}

function isRead({ repo, method }) {
  return (READERS[repo] ?? []).includes(method);
}

/** Mutating calls whose enclosing function appends no activity of its own. */
function unpaired() {
  const found = [];
  const byFile = new Map();
  for (const call of calls()) {
    if (!isMutating(call)) continue;
    if (!byFile.has(call.file)) {
      const parsed = blocks(call.source);
      byFile.set(call.file, parsed);
    }
    const { lines, found: fns } = byFile.get(call.file);
    const fn = fns.find((block) => call.line >= block.start && call.line <= block.end);
    if (fn === undefined) {
      found.push({ file: call.file, fn: null, line: call.line + 1, method: `${call.repo}.${call.method}` });
      continue;
    }
    const body = lines.slice(fn.start, fn.end + 1).join("\n");
    if (APPENDS.test(body)) continue;
    found.push({ file: call.file, fn: fn.name, line: call.line + 1, method: `${call.repo}.${call.method}` });
  }
  return found;
}

describe("contract/activity-events — every mutating command leaves a row", () => {
  it("classifies every repository call as a read or a write", () => {
    // A new method reaching a command must be named in one of the two tables
    // above. Silence here is how a write would escape the pairing check.
    const unknown = calls()
      .filter((call) => !isMutating(call) && !isRead(call))
      .map((call) => `${call.file}:${call.line + 1} repos.${call.repo}.${call.method}`);
    assert.deepEqual(
      unknown,
      [],
      `unclassified repository calls (add each to MUTATORS or READERS):\n${unknown.join("\n")}`,
    );
  });

  it("pairs every write with an activity in the same function", () => {
    const exempt = new Set(EXEMPT.map((entry) => `${entry.file}::${entry.fn}`));
    const offenders = unpaired()
      .filter((entry) => !exempt.has(`${entry.file}::${entry.fn}`))
      .map((entry) => `${entry.file}:${entry.line} ${entry.fn ?? "(top level)"} → ${entry.method}`);
    assert.deepEqual(
      offenders,
      [],
      "a command can change board state without recording an activity:\n" + offenders.join("\n"),
    );
  });

  it("keeps the exemption table honest", () => {
    const flagged = new Set(unpaired().map((entry) => `${entry.file}::${entry.fn}`));
    const stale = EXEMPT.filter((entry) => !flagged.has(`${entry.file}::${entry.fn}`)).map(
      (entry) => `${entry.file}::${entry.fn}`,
    );
    assert.deepEqual(
      stale,
      [],
      `these exemptions no longer describe a real delegation — remove or re-justify them:\n${stale.join("\n")}`,
    );
    for (const entry of EXEMPT) assert.ok(entry.why.length > 0, `${entry.fn} states why`);
  });
});
