/**
 * md → SQLite.
 *
 * One transaction for the whole directory: either the board reflects the cards
 * or nothing changed. The order matters — tasks first (relations, comments and
 * reports all point at them), then everything that references a task.
 *
 * Idempotency is by `source_path` + `source_hash`:
 *   * same file, same bytes      → skipped
 *   * same file, different bytes → SOURCE_CHANGED (or an update, with `resume`)
 *   * `check: true`              → parse and report, write nothing
 *
 * A card's `## Report` becomes real report rows, so a migrated card arrives
 * with its delivery history intact. Note the deliberate asymmetry: importing
 * does **not** run the delivery gate (it writes history, it does not deliver),
 * and a card that says `in_review` without a report is imported *with a
 * warning* rather than silently blessed.
 *
 * Every report row written here carries `origin='import'`, which is what keeps
 * an imported narrative from satisfying the gate: the gate counts only
 * `origin='delivery'` rows (0008).
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { DomainError, isDomainError } from "../../../shared/errors.mjs";
import { LABEL_PALETTE } from "../../../shared/constants.mjs";
import { contentHash, newId, sha256Hex } from "../../../shared/ids.mjs";
import { ACCEPTANCE_STATUSES } from "../../domain/enums.mjs";
import { normalizeName } from "../../domain/dictionary.mjs";
import { labelDisplayName, nextColor, normalizeLabelName } from "../../domain/labels.mjs";
import { normalizeCommentCreate } from "../../domain/comment.mjs";
import { normalizeImportedReport, normalizeReportCreate } from "../../domain/report.mjs";
import { parsePriority } from "../../domain/priority.mjs";
import { identifierFor, normalizeLabels, normalizeTaskCreate, toIsoMillis } from "../../domain/task.mjs";
import { transaction } from "../unit-of-work.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { checkRelationInvariants } from "./invariants-check.mjs";
import { statusForImport } from "./legacy-status.mjs";
import { resolveBuildinProject } from "./project-registry.mjs";
import {
  parseAcceptanceBlock,
  parseCommentsBlock,
  parseProgressBlock,
  parseReportBlock,
  parseSessionsBlock,
  splitProgressLine,
  splitSections,
} from "./sections.mjs";

/**
 * Frontmatter keys the importer understands; everything else is kept verbatim
 * in `meta_json.legacy` and re-emitted on export.
 *
 * Deliberately absent (M5 ruling): `goal` and `review_of`. Both are named in
 * ARCHITECTURE §4.8 as "原样保留" (kept verbatim) fields, but listing them here
 * made the parser *recognise* them and then map them nowhere — so they were
 * silently dropped, the exact loss the M5 drill exists to catch. Leaving them
 * unknown keeps them under `meta_json.legacy`, which round-trips.
 */
export const KNOWN_CARD_KEYS = Object.freeze([
  "id",
  "title",
  "status",
  "priority",
  "kind",
  "labels",
  "project",
  "target",
  "assignee",
  "assignee_kind",
  "created_by",
  "created_at",
  "updated_at",
  "status_changed_at",
  "claimed_by",
  "claimed_at",
  "heartbeat_at",
  "blocked_at",
  "depends_on",
  "parent",
  "notify_leader",
]);

/**
 * Resolve a card's `project:` value to a MeerkatTaskPanel project id.
 *
 * §4.8 ④: the md value is a **registered name** (a key in `projects.json`), not
 * an id. With a registry, look the name up (or the id, so an exported card —
 * which carries the id — re-imports); without one, the historical behaviour of
 * "the name is the id" is preserved.
 *
 * @param {unknown} rawName the card's `project`, or `--project`
 * @param {object|null|undefined} registry a parsed project registry
 * @returns {string|null}
 */
export function resolveProjectId(rawName, registry) {
  if (rawName === null || rawName === undefined) return null;
  const text = typeof rawName === "string" ? rawName.trim() : "";
  if (text === "") return null;
  if (registry !== null && registry !== undefined) {
    const entry = registry.resolve(text);
    if (entry !== null) return entry.id;
    return text;
  }
  // No registry file: buildin names (`__team__`) still resolve, everything else
  // keeps the historical "the name is the id" behaviour.
  const buildin = resolveBuildinProject(text);
  return buildin === null ? text : buildin.id;
}

/** Keys that are stored in `meta_json` rather than in a column. */
const META_KEYS = Object.freeze(["notify_leader"]);

/**
 * Old frontmatter spellings kept as *read-only* aliases, mapped to their
 * canonical key at parse time. The card field was renamed `notify_elon` →
 * `notify_leader` (the field names a role, not a person), so a card written
 * before the rename must still arrive — and must never be filed under
 * `meta_json.legacy` as if it were an unknown key.
 */
const CARD_KEY_ALIASES = Object.freeze({ notify_elon: "notify_leader" });

const TS_FALLBACK = "1970-01-01T00:00:00.000Z";

/**
 * Cards write `claimed_by: ""` for "nobody" — the database stores NULL. Empty
 * frontmatter values must never become empty strings in a column, or a real
 * invariant (such as "a backlog task is not claimed") trips on them.
 */
