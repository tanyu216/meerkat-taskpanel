/**
 * The Task DTO and its validation.
 *
 * Naming rule for the whole codebase: the domain speaks camelCase
 * (`projectId`), SQL speaks snake_case (`project_id`). `taskFromRow` /
 * `taskToRow` are the only two places that translate, so a column rename is a
 * one-line change and never leaks into command code.
 *
 * Pure: no `node:` specifiers, no clock — callers pass `now`.
 */

import { ARCHIVE_AFTER_DAYS, HEARTBEAT_FRESH_MS, IDENTIFIER_PATTERN } from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { identifierPrefix } from "../../shared/ids.mjs";
import { ACTOR_KINDS, DICT_KINDS, STATUSES, TASK_KINDS } from "./enums.mjs";
import { parsePriority } from "./priority.mjs";
import { isTerminalStatus } from "./status.mjs";

/** Every column `tasks` has, in a stable order (DTO ⇄ row translation). */
export const TASK_COLUMNS = Object.freeze([
  "id",
  "identifier",
  "project_id",
  "title",
  "description",
  "status",
  "priority",
  "kind",
  "labels",
  "sort_order",
  "assignee_kind",
  "assignee_id",
  "reporter_id",
  "creator_kind",
  "creator_id",
  "agent_session",
  "thread_id",
  "thread_source",
  "claimed_by",
  "claimed_at",
  "heartbeat_at",
  "blocked_at",
  "status_changed_at",
  "archived_at",
  "source_path",
  "source_hash",
  "meta_json",
  "report_latest_id",
  "delivery_round",
  "report_waiver_round",
  "report_waiver_reason",
  "report_waived_at",
  "version",
  "created_at",
  "updated_at",
]);

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `meta_json` is TEXT in the schema; a broken value must not break a read. */
function decodeJsonObject(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// small validators (exported so commands can reuse the same wording)
// ---------------------------------------------------------------------------

/** @param {unknown} value */
export function isIsoMillis(value) {
  if (typeof value !== "string" || !ISO_MILLIS.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Timestamps are TEXT, UTC, and always exactly 25 characters — lexicographic
 * order has to equal chronological order (the report gate and the SSE cursor
 * both compare them as strings).
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function assertIsoMillis(value, field) {
  if (!isIsoMillis(value)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field} must be an ISO-8601 UTC timestamp with millisecond precision (2026-10-08T00:00:00.000Z)`,
      details: { field, received: value },
    });
  }
  return value;
}

/** Accept a Date or any parseable string; always return the canonical form. */
export function toIsoMillis(value, field = "timestamp") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DomainError("VALIDATION_FAILED", { message: `${field} is an invalid Date`, details: { field } });
    }
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `${field} is not a parseable timestamp`,
        details: { field, received: value },
      });
    }
    return parsed.toISOString();
  }
  throw new DomainError("VALIDATION_FAILED", {
    message: `${field} must be a Date or an ISO-8601 string`,
    details: { field, received: typeof value },
  });
}

/** @param {unknown} value @param {string} field */
export function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field} must be a non-empty string`,
      details: { field, received: value },
    });
  }
  return value;
}

/** A project's workspace path is an absolute local path (ARCHITECTURE §4.4). */
export function normalizeWorkspacePath(value, field = "workspacePath") {
  assertNonEmptyString(value, field);
  if (!value.startsWith("/")) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field} must be an absolute path`,
      details: { field, received: value },
    });
  }
  return value.replace(/\/+$/, "") === "" ? "/" : value.replace(/\/+$/, "");
}

/** @param {unknown} value */
export function isValidIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

/** `PROJ-0007` for project `proj` and serial 7. */
export function identifierFor(projectId, serial) {
  const prefix = identifierPrefix(projectId);
  if (prefix === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `project id ${JSON.stringify(projectId)} has no usable identifier prefix`,
      details: { field: "projectId", received: projectId },
    });
  }
  return `${prefix}-${String(serial).padStart(4, "0")}`;
}

/** Labels are a JSON array of short unique strings; order matters (it is shown). */
export function normalizeLabels(value) {
  if (value === null || value === undefined || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value.split(",");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "labels must be an array of strings",
      details: { field: "labels", received: typeof value },
    });
  }
  const out = [];
  for (const label of parsed) {
    const text = String(label).trim();
    if (text === "") continue;
    if (text.length > 64) {
      throw new DomainError("VALIDATION_FAILED", {
        message: "labels must be 64 characters or fewer",
        details: { field: "labels", received: text },
      });
    }
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > 32) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "a task may carry at most 32 labels",
      details: { field: "labels", count: out.length },
    });
  }
  return out;
}

/** `{kind, id}` for creators/assignees, or null. */
export function normalizeActor(value, field) {
  if (value === null || value === undefined) return null;
  const kind = value.kind;
  const id = value.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field}.id must be a non-empty string`,
      details: { field: `${field}.id`, received: id },
    });
  }
  if (!ACTOR_KINDS.includes(kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `${field}.kind must be one of ${ACTOR_KINDS.join(", ")}`,
      details: { field: `${field}.kind`, received: kind, allowed: ACTOR_KINDS },
    });
  }
  return { kind, id };
}

