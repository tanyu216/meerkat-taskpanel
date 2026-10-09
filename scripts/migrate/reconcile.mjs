#!/usr/bin/env node
/**
 * M5 shadow-reconciliation harness — the "md → SQLite" dry run.
 *
 *   node scripts/migrate/reconcile.mjs \
 *     --dir <cards-dir> --projects <projects.json> --out <report.json> [--json]
 *
 * It performs the whole shadow drill against a directory of markdown cards and
 * emits a **machine-readable** report. It never executes a real switch: the
 * cards directory is only ever *read*, every write happens inside one throwaway
 * workdir, and the report carries **statistics, hashes and identifiers only** —
 * never a card title or body (the team cards are private; this repo is public).
 *
 * Steps
 *   1. import the cards into temp DB #1 (with project-name resolution);
 *   2. export DB #1 back to markdown, re-import into temp DB #2 (round trip);
 *   3. import the same cards into DB #1 a second time (idempotency);
 *   4. diff the source cards against the round-tripped ones and report.
 *
 * Exit codes: 0 no differences · 3 differences · 2 bad usage · 1 the run failed.
 * Warnings (a card with no `## Report`, a skipped non-epic parent, …) do **not**
 * by themselves make a difference — they are listed in the report instead.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeLabelName } from "../../src/core/domain/labels.mjs";
import { exportMd } from "../../src/core/storage/md/export.mjs";
import { importMd, parseCard, resolveProjectId } from "../../src/core/storage/md/import.mjs";
import { loadProjectRegistry } from "../../src/core/storage/md/project-registry.mjs";
import { closeDatabase, openDatabase } from "../../src/core/storage/driver.mjs";
import { applyMigrations } from "../../src/core/storage/migrations-runner.mjs";
import { createRepositories } from "../../src/core/storage/repositories/index.mjs";
import { DomainError, isDomainError, toErrorPayload } from "../../src/shared/errors.mjs";
import { sha256Hex } from "../../src/shared/ids.mjs";

const REPORT_VERSION = 1;

const USAGE = `Usage: node scripts/migrate/reconcile.mjs --dir <cards> [options]

Options:
  --dir <path>        directory of markdown cards to reconcile (read-only)
  --projects <path>   project registry (projects.json) for name → id resolution
  --out <path>        write the JSON report here
  --workdir <path>    scratch directory (default: a fresh temp dir; removed after)
  --create-project    create a project when a card names one the registry lacks
  --now <iso>         fixed clock for reproducible runs
  --json              print the report as JSON instead of a summary
  -h, --help          this text`;

// ---------------------------------------------------------------------------
// Frontmatter fields of §4.8, and how each is compared.
//
// `home` is where the field is supposed to land — the mapping contract the
// report checks against. `get` reads the canonical value off a parsed card; the
// two sides of the round trip go through the *same* reader, so what is compared
// is the normaliser's output, not the raw bytes on the card.
// ---------------------------------------------------------------------------

const FIELD_SPECS = Object.freeze([
  { field: "id", home: "tasks.identifier", get: (card) => card.identifier },
  { field: "title", home: "tasks.title", get: (card) => card.title },
  { field: "status", home: "tasks.status + meta_json.legacy_status", get: (card) => card.status },
  { field: "priority", home: "tasks.priority", get: (card) => card.priority },
  { field: "kind", home: "tasks.kind", get: (card) => card.kind },
  { field: "labels", home: "labels registry (normalised set)", get: (card) => labelSet(card.labels) },
  { field: "project", home: "projects.id (name → id)", get: (card) => card.projectId },
  { field: "target", home: "projects.workspace_path (project-level)", get: (card) => card.target ?? card.projectWorkspace ?? null },
  { field: "assignee", home: "assignees dictionary", get: (card) => card.assignee },
  { field: "assignee_kind", home: "tasks.assignee_kind (NOT re-exported)", get: (card) => card.assigneeKind },
  { field: "created_by", home: "reporters dictionary + tasks.reporter_id", get: (card) => card.createdBy },
  { field: "created_at", home: "tasks.created_at", get: (card) => card.createdAt },
  { field: "updated_at", home: "tasks.updated_at", get: (card) => card.updatedAt },
  { field: "status_changed_at", home: "tasks.status_changed_at", get: (card) => card.statusChangedAt },
  { field: "blocked_at", home: "tasks.blocked_at", get: (card) => card.blockedAt },
  { field: "claimed_by", home: "tasks.claimed_by", get: (card) => card.claimedBy },
  { field: "claimed_at", home: "tasks.claimed_at", get: (card) => card.claimedAt },
  { field: "heartbeat_at", home: "tasks.heartbeat_at", get: (card) => card.heartbeatAt },
  {
    field: "depends_on",
    home: "task_relations(blocks); source = blocker",
    get: (card) => sortedSet(card.dependsOn ?? []),
  },
  { field: "parent", home: "task_relations(parent); source = parent", get: (card) => card.parent },
  { field: "notify_leader", home: "meta_json.notify_leader", get: (card) => card.notifyLeader },
  { field: "notify_elon", home: "legacy alias → notify_leader", get: (card) => legacy(card, "notify_elon") },
  { field: "review_of", home: "meta_json.legacy", get: (card) => legacy(card, "review_of") ?? card.reviewOf },
  { field: "goal", home: "meta_json.legacy", get: (card) => legacy(card, "goal") },
  { field: "git_rules", home: "meta_json.legacy", get: (card) => legacy(card, "git_rules") },
  { field: "subsession_ids", home: "meta_json.legacy", get: (card) => legacy(card, "subsession_ids") },
  { field: "active_session_id", home: "meta_json.legacy", get: (card) => legacy(card, "active_session_id") },
]);

/** Card sections whose per-card counts must survive the round trip. */
const SECTION_NAMES = Object.freeze(["comments", "sessions", "reports", "progress", "acceptance"]);