function nullable(value) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value.trim() : value;
  return text === "" ? null : text;
}

/**
 * Normalize a card-derived timestamp to the canonical ms-Z form, degrading to
 * the import clock (`fallback`) when the value is missing or unparseable.
 *
 * The domain create-schemas (`normalizeCommentCreate`, the report gate, …)
 * require the canonical 25-character ms-Z string, but real team cards carry
 * hand-written timestamps without milliseconds and with a UTC offset —
 * `2026-10-08T14:03Z`, `2026-10-09T02:42+08:00`. The coercion belongs *here*, at
 * the import edge: the importer normalizes, the domain gate stays strict. A
 * value that cannot be parsed at all is degraded to the fallback (never fatal),
 * and every coercion/drop is recorded in `stats.notices` so the rewrite is
 * visible rather than silent.
 *
 * @param {unknown} value the raw card timestamp
 * @param {string} fallback the import clock (already canonical ms-Z)
 * @param {object} [stats] the import stats, for the informational notice
 * @param {string} [field] the source field, named in the notice
 * @returns {string}
 */
function importTimestamp(value, fallback, stats, field = "timestamp") {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    const canonical = toIsoMillis(value);
    if (canonical !== value && stats !== undefined) {
      stats.notices.push(`coerced ${field} timestamp ${JSON.stringify(value)} to ${canonical}`);
    }
    return canonical;
  } catch {
    if (stats !== undefined) {
      stats.notices.push(`dropped unparseable ${field} timestamp ${JSON.stringify(value)}; using the import clock`);
    }
    return fallback;
  }
}

/**
 * @param {{db: object, repos: object, dir: string, projectId?: string, target?: string, now: string, check?: boolean, resume?: boolean, registry?: object|null, createProject?: boolean, logger?: Function}} input
 */