// ---------------------------------------------------------------------------
// create / update
// ---------------------------------------------------------------------------

/**
 * Validate and default a task creation payload.
 *
 * @param {object} input
 * @param {{now: string, id: string, identifier: string, projectId?: string}} context
 * @returns {object} a Task DTO (id/identifier/version/timestamps filled in)
 */
export function normalizeTaskCreate(input, context) {
  if (input === null || typeof input !== "object") {
    throw new DomainError("VALIDATION_FAILED", { message: "task payload must be an object" });
  }
  const { now, id, identifier } = context;
  assertIsoMillis(now, "now");

  const projectId = context.projectId ?? input.projectId;
  assertNonEmptyString(projectId, "projectId");
  assertNonEmptyString(id, "id");
  if (!isValidIdentifier(identifier)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `identifier ${JSON.stringify(identifier)} is not usable as a task identifier`,
      details: { field: "identifier", received: identifier },
    });
  }

  const status = input.status ?? "todo";
  if (!STATUSES.includes(status)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown status ${JSON.stringify(status)}`,
      details: { field: "status", received: status, allowed: STATUSES },
    });
  }

  const kind = input.kind ?? "task";
  if (!TASK_KINDS.includes(kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown kind ${JSON.stringify(kind)}`,
      details: { field: "kind", received: kind, allowed: TASK_KINDS },
    });
  }

  const assigneeKind = input.assigneeKind ?? null;
  if (assigneeKind !== null && !DICT_KINDS.includes(assigneeKind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `assigneeKind must be one of ${DICT_KINDS.join(", ")}`,
      details: { field: "assigneeKind", received: assigneeKind, allowed: DICT_KINDS },
    });
  }

  return {
    id,
    identifier,
    projectId,
    title: assertNonEmptyString(input.title, "title").trim(),
    description: input.description ?? "",
    status,
    priority: parsePriority(input.priority),
    kind,
    labels: normalizeLabels(input.labels),
    sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder : 0,
    assigneeKind,
    assigneeId: input.assigneeId ?? null,
    reporterId: input.reporterId ?? null,
    creatorKind: normalizeActor(input.creator, "creator")?.kind ?? null,
    creatorId: normalizeActor(input.creator, "creator")?.id ?? null,
    agentSession: input.agentSession ?? null,
    threadId: input.threadId ?? null,
    threadSource: input.threadSource ?? null,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    blockedAt: status === "blocked" ? now : null,
    statusChangedAt: now,
    archivedAt: null,
    sourcePath: input.sourcePath ?? null,
    sourceHash: input.sourceHash ?? null,
    meta: input.meta ?? {},
    reportLatestId: null,
    deliveryRound: 1,
    // A waiver is per delivery round and is never set at creation (F-B1).
    reportWaiverRound: null,
    reportWaiverReason: null,
    reportWaivedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fields a caller may change through `updateTask`. */
export const UPDATABLE_TASK_FIELDS = Object.freeze([
  "title",
  "description",
  "priority",
  "kind",
  "labels",
  "sortOrder",
  "assigneeKind",
  "assigneeId",
  "reporterId",
  "agentSession",
  "threadId",
  "threadSource",
  "sourceHash",
  "meta",
]);

/**
 * Validate a partial update. `status` is *not* updatable here — it moves
 * through `moveStatus`, which is where the gate lives.
 *
 * @param {object} input
 * @param {{now: string}} context
 * @returns {object} only the provided fields, normalised
 */
export function normalizeTaskUpdate(input, context) {
  if (input === null || typeof input !== "object") {
    throw new DomainError("VALIDATION_FAILED", { message: "task patch must be an object" });
  }
  assertIsoMillis(context.now, "now");

  if (input.status !== undefined) {
    throw new DomainError("INVALID_TRANSITION", {
      message: "status is not a patchable field — use moveStatus/deliver",
      details: { field: "status", hint: "taskctl issue move <identifier> --to <status>" },
    });
  }

  const patch = {};
  for (const field of Object.keys(input)) {
    if (!UPDATABLE_TASK_FIELDS.includes(field)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `unknown task field ${JSON.stringify(field)}`,
        details: { field, allowed: UPDATABLE_TASK_FIELDS },
      });
    }
  }
  if (input.title !== undefined) patch.title = assertNonEmptyString(input.title, "title").trim();
  if (input.description !== undefined) patch.description = String(input.description);
  if (input.priority !== undefined) patch.priority = parsePriority(input.priority);
  if (input.kind !== undefined) {
    if (!TASK_KINDS.includes(input.kind)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `unknown kind ${JSON.stringify(input.kind)}`,
        details: { field: "kind", allowed: TASK_KINDS },
      });
    }
    patch.kind = input.kind;
  }
  if (input.labels !== undefined) patch.labels = normalizeLabels(input.labels);
  if (input.sortOrder !== undefined) patch.sortOrder = Number(input.sortOrder);
  // `meta` is in UPDATABLE_TASK_FIELDS, so a caller may patch it — but M1 listed
  // it without copying it, which silently dropped the write. M2's
  // `issue update --meta k=v` (and the `--acceptance` sugar that lands in
  // `meta.acceptance`) is what surfaced it.
  if (input.meta !== undefined) {
    if (input.meta === null || typeof input.meta !== "object" || Array.isArray(input.meta)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: "meta must be an object",
        details: { field: "meta", received: Array.isArray(input.meta) ? "array" : typeof input.meta },
      });
    }
    patch.meta = input.meta;
  }
  if (input.assigneeKind !== undefined) {
    if (input.assigneeKind !== null && !DICT_KINDS.includes(input.assigneeKind)) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `assigneeKind must be one of ${DICT_KINDS.join(", ")}`,
        details: { field: "assigneeKind", allowed: DICT_KINDS },
      });
    }
    patch.assigneeKind = input.assigneeKind;
  }
  for (const field of ["assigneeId", "reporterId", "agentSession", "threadId", "threadSource", "sourceHash"]) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (Object.keys(patch).length === 0) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "task patch is empty",
      details: { allowed: UPDATABLE_TASK_FIELDS },
    });
  }
  return patch;
}