/** Fields whose only faithful home is `meta_json.legacy` — never a column. */
const LEGACY_ONLY_FIELDS = Object.freeze([
  "review_of",
  "goal",
  "git_rules",
  "subsession_ids",
  "active_session_id",
  "notify_leader",
]);

/** Tables whose row counts must not move on a second import of the same cards. */
const ROW_TABLES = Object.freeze([
  "tasks",
  "projects",
  "task_relations",
  "comments",
  "agent_sessions",
  "task_reports",
  "labels",
]);

/** @param {object} db */
function rowCounts(db) {
  const counts = {};
  for (const table of ROW_TABLES) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = { json: false, createProject: false };
  const takesValue = new Set(["--dir", "--projects", "--out", "--workdir", "--now"]);
  const flagOnly = new Set(["--json", "--create-project", "--help", "-h"]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new DomainError("VALIDATION_FAILED", { message: `${arg} needs a value`, details: { flag: arg } });
      }
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
      continue;
    }
    if (flagOnly.has(arg)) {
      if (arg === "--json") options.json = true;
      else if (arg === "--create-project") options.createProject = true;
      else options.help = true;
      continue;
    }
    throw new DomainError("VALIDATION_FAILED", { message: `unknown option ${arg}`, details: { flag: arg } });
  }
  return options;
}

// ---------------------------------------------------------------------------
// comparison helpers
// ---------------------------------------------------------------------------

/** @param {object|null|undefined} card @param {string} key */
function legacy(card, key) {
  const value = card?.legacy?.[key];
  return value === undefined ? null : value;
}

/** @param {unknown[]} values @param {(v: unknown) => string} [key] */
function sortedSet(values, key = (value) => String(value)) {
  const set = new Set();
  for (const value of values ?? []) {
    if (value === null || value === undefined || value === "") continue;
    set.add(key(value));
  }
  return [...set].sort();
}

/** @param {string[]} labels */
function labelSet(labels) {
  return sortedSet(labels ?? [], normalizeLabelName);
}

/**
 * Collapse a value to the canonical shape the comparison treats as "the same".
 * `null`, `undefined` and `""` are one value; strings are trimmed; arrays and
 * objects compare by structure, so an array spelled on one line and a block
 * scalar on another are not a difference.
 * @param {unknown} value
 */
export function canonicalValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
    return out;
  }
  return value;
}

/** @param {unknown} a @param {unknown} b */
function sameValue(a, b) {
  return JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
}