export function importMd(input) {
  const { db, repos, dir, now, check = false, resume = false } = input;
  const registry = input.registry ?? null;
  const createProject = input.createProject === true;
  const stats = {
    files: 0,
    cards: 0,
    skipped: 0,
    updated: 0,
    tasks: 0,
    relations: 0,
    comments: 0,
    sessions: 0,
    reports: 0,
    activities: 0,
    dictionaries: 0,
    labels: 0,
    projectSkipped: 0,
    warnings: [],
    // Notices are informational (a project was auto-created); warnings are
    // problems. Keeping them apart is what lets "warnings.length === 0" keep
    // meaning "a clean import" for existing callers.
    notices: [],
    // Structured findings the M5 reconcile report reads directly.
    parentSkipped: [],
    parentNotFound: [],
    dependsUnresolved: [],
    invariantViolations: [],
    projectSkippedCards: [],
    reportSkipped: [],
    // Cards whose frontmatter could not be parsed at all. A parse failure is
    // per-card: it is recorded here and the card is skipped, never an abort that
    // sinks the whole batch (B1).
    parseSkipped: [],
    // A historical narrative report is *imported* (degraded to conclusion-only);
    // it is listed for the reconcile report as informational, not a difference.
    reportNarrative: [],
    // A structured-but-incomplete historical report (acceptance items, no
    // evidence block) is likewise *imported* degraded — acceptance kept,
    // evidence empty — and listed informationally, never as a skip.
    reportIncomplete: [],
    check,
  };

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();

  return transaction(
    db,
    () => {
      /** @type {{file: string, rel: string, hash: string, parsed: object}[]} */
      const parsed = [];
      for (const name of files) {
        const path = join(dir, name);
        const text = readFileSync(path, "utf8");
        stats.files += 1;
        // Per-card isolation (B1): a card whose frontmatter will not parse is
        // skipped and recorded, not fatal. One bad card must not sink a whole
        // board's migration. The parsers themselves still throw — that is what
        // `parseCard`'s own callers and `check` rely on.
        let card;
        try {
          card = parseCard(text, { file: basename(path) });
        } catch (err) {
          const code = isDomainError(err) ? err.code : "ERROR";
          stats.parseSkipped.push({ file: name, code, reason: err.message });
          stats.warnings.push(`${name}: the card could not be parsed (${code}) — skipped: ${err.message}`);
          continue;
        }
        parsed.push({
          file: name,
          rel: relative(dir, path) || name,
          hash: sha256Hex(text),
          parsed: card,
        });
      }

      // Pass 1: resolve each card's project name → id, and gather the per-project
      // plan (workspace path + registry metadata). A card whose project cannot be
      // resolved is skipped with a warning — never a silently created project.
      /** @type {Map<string, object>} */
      const projectPlans = new Map();
      for (const entry of parsed) {
        const card = entry.parsed;
        const rawName = card.project ?? input.projectId ?? null;
        if (resolveProjectId(rawName, null) === null) {
          throw new DomainError("MD_PARSE_ERROR", {
            message: `${entry.file}: no 'project' in frontmatter and no --project given`,
            details: { file: entry.file, field: "project" },
          });
        }

        const resolution = resolveProjectPlan(rawName, { registry, createProject });
        if (!resolution.ok) {
          stats.projectSkipped += 1;
          stats.projectSkippedCards.push({ file: entry.file, identifier: card.identifier, project: rawName });
          stats.warnings.push(resolution.warning);
          entry.projectSkipped = true;
          continue;
        }

        card.projectId = resolution.projectId;
        card.projectName = resolution.name;
        card.projectMeta = resolution.meta;
        card.projectWorkspace = resolution.workspacePath;
        if (resolution.notice !== undefined) stats.notices.push(resolution.notice);

        const target = card.target;
        const existingPlan = projectPlans.get(resolution.projectId);
        if (existingPlan === undefined) {
          projectPlans.set(resolution.projectId, {
            id: resolution.projectId,
            name: resolution.name,
            meta: resolution.meta,
            source: resolution.source,
            workspacePath: resolution.workspacePath ?? target ?? input.target ?? null,
            targets: new Set(target === null || target === undefined ? [] : [target]),
          });
          continue;
        }
        if (target !== null && target !== undefined && !existingPlan.targets.has(target)) {
          // `target` is a project-level workspace path (§4.8 ④ / M5 ruling): two
          // different values for one project is a warning, not a hard failure.
          // A **buildin** project (`__team__`) has no repo, so a card's `target`
          // is a per-card artifact path, not a project-level path — every such
          // card would otherwise raise a spurious warning, so the check is
          // skipped by design (the value is still recorded for the drill).
          existingPlan.targets.add(target);
          if (existingPlan.source !== "buildin") {
            stats.warnings.push(
              `${entry.file}: project ${resolution.projectId} is used with two different targets ` +
                `(${[...existingPlan.targets].join(" and ")}); target is project-level — using ${existingPlan.workspacePath}`,
            );
          }
        }
      }

      // Pass 1.5: plan each card's report rows — the strict delivery gate first,
      // then the relaxed historical path. Planning happens *before* the task is
      // written so a degraded report's warning tag is part of the task's meta
      // from the start; a post-hoc meta update would move `updated_at`.
      for (const entry of parsed) {
        if (entry.projectSkipped === true) continue;
        entry.reportPlans = entry.parsed.reports.map((report) =>
          planReportImport(report, importTimestamp(report.ts, now, stats, "report")),
        );
        mergeReportWarnings(entry.parsed, entry.reportPlans);
      }

      // Pass 2: tasks.
      for (const entry of parsed) {
        const card = entry.parsed;
        if (entry.projectSkipped === true) continue;
        const existing = findExisting(repos, card.projectId, entry.rel);

        if (existing !== null && existing.sourceHash === entry.hash) {
          stats.skipped += 1;
          stats.cards += 1;
          entry.taskId = existing.id;
          entry.existing = existing;
          entry.skipped = true;
          continue;
        }
        if (existing !== null && !resume) {
          throw new DomainError("SOURCE_CHANGED", {
            message: `${entry.file}: changed since it was imported — pass --resume to accept the new content`,
            details: { file: entry.file, sourcePath: entry.rel, imported: existing.sourceHash, current: entry.hash },
          });
        }

        if (check) {
          stats.cards += 1;
          entry.taskId = existing?.id ?? `<new:${card.identifier}>`;
          entry.planned = true;
          continue;
        }

        ensureProject(repos, projectPlans.get(card.projectId), card, now, stats);
        const dictionary = resolveCardDictionaries(repos, card, now);
        stats.dictionaries += dictionary.writes;
        // Historical cards register their labels too, so the registry reflects an
        // imported board rather than only boards built through the CLI (§3.7).
        const labels = resolveCardLabels(repos, card, existing, now);
        stats.labels += labels.writes;

        const task = buildTask(repos, card, {
          now,
          rel: entry.rel,
          hash: entry.hash,
          dictionary,
          labels: labels.names,
          existing,
        });
        if (existing === null) {
          const inserted = repos.tasks.insert(task);
          entry.taskId = inserted.id;
          stats.tasks += 1;
        } else {
          const updated = repos.tasks.updateCas({
            id: existing.id,
            patch: patchFrom(task),
            now,
          });
          entry.taskId = existing.id;
          stats.updated += 1;
          entry.task = updated;
        }
        const stored = entry.task ?? repos.tasks.get(entry.taskId);
        entry.task = stored;
        entry.card = card;
        if (card.reportMissingWarning) {
          stats.warnings.push(`${entry.file}: status is ${card.status} but the card has no ## Report`);
        }
      }

      if (check) {
        stats.cards = parsed.length;
        return stats;
      }

      // Pass 3: relations (every task exists by now).
      //
      // `depends_on: [X]` means X must finish before this card, so the edge is
      // `blocks` with **source = X (the blocker), target = this task** — the M5
      // ruling, matching `domain/relation.mjs`'s direction convention and the
      // export, which rebuilds `depends_on` from `listBlockerOf(task)`.
      // Relations are looked up within the card's own project (never across).
      const byKey = new Map();
      for (const entry of parsed) {
        if (entry.task !== undefined) byKey.set(`${entry.task.projectId}\u0000${entry.task.identifier}`, entry.task);
      }
      const lookup = (projectId, identifier) =>
        byKey.get(`${projectId}\u0000${identifier}`) ?? repos.tasks.getByIdentifier(projectId, identifier);

      for (const entry of parsed) {
        if (entry.task === undefined || entry.skipped === true) continue;
        for (const dependency of entry.card.dependsOn) {
          const blocker = lookup(entry.card.projectId, dependency);
          if (blocker === null || blocker === undefined) {
            stats.dependsUnresolved.push({ file: entry.file, identifier: entry.task.identifier, dependsOn: dependency });
            stats.warnings.push(`${entry.file}: depends_on ${dependency} is not in this import`);
            continue;
          }
          if (blocker.id === entry.task.id) {
            stats.dependsUnresolved.push({ file: entry.file, identifier: entry.task.identifier, dependsOn: dependency });
            continue;
          }
          insertRelation(repos, { type: "blocks", source: blocker.id, target: entry.task.id, now, origin: "md" }, entry, stats, "depends_on");
        }
        if (entry.card.parent !== null) {
          const parent = lookup(entry.card.projectId, entry.card.parent);
          if (parent === null || parent === undefined) {
            stats.parentNotFound.push({ file: entry.file, identifier: entry.task.identifier, parent: entry.card.parent });
            stats.warnings.push(`${entry.file}: parent ${entry.card.parent} is not in this import`);
          } else if (parent.kind !== "epic") {
            // §4.8 ③ / M5 ruling: a non-epic parent is a WARN + SKIP, never a
            // thrown MD_PARSE_ERROR — one bad card must not sink the batch.
            stats.parentSkipped.push({
              file: entry.file,
              identifier: entry.task.identifier,
              parent: entry.card.parent,
              parentKind: parent.kind,
            });
            stats.warnings.push(
              `${entry.file}: parent ${entry.card.parent} is a ${parent.kind}; only an epic can be a parent — the parent link was skipped`,
            );
          } else {
            insertRelation(repos, { type: "parent", source: parent.id, target: entry.task.id, now, origin: "md" }, entry, stats, "parent");
          }
        }
      }

      // Pass 4: comments, sessions, reports, progress.
      for (const entry of parsed) {
        if (entry.task === undefined || entry.skipped === true) continue;
        const { task, card } = entry;

        for (const comment of card.comments) {
          if (repos.comments.getBySourceSeq(task.id, comment.sourceSeq) !== null) continue;
          repos.comments.append(
            normalizeCommentCreate(
              { body: comment.body, kind: comment.kind, author: comment.author, refs: comment.refs },
              { now: importTimestamp(comment.ts, now, stats, "comment"), id: newId(), taskId: task.id, sourceSeq: comment.sourceSeq },
            ),
          );
          stats.comments += 1;
        }

        for (const session of card.sessions) {
          repos.sessions.upsertByNaturalKey({
            taskId: task.id,
            seg: session.seg,
            owner: session.owner,
            backend: session.backend,
            sessionId: session.id,
            phase: session.phase === "" ? null : session.phase,
            pid: session.pid === "" ? null : Number(session.pid),
            status: ["running", "closed", "failed"].includes(session.status) ? session.status : "running",
            ts: importTimestamp(session.ts, now, stats, "session"),
          });
          stats.sessions += 1;
        }

        for (const plan of entry.reportPlans) {
          // A report the relaxed path also rejected is genuinely malformed
          // (unknown status, bad anchor, round mismatch, oversized): it stays a
          // skip, and the warning names the reason.
          if (!plan.ok) {
            stats.reportSkipped.push({
              file: entry.file,
              identifier: entry.task.identifier,
              round: plan.round,
              code: plan.code,
              reason: plan.reason,
            });
            stats.warnings.push(
              `${entry.file}: the ## Report block (round ${plan.round}) was not imported (${plan.code}): ${plan.reason}`,
            );
            continue;
          }
          if (repos.reports.latestForRound(task.id, plan.round) !== null) continue;
          if (plan.tag === "report_narrative") {
            stats.reportNarrative.push({ file: entry.file, identifier: entry.task.identifier, round: plan.round });
          } else if (plan.tag === "report_incomplete") {
            stats.reportIncomplete.push({ file: entry.file, identifier: entry.task.identifier, round: plan.round });
          }
          // Every imported report is history, never a delivery: tagged `import`
          // (whether the strict path accepted it or the relaxed path degraded
          // it), so the delivery gate does not count it (0008).
          const stored = repos.reports.insert({ ...plan.prepared, taskId: task.id, origin: "import" });
          stats.reports += 1;
          entry.latestReport = stored;
        }

        for (const [index, line] of card.progress.entries()) {
          const { ts, text } = splitProgressLine(line);
          repos.activities.append({
            taskId: task.id,
            actorKind: entry.task.creatorKind ?? "system",
            actorId: entry.task.creatorId ?? "md-import",
            event: "progress",
            changes: { line, seq: index },
            createdAt: importTimestamp(ts, now, stats, "progress"),
          });
          stats.activities += 1;
        }

        const latest = entry.latestReport ?? (card.reports.length > 0 ? repos.reports.listByTask(task.id).at(-1) : null);
        if (latest !== null && latest !== undefined) {
          repos.tasks.setReportLatest({ id: task.id, reportId: latest.id, now });
        }
      }

      // Pass 5: independent DB-invariant validation. The triggers already refuse
      // a bad edge at insert time (caught per-edge above); this re-derives the
      // same six rules from what actually landed and records any violation as a
      // warning item — never a silent drop (card Comments ②).
      for (const violation of validateBoardInvariants(db)) {
        stats.invariantViolations.push(violation);
        stats.warnings.push(
          `board invariant ${violation.reason} on ${violation.identifier ?? violation.source}: ${violation.detail}`,
        );
      }

      stats.cards = parsed.length;
      return stats;
    },
    { op: "md.import" },
  );
}

