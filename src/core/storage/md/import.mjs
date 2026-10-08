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
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { DomainError } from "../../../shared/errors.mjs";
import { LABEL_PALETTE } from "../../../shared/constants.mjs";
import { contentHash, newId, sha256Hex } from "../../../shared/ids.mjs";
import { normalizeName } from "../../domain/dictionary.mjs";
import { labelDisplayName, nextColor, normalizeLabelName } from "../../domain/labels.mjs";
import { normalizeCommentCreate } from "../../domain/comment.mjs";
import { normalizeReportCreate } from "../../domain/report.mjs";
import { parsePriority } from "../../domain/priority.mjs";
import { identifierFor, normalizeLabels, normalizeTaskCreate } from "../../domain/task.mjs";
import { transaction } from "../unit-of-work.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { statusForImport } from "./legacy-status.mjs";
import {
  parseAcceptanceBlock,
  parseCommentsBlock,
  parseProgressBlock,
  parseReportBlock,
  parseSessionsBlock,
  splitProgressLine,
  splitSections,
} from "./sections.mjs";

/** Frontmatter keys the importer understands; everything else is kept verbatim. */
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
  "review_of",
  "notify_elon",
  "goal",
]);

/** Keys that are stored in `meta_json` rather than in a column. */
const META_KEYS = Object.freeze(["notify_elon"]);

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
 * @param {{db: object, repos: object, dir: string, projectId?: string, target?: string, now: string, check?: boolean, resume?: boolean, logger?: Function}} input
 */