/**
 * Read a card's frontmatter through `parseCard` and attach the resolved project
 * id, so a field comparison sees the same `projectId` the importer computed.
 *
 * @param {string} text
 * @param {{file: string, registry: object|null, projectId?: string|null}} context
 */
export function parseForCompare(text, context) {
  const card = parseCard(text, { file: context.file });
  const raw = card.project ?? context.projectId ?? null;
  card.projectId = resolveProjectId(raw, context.registry);
  return card;
}

// ---------------------------------------------------------------------------
// the drill
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   dir: string, registry: object|null, registryPath: string|null, createProject: boolean,
 *   workdir: string, ownedWorkdir: boolean, now: string,
 * }} options
 */
export async function reconcile(options) {
  const { dir, registry, registryPath, createProject, workdir, now } = options;

  const sourceDir = join(workdir, "import-source");
  const exportDir = join(workdir, "exported");
  const dbPath1 = join(workdir, "board-1.sqlite");
  const dbPath2 = join(workdir, "board-2.sqlite");

  // A reused `--workdir` may hold an old board; start from a clean slate.
  rmSync(dbPath1, { force: true });
  rmSync(dbPath2, { force: true });
  rmSync(exportDir, { recursive: true, force: true });
  mkdirSync(sourceDir, { recursive: true });

  // Read the source cards once. The directory is never written to; the copy in
  // the workdir is what the importer reads, so a card that does not parse can be
  // reported as a difference instead of aborting the whole drill.
  const warnings = [];
  const differences = [];
  const sourceCards = [];
  const unparsable = [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();

  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    const hash = sha256Hex(text);
    try {
      const card = parseForCompare(text, { file: name, registry });
      writeFileSync(join(sourceDir, name), text, "utf8");
      sourceCards.push({ file: name, identifier: card.identifier, hash, card, raw: text });
    } catch (err) {
      unparsable.push({ file: name, hash, code: isDomainError(err) ? err.code : "ERROR", message: err.message });
      differences.push(`parse:${name} could not be parsed (${isDomainError(err) ? err.code : "ERROR"})`);
    }
  }

  const db1 = await openDatabase({ path: dbPath1 });
  const db2 = await openDatabase({ path: dbPath2 });
  let stats1;
  let stats2;
  let stats3;
  let exported = new Map();
  try {
    applyMigrations(db1);
    applyMigrations(db2);
    const repos1 = createRepositories(db1);
    const repos2 = createRepositories(db2);

    stats1 = importMd({ db: db1, repos: repos1, dir: sourceDir, now, registry, createProject });
    for (const notice of stats1.notices) warnings.push(`notice: ${notice}`);

    const exportResult = exportMd({ repos: repos1, outDir: exportDir, now });
    for (const file of exportResult.files) exported.set(file.identifier, file.content);

    stats2 = importMd({ db: db2, repos: repos2, dir: exportDir, now, registry, createProject });

    // Idempotency: the same cards, a second time, into the first board. Snapshot
    // the row counts around it — "no new rows" is the property under test.
    const before = rowCounts(db1);
    stats3 = importMd({ db: db1, repos: repos1, dir: sourceDir, now, registry, createProject });
    const after = rowCounts(db1);

    const report = buildReport({
      dir,
      registry,
      registryPath,
      now,
      files,
      sourceCards,
      unparsable,
      exported,
      stats1,
      stats2,
      stats3,
      idempotencyCounts: { before, after },
      db1,
      differences,
      warnings,
    });
    return report;
  } finally {
    closeDatabase(db1);
    closeDatabase(db2);
  }
}