/**
 * Resolve one card's `project:` through the registry.
 *
 * @param {string} rawName the card's `project` value (already known non-empty)
 * @param {{registry: object|null, createProject: boolean}} options
 * @returns {{ok: true, projectId: string, name: string, workspacePath: string|null, meta: object, source: string, notice?: string}|{ok: false, warning: string}}
 */
function resolveProjectPlan(rawName, { registry, createProject }) {
  if (registry !== null && registry !== undefined) {
    const entry = registry.resolve(rawName);
    if (entry !== null) {
      return {
        ok: true,
        projectId: entry.id,
        name: entry.name,
        workspacePath: entry.workspacePath,
        meta: entry.meta,
        source: entry.meta?.buildin === true ? "buildin" : "registry",
      };
    }
    if (createProject) {
      const id = String(rawName).trim();
      return {
        ok: true,
        projectId: id,
        name: id,
        workspacePath: null,
        meta: {},
        source: "created",
        notice: `created project ${JSON.stringify(id)}: not in the registry, and --create-project was given`,
      };
    }
    return {
      ok: false,
      warning: `project ${JSON.stringify(rawName)} is not a registered project name — the card was skipped (pass --create-project to create it)`,
    };
  }

  // No registry file: buildin names still resolve to their synthetic plan; every
  // other name keeps the historical "the name is the id" behaviour.
  const buildin = resolveBuildinProject(rawName);
  if (buildin !== null) {
    return {
      ok: true,
      projectId: buildin.id,
      name: buildin.name,
      workspacePath: buildin.workspacePath,
      meta: buildin.meta,
      source: "buildin",
    };
  }
  const id = String(rawName).trim();
  return { ok: true, projectId: id, name: id, workspacePath: null, meta: {}, source: "legacy" };
}

