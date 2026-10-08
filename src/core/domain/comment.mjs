/**
 * Comment DTO and validation.
 *
 * Comments are **append-only** (I4): there is no update path here and the
 * database refuses UPDATE/DELETE outright. A correction is a new comment of
 * kind `change` — which is also how a human decision is superseded, so the
 * history stays readable (ARCHITECTURE §4.5).
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { ACTOR_KINDS, COMMENT_KINDS } from "./enums.mjs";
import { assertIsoMillis } from "./task.mjs";

/** Comment kinds that record a human decision (I5). */
export const DECISION_KINDS = Object.freeze(["decision", "confirm", "change"]);

export const COMMENT_COLUMNS = Object.freeze([
  "id",
  "task_id",
  "body",
  "kind",
  "author_kind",
  "author_id",
  "agent_session",
  "refs_json",
  "source_seq",
  "version",
  "created_at",
]);

/** @param {unknown} value */
export function isCommentKind(value) {
  return COMMENT_KINDS.includes(/** @type {string} */ (value));
}

/** A ref is a task identifier, a commit sha, a path — kept as strings. */
export function normalizeRefs(value) {
  if (value === null || value === undefined || value === "") return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [value];
    }
  }
  if (!Array.isArray(parsed)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "refs must be an array of strings",
      details: { field: "refs" },
    });
  }
  return parsed.map((ref) => String(ref).trim()).filter((ref) => ref !== "");
}

/**
 * @param {object} input
 * @param {{now: string, id: string, taskId: string, sourceSeq?: number|null}} context
 */
export function normalizeCommentCreate(input, context) {
  if (input === null || typeof input !== "object") {
    throw new DomainError("VALIDATION_FAILED", { message: "comment payload must be an object" });
  }
  const { now, id, taskId } = context;
  assertIsoMillis(now, "now");

  if (typeof input.body !== "string" || input.body.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "comment body must be a non-empty string",
      details: { field: "body" },
    });
  }
  const kind = input.kind ?? "note";
  if (!isCommentKind(kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `unknown comment kind ${JSON.stringify(kind)}`,
      details: { field: "kind", received: kind, allowed: COMMENT_KINDS },
    });
  }
  const author = input.author ?? {};
  if (!ACTOR_KINDS.includes(author.kind)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: `author.kind must be one of ${ACTOR_KINDS.join(", ")}`,
      details: { field: "author.kind", received: author.kind, allowed: ACTOR_KINDS },
    });
  }
  if (typeof author.id !== "string" || author.id.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "author.id must be a non-empty string",
      details: { field: "author.id" },
    });
  }

  return {
    id,
    taskId,
    body: input.body,
    kind,
    authorKind: author.kind,
    authorId: author.id,
    agentSession: input.agentSession ?? null,
    refs: normalizeRefs(input.refs),
    sourceSeq: context.sourceSeq ?? input.sourceSeq ?? null,
    version: 1,
    createdAt: now,
  };
}

/** Is this the kind of comment a human uses to put something on the record? */
export function isDecisionComment(comment) {
  return comment.authorKind === "human" && DECISION_KINDS.includes(comment.kind);
}

const CAMEL = {
  id: "id",
  task_id: "taskId",
  body: "body",
  kind: "kind",
  author_kind: "authorKind",
  author_id: "authorId",
  agent_session: "agentSession",
  refs_json: "refs",
  source_seq: "sourceSeq",
  version: "version",
  created_at: "createdAt",
};

/** @param {object} row */
export function commentFromRow(row) {
  if (row === null || row === undefined) return null;
  const comment = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    comment[field] = row[column] === undefined ? null : row[column];
  }
  comment.refs = normalizeRefs(row.refs_json ?? "[]");
  return comment;
}

/** @param {object} comment */
export function commentToRow(comment) {
  const inverse = new Map(Object.entries(CAMEL).map(([column, field]) => [field, column]));
  const row = {};
  for (const [field, value] of Object.entries(comment)) {
    const column = inverse.get(field);
    if (column === undefined) continue;
    row[column] = Array.isArray(value) ? JSON.stringify(value) : value;
  }
  return row;
}