function buildReport(context) {
  const {
    dir,
    registry,
    registryPath,
    now,
    files,
    sourceCards,
    unparsable,
    exported,
    stats1,
    stats2,
    stats3,
    idempotencyCounts,
    db1,
    differences,
    warnings,
  } = context;

  const byIdentifier = new Map(sourceCards.map((entry) => [entry.identifier, entry]));

  // --- per-field parity ---------------------------------------------------
  const perField = FIELD_SPECS.map((spec) => ({
    field: spec.field,
    home: spec.home,
    present: 0,
    unchanged: 0,
    changed: 0,
    changedCards: [],
  }));
  const fieldIndex = new Map(perField.map((row) => [row.field, row]));

  // --- section parity -----------------------------------------------------
  const sections = Object.fromEntries(
    SECTION_NAMES.map((name) => [
      name,
      { cards: 0, matching: 0, mismatching: 0, sourceTotal: 0, roundtripTotal: 0, mismatchedCards: [] },
    ]),
  );

  // --- relations / labels parity -----------------------------------------
  const content = {
    background: { cards: 0, matching: 0, mismatching: 0, mismatchedCards: [] },
  };
  const relations = {
    parent: { edges: 0, matching: 0, mismatching: 0, mismatchedCards: [] },
    dependsOn: { edges: 0, matching: 0, mismatching: 0, mismatchedCards: [] },
  };
  const labels = { cards: 0, matching: 0, mismatching: 0, mismatchedCards: [] };

  const unmappable = [];
  const missingRoundtrip = [];

  for (const entry of sourceCards) {
    const source = entry.card;
    const exportedText = exported.get(entry.identifier);
    if (exportedText === undefined) {
      missingRoundtrip.push(entry.identifier);
      differences.push(`roundtrip:${entry.identifier} was not exported (its project may have been skipped)`);
      continue;
    }
    const roundtrip = parseForCompare(exportedText, {
      file: `${entry.identifier}.md`,
      registry,
    });

    for (const spec of FIELD_SPECS) {
      const row = fieldIndex.get(spec.field);
      const sourceValue = spec.get(source);
      const roundtripValue = spec.get(roundtrip);
      if (canonicalValue(sourceValue) !== null) row.present += 1;
      if (sameValue(sourceValue, roundtripValue)) row.unchanged += 1;
      else {
        row.changed += 1;
        row.changedCards.push(entry.identifier);
      }
    }

    for (const name of SECTION_NAMES) {
      const sourceCount = countSection(source, name);
      const roundtripCount = countSection(roundtrip, name);
      const row = sections[name];
      row.cards += 1;
      row.sourceTotal += sourceCount;
      row.roundtripTotal += roundtripCount;
      if (sourceCount === roundtripCount) row.matching += 1;
      else {
        row.mismatching += 1;
        row.mismatchedCards.push(entry.identifier);
      }
    }

    // `## Background` → `tasks.description`; the body is content, so it is
    // compared by value (never printed), unlike the section *counts* above.
    content.background.cards += 1;
    if (sameValue(source.background, roundtrip.background)) content.background.matching += 1;
    else {
      content.background.mismatching += 1;
      content.background.mismatchedCards.push(entry.identifier);
    }

    const sourceParent = source.parent ?? null;
    const roundtripParent = roundtrip.parent ?? null;
    relations.parent.edges += sourceParent === null ? 0 : 1;
    if (sourceParent === roundtripParent) relations.parent.matching += 1;
    else {
      relations.parent.mismatching += 1;
      relations.parent.mismatchedCards.push(entry.identifier);
    }

    const sourceDeps = sortedSet(source.dependsOn ?? []);
    const roundtripDeps = sortedSet(roundtrip.dependsOn ?? []);
    relations.dependsOn.edges += sourceDeps.length;
    if (JSON.stringify(sourceDeps) === JSON.stringify(roundtripDeps)) relations.dependsOn.matching += 1;
    else {
      relations.dependsOn.mismatching += 1;
      relations.dependsOn.mismatchedCards.push(entry.identifier);
    }

    labels.cards += 1;
    if (JSON.stringify(labelSet(source.labels)) === JSON.stringify(labelSet(roundtrip.labels))) labels.matching += 1;
    else {
      labels.mismatching += 1;
      labels.mismatchedCards.push(entry.identifier);
    }

    if (source.legacyStatus !== null && source.legacyStatus !== undefined) {
      unmappable.push({
        kind: "status-alias",
        card: entry.identifier,
        value: String(source.legacyStatus),
        note: `stored canonically as ${source.status}; the original word is kept in meta_json.legacy_status for a reversible export`,
      });
    }
    if (source.reportMissingWarning === true) {
      unmappable.push({
        kind: "missing-report",
        card: entry.identifier,
        note: `status is ${source.status} but the card has no ## Report`,
      });
    }
  }

  // --- warnings raised by the importer (structured where available) -------
  for (const warning of stats1.warnings) warnings.push(warning);
  for (const skipped of stats1.parentSkipped) {
    unmappable.push({
      kind: "non-epic-parent",
      card: skipped.identifier,
      value: skipped.parent,
      note: `parent is kind=${skipped.parentKind}; only an epic may be a parent — the link was skipped`,
    });
  }
  for (const unresolved of stats1.dependsUnresolved) {
    unmappable.push({
      kind: "unresolved-depends-on",
      card: unresolved.identifier,
      value: unresolved.dependsOn,
      note: "the referenced card is not in this import (or is outside the project)",
    });
  }
  for (const violation of stats1.invariantViolations ?? []) {
    unmappable.push({
      kind: "invariant-violation",
      card: violation.identifier ?? null,
      value: violation.reason,
      note: violation.detail ?? violation.reason,
    });
  }
  for (const skipped of stats1.projectSkippedCards ?? []) {
    unmappable.push({
      kind: "project-unresolved",
      card: skipped.identifier ?? null,
      value: skipped.project,
      note: "the card names a project that is not in the registry — it was skipped (pass --create-project to create it)",
    });
  }
  for (const narrative of stats1.reportNarrative ?? []) {
    // Informational only: the block *is* imported, but degraded to
    // conclusion-only (no structured acceptance list / evidence anchors to map).
    unmappable.push({
      kind: "report-narrative",
      card: narrative.identifier ?? null,
      value: narrative.round,
      note:
        "the card's ## Report block is a historical free-form narrative — imported conclusion-only " +
        "(acceptance/evidence left empty, nothing fabricated); the delivery gate is not weakened",
    });
  }
  for (const incomplete of stats1.reportIncomplete ?? []) {
    // Informational only: a structured-but-incomplete historical report — its
    // acceptance items are kept, its evidence is imported empty (no `evidence:`
    // block to map). Imported degraded, never dropped.
    unmappable.push({
      kind: "report-incomplete",
      card: incomplete.identifier ?? null,
      value: incomplete.round,
      note:
        "the card's ## Report carries acceptance items but no evidence block — imported with its " +
        "acceptance and empty evidence (degraded, nothing fabricated); the delivery gate is not weakened",
    });
  }
  for (const skipped of stats1.reportSkipped ?? []) {
    unmappable.push({
      kind: "report-invalid",
      card: skipped.identifier ?? null,
      value: skipped.round,
      note:
        `the card's ## Report block was not imported (${skipped.code}); it is malformed in a ` +
        "non-incomplete way (an unknown acceptance status, a bad evidence anchor, oversized, or a round mismatch)",
    });
  }

  // Emit a difference for each field/section/relation/label that drifted.
  for (const row of perField) {
    if (row.changed > 0) {
      differences.push(`perField:${row.field} changed on ${row.changed} card(s)`);
      if (LEGACY_ONLY_FIELDS.includes(row.field) || row.field === "target" || row.field === "assignee_kind") {
        unmappable.push({
          kind: "field-drift",
          field: row.field,
          home: row.home,
          count: row.changed,
          cards: [...row.changedCards].sort(),
        });
      }
    }
  }
  for (const [name, row] of Object.entries(sections)) {
    if (row.mismatching > 0) differences.push(`section:${name} count mismatch on ${row.mismatching} card(s)`);
  }
  if (relations.parent.mismatching > 0) differences.push(`relations:parent mismatch on ${relations.parent.mismatching} card(s)`);
  if (relations.dependsOn.mismatching > 0) {
    differences.push(`relations:depends_on mismatch on ${relations.dependsOn.mismatching} card(s)`);
  }
  if (labels.mismatching > 0) differences.push(`labels: mismatch on ${labels.mismatching} card(s)`);
  if (content.background.mismatching > 0) {
    differences.push(`content:background mismatch on ${content.background.mismatching} card(s)`);
  }
  if (unparsable.length > 0) differences.push(`parse: ${unparsable.length} card(s) could not be parsed`);

  // --- project-level diff -------------------------------------------------
  const projects = projectDiffs({ db: db1, sourceCards, registry });

  // --- idempotency --------------------------------------------------------
  // "No new rows": re-importing the same directory may not add or change a row.
  const wroteOnSecondPass =
    Number(stats3.tasks ?? 0) +
    Number(stats3.updated ?? 0) +
    Number(stats3.relations ?? 0) +
    Number(stats3.comments ?? 0) +
    Number(stats3.sessions ?? 0) +
    Number(stats3.reports ?? 0);
  const rowStable = ROW_TABLES.every((table) => idempotencyCounts.before[table] === idempotencyCounts.after[table]);
  const idempotent = wroteOnSecondPass === 0 && rowStable;
  if (!idempotent) differences.push("idempotency: a second import of the same cards changed the board");

  // --- hashes -------------------------------------------------------------
  const hashes = {
    algorithm: "sha256",
    cards: [...sourceCards]
      .map((entry) => ({ identifier: entry.identifier, sha256: entry.hash }))
      .sort((a, b) => (a.identifier < b.identifier ? -1 : 1)),
    unparsable: unparsable.map((entry) => ({ file: entry.file, sha256: entry.hash })),
  };
  hashes.aggregate = sha256Hex(
    hashes.cards.map((entry) => `${entry.identifier} ${entry.sha256}`).join("\n"),
  );

  const sortedDifferences = dedupe(differences);
  const report = {
    ok: sortedDifferences.length === 0,
    version: REPORT_VERSION,
    generatedAt: now,
    source: {
      dir,
      projects: registryPath,
      registryEntries: registry === null ? 0 : registry.size,
      cards: files.length,
    },
    counts: {
      imported: Number(stats1.tasks ?? 0),
      exported: exported.size,
      reimported: Number(stats2.tasks ?? 0),
      skippedProjects: Number(stats1.projectSkipped ?? 0),
    },
    total: sourceCards.length,
    perField,
    sections,
    content,
    relations,
    labels,
    projects,
    unmappable: sortUnmappable(unmappable),
    idempotent,
    roundtripEquivalent: sortedDifferences.length === 0,
    differences: sortedDifferences,
    warnings: dedupe(warnings),
    hashes,
  };
  return report;
}