/**
 * Insert one relation, turning any invariant refusal into a warning instead of
 * an abort — a real card that violates an invariant must be reported, not lost.
 *
 * @param {object} repos
 * @param {{type: string, source: string, target: string, now: string, origin: string}} edge
 * @param {object} entry
 * @param {object} stats
 * @param {string} field
 */
function insertRelation(repos, edge, entry, stats, field) {
  try {
    repos.relations.insert(edge);
    stats.relations += 1;
  } catch (err) {
    const code = isDomainError(err) ? err.code : "RELATION_REJECTED";
    stats.invariantViolations.push({
      reason: code,
      field,
      file: entry.file,
      identifier: entry.task.identifier,
      source: edge.source,
      target: edge.target,
      detail: err.message,
    });
    stats.warnings.push(
      `${entry.file}: the ${field} link was rejected (${code}) — recorded as a warning: ${err.message}`,
    );
  }
}

/**
 * Re-derive the six relation invariants from the board as it now stands.
 * @param {object} db
 */
function validateBoardInvariants(db) {
  const tasks = db
    .prepare("SELECT id, identifier, project_id, kind FROM tasks")
    .all()
    .map((row) => ({ id: row.id, identifier: row.identifier, projectId: row.project_id, kind: row.kind }));
  const relations = db
    .prepare("SELECT relation_type, source_task_id, target_task_id FROM task_relations")
    .all()
    .map((row) => ({ type: row.relation_type, source: row.source_task_id, target: row.target_task_id }));
  return checkRelationInvariants({ tasks, relations }).violations;
}