// ---------------------------------------------------------------------------
// DTO ⇄ row
// ---------------------------------------------------------------------------

const CAMEL = {
  id: "id",
  identifier: "identifier",
  project_id: "projectId",
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  kind: "kind",
  labels: "labels",
  sort_order: "sortOrder",
  assignee_kind: "assigneeKind",
  assignee_id: "assigneeId",
  reporter_id: "reporterId",
  creator_kind: "creatorKind",
  creator_id: "creatorId",
  agent_session: "agentSession",
  thread_id: "threadId",
  thread_source: "threadSource",
  claimed_by: "claimedBy",
  claimed_at: "claimedAt",
  heartbeat_at: "heartbeatAt",
  blocked_at: "blockedAt",
  status_changed_at: "statusChangedAt",
  archived_at: "archivedAt",
  source_path: "sourcePath",
  source_hash: "sourceHash",
  meta_json: "meta",
  report_latest_id: "reportLatestId",
  delivery_round: "deliveryRound",
  report_waiver_round: "reportWaiverRound",
  report_waiver_reason: "reportWaiverReason",
  report_waived_at: "reportWaivedAt",
  version: "version",
  created_at: "createdAt",
  updated_at: "updatedAt",
};

/**
 * Row → DTO. JSON columns are decoded here so no caller has to remember which
 * fields are stored as text.
 * @param {object} row
 */
export function taskFromRow(row) {
  if (row === null || row === undefined) return null;
  const task = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    task[field] = row[column] === undefined ? null : row[column];
  }
  task.labels = normalizeLabels(row.labels ?? "[]");
  task.meta = decodeJsonObject(row.meta_json);
  return task;
}

/**
 * DTO → row, restricted to the columns present in `fields` (or all of them).
 * @param {object} task
 * @param {string[]} [fields] camelCase field names
 */
export function taskToRow(task, fields = Object.keys(CAMEL).map((c) => CAMEL[c])) {
  const row = {};
  const inverse = new Map(Object.entries(CAMEL).map(([column, field]) => [field, column]));
  for (const field of fields) {
    const column = inverse.get(field);
    if (column === undefined) {
      throw new DomainError("VALIDATION_FAILED", {
        message: `taskToRow: unknown field ${JSON.stringify(field)}`,
        details: { field },
      });
    }
    const value = task[field];
    if (Array.isArray(value) || (value !== null && typeof value === "object")) {
      row[column] = JSON.stringify(value);
    } else {
      row[column] = value === undefined ? null : value;
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// lifecycle predicates
// ---------------------------------------------------------------------------

/**
 * Has this task been finished long enough to archive? (I6 — the DB only checks
 * "terminal"; the waiting period is policy.)
 *
 * @param {object} task a Task DTO
 * @param {{now: string, days?: number}} options
 */
export function isArchivable(task, options) {
  const { now, days = ARCHIVE_AFTER_DAYS } = options;
  if (!isTerminalStatus(task.status)) {
    throw new DomainError("ARCHIVE_NOT_TERMINAL", {
      message: `only done/canceled tasks can be archived, this one is ${task.status}`,
      details: { taskId: task.id, status: task.status },
    });
  }
  if (task.archivedAt !== null) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "task is already archived",
      details: { taskId: task.id, archivedAt: task.archivedAt },
    });
  }
  const changedAt = task.statusChangedAt ?? task.updatedAt;
  const eligibleAt = new Date(new Date(changedAt).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  return { eligible: eligibleAt <= now, eligibleAt, days };
}

/**
 * Is a claim still live? A fresh heartbeat means somebody is working on it.
 * @param {object} task
 * @param {{now: string, freshMs?: number}} options
 */
export function isClaimFresh(task, options) {
  const { now, freshMs = HEARTBEAT_FRESH_MS } = options;
  if (task.heartbeatAt === null || task.heartbeatAt === undefined) return false;
  const age = new Date(now).getTime() - new Date(task.heartbeatAt).getTime();
  return age >= 0 && age <= freshMs;
}