/** @param {object} db @param {{card: object, identifier: string}[]} sourceCards @param {object|null} registry */
function projectDiffs({ db, sourceCards, registry }) {
  const rows = db.prepare("SELECT id, name, workspace_path, meta_json FROM projects ORDER BY id").all();
  const byProject = new Map();
  for (const entry of sourceCards) {
    const id = entry.card.projectId;
    if (id === null) continue;
    if (!byProject.has(id)) byProject.set(id, { names: new Set(), targets: new Set(), gitRules: 0 });
    const bucket = byProject.get(id);
    if (entry.card.project !== null) bucket.names.add(String(entry.card.project));
    if (entry.card.target !== null && entry.card.target !== undefined) bucket.targets.add(entry.card.target);
    if (legacy(entry.card, "git_rules") !== null || entry.card.legacy?.git_rules !== undefined) bucket.gitRules += 1;
  }

  return rows.map((row) => {
    const bucket = byProject.get(row.id) ?? { names: new Set(), targets: new Set(), gitRules: 0 };
    const meta = safeJson(row.meta_json);
    const entry = registry?.resolveById(row.id) ?? null;
    const registryRoot = entry?.workspacePath ?? null;
    return {
      id: row.id,
      name: row.name,
      workspacePath: row.workspace_path,
      registryRoot,
      names: [...bucket.names].sort(),
      targets: [...bucket.targets].sort(),
      matches: registryRoot === null ? true : registryRoot === row.workspace_path,
      gitRules: {
        cardsWithGitRules: bucket.gitRules,
        registryDefault: typeof meta.default_git_rules === "string" ? "present" : "absent",
      },
      metaKeys: Object.keys(meta).sort(),
    };
  });
}