/** Parse one card file into the shape the rest of the importer wants. */
export function parseCard(text, { file }) {
  const { data, order, body } = parseFrontmatter(text, { file });
  const { sections, extra } = splitSections(body);

  const identifier = data.id;
  if (typeof identifier !== "string" || identifier.trim() === "") {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `${file}: frontmatter needs an 'id'`,
      details: { file, field: "id" },
    });
  }
  if (typeof data.title !== "string" || data.title.trim() === "") {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `${file}: frontmatter needs a 'title'`,
      details: { file, field: "title" },
    });
  }

  const { status, legacyStatus } = statusForImport(data.status ?? "todo");
  const legacy = {};
  const meta = {};
  for (const key of order) {
    const canonical = CARD_KEY_ALIASES[key] ?? key;
    if (!KNOWN_CARD_KEYS.includes(canonical)) legacy[key] = data[key];
    else if (META_KEYS.includes(canonical) && key === canonical) meta[canonical] = data[key];
  }
  // Read-compat: an alias only fills in for a canonical key the card did not
  // carry, so the new spelling always wins regardless of key order.
  for (const key of order) {
    const canonical = CARD_KEY_ALIASES[key];
    if (canonical !== undefined && meta[canonical] === undefined) meta[canonical] = data[key];
  }

  // Tolerated lines (prose in `## Acceptance`, a table row in a report's
  // acceptance sub-block, a comment without a separator …) are collected here
  // and surfaced on the card, so a lenient parse is still observable rather
  // than silent.
  const notices = [];
  const acceptance = sections.has("Acceptance")
    ? parseAcceptanceBlock(sections.get("Acceptance"), { notices, section: "Acceptance" })
    : [];
  const reports = sections.has("Report")
    ? parseReportBlock(sections.get("Report"), { notices, section: "Report" })
    : [];
  const reportMissingWarning =
    reports.length === 0 && (status === "in_review" || status === "done");
  const reportNarrative = reports.some((report) => report.narrative === true);
  const importWarnings = [];
  if (reportMissingWarning) importWarnings.push("report_missing");
  if (reportNarrative) importWarnings.push("report_narrative");
  // A tolerated line parsed, but was not understood: record it so the lenient
  // parse is visible in the persisted metadata, not just on the returned card.
  if (notices.length > 0) importWarnings.push("parse_tolerated");

  return {
    identifier,
    title: data.title,
    status,
    legacyStatus,
    priority: parsePriority(data.priority ?? null),
    kind: data.kind === "epic" ? "epic" : "task",
    labels: normalizeLabels(data.labels ?? null),
    project: nullable(data.project),
    target: typeof data.target === "string" && data.target.trim() !== "" ? data.target : null,
    assignee: nullable(data.assignee),
    assigneeKind: data.assignee_kind ?? "agent",
    reporter: nullable(data.created_by),
    createdBy: nullable(data.created_by),
    createdAt: nullable(data.created_at),
    updatedAt: nullable(data.updated_at) ?? nullable(data.created_at),
    statusChangedAt: nullable(data.status_changed_at),
    claimedBy: nullable(data.claimed_by),
    claimedAt: nullable(data.claimed_at),
    heartbeatAt: nullable(data.heartbeat_at),
    blockedAt: nullable(data.blocked_at),
    dependsOn: normalizeLabels(data.depends_on ?? null),
    parent: typeof data.parent === "string" && data.parent.trim() !== "" ? data.parent : null,
    reviewOf: typeof data.review_of === "string" && data.review_of.trim() !== "" ? data.review_of : null,
    notifyLeader: nullable(meta.notify_leader),
    acceptance,
    progress: sections.has("Progress") ? parseProgressBlock(sections.get("Progress")) : [],
    comments: sections.has("Comments")
      ? parseCommentsBlock(sections.get("Comments"), { notices, section: "Comments" }).map((comment, index) => ({
          ...comment,
          sourceSeq: index + 1,
          author: {
            kind: /^(elon|terry|tanyu)$/i.test(comment.authorId) ? "human" : "agent",
            id: comment.authorId,
          },
          refs: [],
        }))
      : [],
    sessions: sections.has("Sessions")
      ? parseSessionsBlock(sections.get("Sessions"), { notices, section: "Sessions" })
      : [],
    reports: reports.map((report) => ({
      ...report,
      author: report.authorId === null ? null : { kind: authorKind(report.authorId), id: report.authorId },
      evidence: report.evidence,
    })),
    reportMissingWarning,
    background: sections.has("Background") ? sections.get("Background") : extra,
    legacy,
    // Tolerated lines — the card parsed, but not every line was understood.
    notices,
    meta: {
      ...(legacyStatus === null ? {} : { legacy_status: legacyStatus }),
      ...(meta.notify_leader === undefined ? {} : { notify_leader: meta.notify_leader }),
      ...(Object.keys(legacy).length === 0 ? {} : { legacy }),
      // The checkbox state is kept as *legacy* metadata — never as a report.
      acceptance_legacy: acceptance,
      ...(importWarnings.length === 0 ? {} : { import_warnings: importWarnings }),
    },
    extra,
  };
}

function authorKind(authorId) {
  return /^(elon|terry|tanyu)$/i.test(String(authorId)) ? "human" : "agent";
}

/**
 * Checkbox-style acceptance markers a hand-written report may carry where the
 * schema wants a canonical status. A card's `## Report` can list `- [x] <item>`
 * under a `### Acceptance` heading; the domain gate stays strict, so the alias
 * lives here at the import edge, next to the timestamp coercion.
 */
const REPORT_STATUS_ALIASES = Object.freeze({ x: "met" });