export function importMd(input) {
  const { db, repos, dir, now, check = false, resume = false } = input;
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
    warnings: [],
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
        parsed.push({
          file: name,
          rel: relative(dir, path) || name,
          hash: sha256Hex(text),
          parsed: parseCard(text, { file: basename(path) }),
        });
      }

      // Pass 1: projects (a card may name a project no other card created).
      const projectIds = new Map();
      for (const entry of parsed) {
        const card = entry.parsed;
        const projectId = card.project ?? input.projectId;
        if (projectId === undefined || projectId === null || projectId === "") {
          throw new DomainError("MD_PARSE_ERROR", {
            message: `${entry.file}: no 'project' in frontmatter and no --project given`,
            details: { file: entry.file, field: "project" },
          });
        }
        card.projectId = projectId;
        if (projectIds.has(projectId)) {
          if (projectIds.get(projectId) !== card.target && card.target !== null) {
            throw new DomainError("MD_PARSE_ERROR", {
              message: `${entry.file}: project ${projectId} is used with two different targets (${projectIds.get(projectId)} and ${card.target})`,
              details: { file: entry.file, project: projectId, field: "target" },
            });
          }
          continue;
        }
        projectIds.set(projectId, card.target ?? input.target ?? null);
      }

      // Pass 2: tasks.
      for (const entry of parsed) {
        const card = entry.parsed;
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

        ensureProject(repos, card, projectIds.get(card.projectId), now);
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
      const byIdentifier = new Map();
      for (const entry of parsed) {
        if (entry.task !== undefined) byIdentifier.set(entry.task.identifier, entry.task);
      }
      for (const entry of parsed) {
        if (entry.task === undefined || entry.skipped === true) continue;
        for (const dependency of entry.card.dependsOn) {
          const blocker = byIdentifier.get(dependency) ?? repos.tasks.getByIdentifier(entry.card.projectId, dependency);
          if (blocker === null || blocker === undefined) {
            stats.warnings.push(`${entry.file}: depends_on ${dependency} is not in this import`);
            continue;
          }
          if (blocker.id === entry.task.id) continue;
          repos.relations.insert({ type: "blocks", source: blocker.id, target: entry.task.id, now, origin: "md" });
          stats.relations += 1;
        }
        if (entry.card.parent !== null) {
          const parent = byIdentifier.get(entry.card.parent) ?? repos.tasks.getByIdentifier(entry.card.projectId, entry.card.parent);
          if (parent === null || parent === undefined) {
            stats.warnings.push(`${entry.file}: parent ${entry.card.parent} is not in this import`);
          } else if (parent.kind !== "epic") {
            throw new DomainError("MD_PARSE_ERROR", {
              message: `${entry.file}: parent ${entry.card.parent} is a ${parent.kind}; only an epic can be a parent`,
              details: { file: entry.file, field: "parent" },
            });
          } else {
            repos.relations.insert({ type: "parent", source: parent.id, target: entry.task.id, now, origin: "md" });
            stats.relations += 1;
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
              { now: comment.ts ?? now, id: newId(), taskId: task.id, sourceSeq: comment.sourceSeq },
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
            ts: session.ts,
          });
          stats.sessions += 1;
        }

        for (const report of card.reports) {
          if (repos.reports.latestForRound(task.id, report.round) !== null) continue;
          const prepared = normalizeReportCreate(
            {
              conclusion: report.conclusion,
              acceptance: report.acceptance,
              evidence: report.evidence,
              leftovers: report.leftovers,
              author: report.author ?? { kind: "agent", id: report.authorId ?? "unknown" },
            },
            { taskRound: report.round, now: report.ts ?? now },
          );
          const stored = repos.reports.insert({ ...prepared, taskId: task.id });
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
            createdAt: /^\d{4}-\d{2}-\d{2}T/.test(ts) ? ts : now,
          });
          stats.activities += 1;
        }

        const latest = entry.latestReport ?? (card.reports.length > 0 ? repos.reports.listByTask(task.id).at(-1) : null);
        if (latest !== null && latest !== undefined) {
          repos.tasks.setReportLatest({ id: task.id, reportId: latest.id, now });
        }
      }

      stats.cards = parsed.length;
      return stats;
    },
    { op: "md.import" },
  );
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
    if (!KNOWN_CARD_KEYS.includes(key)) legacy[key] = data[key];
    else if (META_KEYS.includes(key)) meta[key] = data[key];
  }

  const reports = sections.has("Report") ? parseReportBlock(sections.get("Report")) : [];
  const reportMissingWarning =
    reports.length === 0 && (status === "in_review" || status === "done");

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
    notifyElon: nullable(meta.notify_elon),
    acceptance: sections.has("Acceptance") ? parseAcceptanceBlock(sections.get("Acceptance")) : [],
    progress: sections.has("Progress") ? parseProgressBlock(sections.get("Progress")) : [],
    comments: sections.has("Comments")
      ? parseCommentsBlock(sections.get("Comments")).map((comment, index) => ({
          ...comment,
          sourceSeq: index + 1,
          author: {
            kind: /^(elon|terry|tanyu)$/i.test(comment.authorId) ? "human" : "agent",
            id: comment.authorId,
          },
          refs: [],
        }))
      : [],
    sessions: sections.has("Sessions") ? parseSessionsBlock(sections.get("Sessions")) : [],
    reports: reports.map((report) => ({
      ...report,
      author: report.authorId === null ? null : { kind: authorKind(report.authorId), id: report.authorId },
      evidence: report.evidence,
    })),
    reportMissingWarning,
    background: sections.has("Background") ? sections.get("Background") : extra,
    legacy,
    meta: {
      ...(legacyStatus === null ? {} : { legacy_status: legacyStatus }),
      ...(meta.notify_elon === undefined ? {} : { notify_elon: meta.notify_elon }),
      ...(Object.keys(legacy).length === 0 ? {} : { legacy }),
      acceptance_legacy: parseAcceptanceChecklist(sections.get("Acceptance")),
      ...(reportMissingWarning ? { import_warnings: ["report_missing"] } : {}),
    },
    extra,
  };
}

function authorKind(authorId) {
  return /^(elon|terry|tanyu)$/i.test(String(authorId)) ? "human" : "agent";
}

/** The checkbox state is kept as *legacy* metadata — never as a report. */
function parseAcceptanceChecklist(text) {
  return text === undefined ? [] : parseAcceptanceBlock(text);
}

function findExisting(repos, projectId, rel) {
  const rows = repos.tasks.list({ projectId, includeArchived: true, limit: 1000 });
  return rows.find((task) => task.sourcePath === rel) ?? null;
}

function ensureProject(repos, card, target, now) {
  if (repos.projects.get(card.projectId) !== null) return;
  const workspacePath = card.target ?? target;
  if (workspacePath === null || workspacePath === undefined) {
    throw new DomainError("MD_PARSE_ERROR", {
      message: `card ${card.identifier} has no 'target' and project ${card.projectId} does not exist yet`,
      details: { field: "target", project: card.projectId },
    });
  }
  repos.projects.create({
    id: card.projectId,
    name: card.projectId,
    workspacePath,
    now,
  });
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