/** @param {unknown} text */
function safeJson(text) {
  if (typeof text !== "string" || text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {object} card @param {string} name */
function countSection(card, name) {
  switch (name) {
    case "comments":
      return card.comments.length;
    case "sessions":
      return card.sessions.length;
    case "reports":
      return card.reports.length;
    case "progress":
      return card.progress.length;
    case "acceptance":
      return card.acceptance.length;
    default:
      return 0;
  }
}

/** @param {unknown[]} values */
function dedupe(values) {
  return [...new Set(values)].sort();
}

/** @param {object[]} items */
function sortUnmappable(items) {
  return [...items].sort((a, b) => {
    const left = `${a.kind}\u0000${a.card ?? ""}\u0000${a.field ?? ""}`;
    const right = `${b.kind}\u0000${b.card ?? ""}\u0000${b.field ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

/** @param {object} report */
export function summarize(report) {
  const lines = [];
  lines.push(`cards ${report.total} · imported ${report.counts.imported} · re-imported ${report.counts.reimported} · exported ${report.counts.exported}`);
  const drifted = report.perField.filter((row) => row.changed > 0);
  lines.push(drifted.length === 0
    ? `per-field: all ${report.perField.length} fields survived the round trip`
    : `per-field drift: ${drifted.map((row) => `${row.field}(${row.changed})`).join(", ")}`);
  const sectionDrift = Object.entries(report.sections).filter(([, row]) => row.mismatching > 0);
  lines.push(sectionDrift.length === 0
    ? "sections: comments/sessions/reports/progress/acceptance all match"
    : `section drift: ${sectionDrift.map(([name, row]) => `${name}(${row.mismatching})`).join(", ")}`);
  lines.push(`content: background ${report.content.background.mismatching} mismatch`);
  lines.push(`relations: parent ${report.relations.parent.mismatching} mismatch · depends_on ${report.relations.dependsOn.mismatching} mismatch`);
  lines.push(`labels: ${report.labels.mismatching} mismatch`);
  lines.push(`projects: ${report.projects.length} (${report.projects.filter((p) => p.matches).length} matching their registry root)`);
  lines.push(`idempotent: ${report.idempotent} · roundtripEquivalent: ${report.roundtripEquivalent}`);
  lines.push(`warnings: ${report.warnings.length} · unmappable items: ${report.unmappable.length}`);
  lines.push(`aggregate hash: ${report.hashes.aggregate}`);
  if (report.differences.length > 0) {
    lines.push("differences:");
    for (const difference of report.differences) lines.push(`  - ${difference}`);
  }
  return lines.join("\n");
}

/** @param {string[]} argv @param {{stdout?: Function, stderr?: Function}} [io] */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));

  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr(`${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help === true) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  if (options.dir === undefined) {
    stderr(`--dir is required\n${USAGE}\n`);
    return 2;
  }

  let workdir = options.workdir === undefined ? null : resolve(options.workdir);
  const ownedWorkdir = workdir === null;
  let report;
  try {
    const registry = options.projects === undefined ? null : loadProjectRegistry(options.projects);
    if (registry !== null && registry.duplicates.length > 0) {
      stderr(`warning: registry has duplicate project names: ${registry.duplicates.join(", ")}\n`);
    }
    if (workdir === null) workdir = mkdtempSync(join(tmpdir(), "migrate-reconcile-"));
    mkdirSync(workdir, { recursive: true });

    const now = options.now ?? new Date().toISOString();
    report = await reconcile({
      dir: resolve(options.dir),
      registry,
      registryPath: options.projects ?? null,
      createProject: options.createProject === true,
      workdir,
      now,
    });
    if (options.out !== undefined) writeFileSync(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (options.json) stdout(`${JSON.stringify(report, null, 2)}\n`);
    else stdout(`${summarize(report)}\n`);
    return report.differences.length === 0 ? 0 : 3;
  } catch (err) {
    const payload = toErrorPayload(err);
    if (options?.json === true) stdout(`${JSON.stringify({ ok: false, error: payload }, null, 2)}\n`);
    else stderr(`${isDomainError(err) ? payload.code : "ERROR"}: ${payload.message}\n`);
    return 1;
  } finally {
    if (ownedWorkdir && workdir !== null) rmSync(workdir, { recursive: true, force: true });
    else if (workdir !== null) rmSync(join(workdir, "import-source"), { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}

export { USAGE, FIELD_SPECS, SECTION_NAMES };