/**
 * Coerce one report acceptance status onto the canonical set. An unknown status
 * is returned untouched — a genuinely malformed report must still fail
 * validation rather than be silently rewritten.
 *
 * @param {unknown} status
 * @returns {unknown}
 */
function canonicalReportStatus(status) {
  const key = String(status ?? "").trim().toLowerCase();
  if (ACCEPTANCE_STATUSES.includes(key)) return key;
  return REPORT_STATUS_ALIASES[key] ?? status;
}

/**
 * Prepare one card report for insertion: the strict delivery gate first, the
 * relaxed historical path second.
 *
 * A historical narrative (no acceptance list, no evidence anchor) is stored
 * conclusion-only; a structured-but-incomplete report (acceptance items, no
 * `evidence:` block) is stored with its acceptance items and empty evidence —
 * nothing fabricated, and never dropped. The tag records which shape applied.
 * A report the relaxed path also rejects is left for the caller to skip.
 *
 * @param {object} report a parsed report block
 * @param {string} now the report's own (already canonical) timestamp
 * @returns {{ok: true, prepared: object, tag: string|null, round: number}|{ok: false, code: string, reason: string, round: number}}
 */
function planReportImport(report, now) {
  const round = report.round;
  const input = {
    conclusion: report.conclusion,
    acceptance: report.acceptance.map((item) => ({ ...item, status: canonicalReportStatus(item.status) })),
    evidence: report.evidence,
    leftovers: report.leftovers,
    author: report.author ?? { kind: "agent", id: report.authorId ?? "unknown" },
  };
  const context = { taskRound: round, now };
  try {
    return { ok: true, prepared: normalizeReportCreate(input, context), tag: null, round };
  } catch {
    /* fall through to the relaxed historical path */
  }
  try {
    const prepared = normalizeImportedReport(input, context);
    const tag =
      report.acceptance.length === 0 && report.evidence.length === 0 ? "report_narrative" : "report_incomplete";
    return { ok: true, prepared, tag, round };
  } catch (err) {
    return {
      ok: false,
      code: isDomainError(err) ? err.code : "REPORT_INVALID",
      reason: err.message,
      round,
    };
  }
}

/**
 * Rebuild a card's `meta.import_warnings` from the planned reports, so the tag
 * that reaches the stored task reflects the *actual* import outcome (a report
 * that was skipped is not tagged as degraded).
 *
 * @param {object} card
 * @param {object[]} plans
 */
function mergeReportWarnings(card, plans) {
  const tags = [];
  if (card.reportMissingWarning === true) tags.push("report_missing");
  for (const plan of plans) if (plan.ok && plan.tag !== null) tags.push(plan.tag);
  if (card.notices.length > 0) tags.push("parse_tolerated");
  if (tags.length === 0) delete card.meta.import_warnings;
  else card.meta.import_warnings = tags;
}

function findExisting(repos, projectId, rel) {
  const rows = repos.tasks.list({ projectId, includeArchived: true, limit: 1000 });
  return rows.find((task) => task.sourcePath === rel) ?? null;
}

/**
 * Create the project row for a card's plan, if it is not there yet.
 *
 * The workspace path is the registry's `root` when there is one (the registry is
 * the source of truth for project metadata; the board is the authority), and the
 * card's `target` otherwise. A card with neither, naming a project that does not
 * exist, is still a hard error: there is no path to anchor the task to.
 *
 * @param {object} repos
 * @param {{id: string, name: string, meta: object, source: string, workspacePath: string|null}} plan
 * @param {object} card
 * @param {string} now
 * @param {object} stats
 */
function ensureProject(repos, plan, card, now, stats) {
  if (repos.projects.get(plan.id) !== null) return;
  const workspacePath = plan.workspacePath ?? card.target ?? null;
  if (workspacePath === null || workspacePath === undefined) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `card ${card.identifier} has no 'target' and project ${plan.id} does not exist yet`,
      details: { field: "target", project: plan.id },
    });
  }
  repos.projects.create({
    id: plan.id,
    name: plan.name,
    workspacePath,
    meta: plan.meta ?? {},
    now,
  });
  if (plan.source === "legacy") {
    stats.notices.push(`auto-created project ${plan.id} from a card's 'project' value (no --projects registry given)`);
  }
}

/** Event-driven dictionary upsert for the two names a card carries. */
function resolveCardDictionaries(repos, card, now) {
  const writes = { assigneeId: null, assigneeKind: null, reporterId: null, count: 0 };
  if (typeof card.assignee === "string" && card.assignee.trim() !== "") {
    const { entry } = repos.dictionary.upsert({
      kind: "assignee",
      actorKind: card.assigneeKind === "human" ? "human" : "agent",
      normalizedName: normalizeName(card.assignee),
      displayName: card.assignee,
      now,
    });
    writes.assigneeId = entry.id;
    writes.assigneeKind = entry.kind;
    writes.count += 1;
  }
  if (typeof card.reporter === "string" && card.reporter.trim() !== "") {
    const { entry } = repos.dictionary.upsert({
      kind: "reporter",
      actorKind: authorKind(card.reporter),
      normalizedName: normalizeName(card.reporter),
      displayName: card.reporter,
      now,
    });
    writes.reporterId = entry.id;
    writes.count += 1;
  }
  if (typeof card.claimedBy === "string" && card.claimedBy.trim() !== "") {
    const { entry } = repos.dictionary.upsert({
      kind: "assignee",
      actorKind: authorKind(card.claimedBy),
      normalizedName: normalizeName(card.claimedBy),
      displayName: card.claimedBy,
      now,
    });
    writes.claimedById = entry.id;
    writes.count += 1;
  }
  return writes;
}

/**
 * Event-driven label registration for one imported card (§3.7), the label twin
 * of `resolveCardDictionaries`.
 *
 * Like that helper it talks to the repository directly rather than importing the
 * command layer: `repos.labels` stays the single writer of the registry, and the
 * storage layer keeps pointing at domain + storage only. The rules are the ones
 * the command layer applies — `norm` identity, first-seen spelling wins, colours
 * assigned once from the project's free palette, `use_count` moved by the diff
 * against the task's previous labels ("none" for a fresh insert).
 *
 * @returns {{names: string[], writes: number}}
 */
function resolveCardLabels(repos, card, existing, now) {
  const names = normalizeLabels(card.labels ?? null);
  const previous = new Set((existing?.labels ?? []).map((name) => normalizeLabelName(name)));

  if (names.length === 0) {
    for (const key of previous) {
      const label = repos.labels.getByNorm(card.projectId, key);
      if (label !== null) repos.labels.removeUse(label.id);
    }
    return { names: [], writes: 0 };
  }

  const consumed = repos.labels.usedColors(card.projectId);
  const stored = [];
  const seen = new Set();
  let writes = 0;

  for (const raw of names) {
    const key = normalizeLabelName(raw);
    if (seen.has(key)) continue;
    seen.add(key);

    let label = repos.labels.getByNorm(card.projectId, key);
    if (label === null) {
      const color = nextColor(consumed, LABEL_PALETTE);
      consumed.push(color);
      label = repos.labels.upsert({
        projectId: card.projectId,
        norm: key,
        displayName: labelDisplayName(raw),
        color,
        now,
      }).entry;
    } else {
      label = repos.labels.upsert({
        projectId: card.projectId,
        norm: key,
        displayName: label.displayName,
        color: label.color,
        now,
        id: label.id,
      }).entry;
    }
    writes += 1;
    stored.push(label.displayName);
    if (!previous.has(key)) repos.labels.addUse(label.id, now);
  }

  for (const key of previous) {
    if (seen.has(key)) continue;
    const label = repos.labels.getByNorm(card.projectId, key);
    if (label !== null) repos.labels.removeUse(label.id);
  }

  return { names: stored, writes };
}

function buildTask(repos, card, context) {
  const { now, rel, hash, dictionary, labels } = context;
  const serial = repos.projects.get(card.projectId)?.nextTaskNumber ?? 1;
  const identifier = card.identifier;

  const task = normalizeTaskCreate(
    {
      title: card.title,
      description: card.background ?? "",
      priority: card.priority,
      kind: card.kind,
      // The registry's display names, not the raw frontmatter spellings — an
      // imported card ends up with the same first-seen label spelling a CLI
      // write would have produced.
      labels: labels ?? card.labels,
      assigneeKind: dictionary.assigneeKind,
      assigneeId: dictionary.assigneeId,
      reporterId: dictionary.reporterId,
      creator: card.createdBy === null ? null : { kind: authorKind(card.createdBy), id: card.createdBy },
      sourcePath: rel,
      sourceHash: hash,
      meta: card.meta,
    },
    {
      now,
      id: newId(),
      identifier,
      projectId: card.projectId,
    },
  );

  return {
    ...task,
    status: card.status,
    statusChangedAt: card.statusChangedAt ?? card.createdAt ?? now,
    createdAt: card.createdAt ?? now,
    updatedAt: card.updatedAt ?? card.createdAt ?? now,
    claimedBy: card.claimedBy,
    claimedAt: card.claimedAt,
    heartbeatAt: card.heartbeatAt,
    blockedAt: card.blockedAt ?? (card.status === "blocked" ? card.statusChangedAt ?? now : null),
    sortOrder: 0,
  };
}

/** The columns an update may touch on a re-import. */
function patchFrom(task) {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    kind: task.kind,
    labels: task.labels,
    assigneeKind: task.assigneeKind,
    assigneeId: task.assigneeId,
    reporterId: task.reporterId,
    sourceHash: task.sourceHash,
    meta: task.meta,
  };
}

/** Stable identity for a card, used by `check` output. */
export function cardFingerprint(card) {
  return contentHash({
    identifier: card.identifier,
    title: card.title,
    status: card.status,
    comments: card.comments.length,
    reports: card.reports.length,
    sessions: card.sessions.length,
  });
}

export { identifierFor, TS_FALLBACK };
