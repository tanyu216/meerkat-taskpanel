/**
 * The Report entity (ARCHITECTURE §4.5, card A6/A8).
 *
 * A report is the *evidence* a task was delivered: a conclusion, the acceptance
 * criteria checked one by one, and bounded proof anchors. It is deliberately
 * structured rather than free text — it is the object of review, and it has to
 * be queryable.
 *
 *   * one report per (task, delivery round) — F5
 *   * append-only; history is the delivery trail — A6
 *   * validated before it is stored, so an empty report cannot satisfy the gate — A8
 *   * bounded: ≤64 items per list, ≤64 KiB of JSON, longer payloads truncated
 *     with `truncated: true` instead of blowing up the row
 *
 * Pure: no `node:` specifiers, no clock.
 */

import {
  REPORT_MAX_BYTES,
  REPORT_MAX_CONCLUSION_CHARS,
  REPORT_MAX_ITEMS,
} from "../../shared/constants.mjs";
import { DomainError } from "../../shared/errors.mjs";
import { ACCEPTANCE_STATUSES, ACTOR_KINDS, EVIDENCE_KINDS } from "./enums.mjs";

/** UTF-8 byte length, computed without the node-only byteLength helper. */
const UTF8 = new TextEncoder();
function utf8Bytes(text) {
  return UTF8.encode(text).length;
}
import { assertIsoMillis } from "./task.mjs";

/** Acceptance statuses that oblige the author to say what is left. */
export const OPEN_ACCEPTANCE_STATUSES = Object.freeze(["partial", "not_met"]);

/** `/^[0-9a-f]{7,40}$/` — a git sha, abbreviated or full. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/** Longest string kept when a payload has to be shrunk. */
export const TRUNCATED_STRING_CHARS = 512;

/**
 * Who wrote a report row (0008). `delivery` is the gate's business — it is what
 * `writeReport`/`deliver` write, and its content is validated non-empty by
 * `normalizeReportCreate`. `import` is history: the md importer writes it (even
 * for a degraded narrative), and the gate never counts it.
 */
export const REPORT_ORIGINS = Object.freeze(["delivery", "import"]);

export const REPORT_COLUMNS = Object.freeze([
  "id",
  "task_id",
  "round",
  "seg",
  "session_id",
  "conclusion",
  "acceptance_json",
  "evidence_json",
  "leftovers",
  "author_kind",
  "author_id",
  "source_seq",
  "created_at",
  "origin",
]);

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * Check a report payload.
 *
 * Returns issues instead of throwing so a caller can report *every* problem at
 * once (an agent fixing a report should not need five round trips).
 *
 * @param {object} input
 * @param {{taskRound?: number, maxItems?: number, maxBytes?: number, allowEmpty?: boolean}} [context]
 *   `allowEmpty` relaxes *only* the "acceptance must have ≥1 criterion / evidence
 *   ≥1 anchor" requirement — the historical-import path (fix ②). It never
 *   relaxes a type or a size check, and the delivery gate never passes it.
 * @returns {{ok: boolean, issues: {path: string, message: string}[], report: object|null}}
 */
export function validateReport(input, context = {}) {
  const { maxItems = REPORT_MAX_ITEMS, maxBytes = REPORT_MAX_BYTES, allowEmpty = false } = context;
  /** @type {{path: string, message: string}[]} */
  const issues = [];

  if (input === null || typeof input !== "object") {
    return { ok: false, issues: [{ path: "", message: "report must be an object" }], report: null };
  }

  // conclusion -------------------------------------------------------------
  const conclusion = input.conclusion;
  if (typeof conclusion !== "string" || conclusion.trim() === "") {
    issues.push({ path: "conclusion", message: "conclusion must be a non-empty string" });
  } else if (conclusion.length > REPORT_MAX_CONCLUSION_CHARS) {
    issues.push({
      path: "conclusion",
      message: `conclusion must be at most ${REPORT_MAX_CONCLUSION_CHARS} characters`,
    });
  }

  // acceptance -------------------------------------------------------------
  const acceptance = input.acceptance;
  if (!Array.isArray(acceptance)) {
    issues.push({ path: "acceptance", message: "acceptance must be an array" });
  } else if (acceptance.length === 0) {
    if (!allowEmpty) issues.push({ path: "acceptance", message: "acceptance must list at least one criterion" });
  } else if (acceptance.length > maxItems) {
    issues.push({ path: "acceptance", message: `acceptance must have at most ${maxItems} items` });
  } else {
    acceptance.forEach((item, index) => {
      const at = `acceptance[${index}]`;
      if (item === null || typeof item !== "object") {
        issues.push({ path: at, message: "each acceptance item must be an object" });
        return;
      }
      if (typeof item.text !== "string" || item.text.trim() === "") {
        issues.push({ path: `${at}.text`, message: "text must be a non-empty string" });
      }
      if (!ACCEPTANCE_STATUSES.includes(item.status)) {
        issues.push({
          path: `${at}.status`,
          message: `status must be one of ${ACCEPTANCE_STATUSES.join(", ")}`,
        });
      }
      if (item.note !== undefined && typeof item.note !== "string") {
        issues.push({ path: `${at}.note`, message: "note must be a string" });
      }
    });
  }

  // evidence ---------------------------------------------------------------
  const evidence = input.evidence;
  if (!Array.isArray(evidence)) {
    issues.push({ path: "evidence", message: "evidence must be an array" });
  } else if (evidence.length === 0) {
    if (!allowEmpty) issues.push({ path: "evidence", message: "evidence must contain at least one anchor" });
  } else if (evidence.length > maxItems) {
    issues.push({ path: "evidence", message: `evidence must have at most ${maxItems} anchors` });
  } else {
    evidence.forEach((anchor, index) => {
      issues.push(...validateAnchor(anchor, `evidence[${index}]`));
    });
  }

  // leftovers --------------------------------------------------------------
  const openItems = Array.isArray(acceptance)
    ? acceptance.filter((item) => item !== null && typeof item === "object" && OPEN_ACCEPTANCE_STATUSES.includes(item.status))
    : [];
  const leftovers = input.leftovers;
  if (openItems.length > 0 && (typeof leftovers !== "string" || leftovers.trim() === "")) {
    issues.push({
      path: "leftovers",
      message: "leftovers must explain what is unfinished when any criterion is partial or not_met",
    });
  } else if (leftovers !== undefined && leftovers !== null && typeof leftovers !== "string") {
    issues.push({ path: "leftovers", message: "leftovers must be a string" });
  }

  // author -----------------------------------------------------------------
  const author = input.author;
  if (author === null || typeof author !== "object") {
    issues.push({ path: "author", message: "author is required" });
  } else {
    if (!ACTOR_KINDS.includes(author.kind)) {
      issues.push({ path: "author.kind", message: `kind must be one of ${ACTOR_KINDS.join(", ")}` });
    }
    if (typeof author.id !== "string" || author.id.trim() === "") {
      issues.push({ path: "author.id", message: "id must be a non-empty string" });
    }
  }

  // Size is *not* checked here: this function answers "is the content right?".
  // An oversized-but-valid report is handled by `normalizeReportCreate`, which
  // truncates it or raises REPORT_TOO_LARGE. Keeping the two apart means a
  // payload that is merely large is never reported as malformed.

  if (issues.length > 0) return { ok: false, issues, report: null };

  const report = {
    round: input.round ?? context.taskRound ?? null,
    seg: input.seg ?? null,
    sessionId: input.sessionId ?? null,
    conclusion: conclusion.trim(),
    acceptance,
    evidence,
    leftovers: typeof leftovers === "string" ? leftovers : null,
    authorKind: author.kind,
    authorId: author.id,
    sourceSeq: input.sourceSeq ?? null,
  };
  return { ok: true, issues: [], report };
}

/** @returns {{path: string, message: string}[]} */
function validateAnchor(anchor, at) {
  const issues = [];
  if (anchor === null || typeof anchor !== "object") {
    return [{ path: at, message: "each evidence anchor must be an object" }];
  }
  if (!EVIDENCE_KINDS.includes(anchor.kind)) {
    return [{ path: `${at}.kind`, message: `kind must be one of ${EVIDENCE_KINDS.join(", ")}` }];
  }
  switch (anchor.kind) {
    case "commit":
      if (typeof anchor.sha !== "string" || !COMMIT_SHA_PATTERN.test(anchor.sha)) {
        issues.push({ path: `${at}.sha`, message: "sha must be 7–40 lowercase hex characters" });
      }
      break;
    case "path":
      if (typeof anchor.path !== "string" || anchor.path.trim() === "") {
        issues.push({ path: `${at}.path`, message: "path must be a non-empty string" });
      }
      break;
    case "command":
      if (typeof anchor.cmd !== "string" || anchor.cmd.trim() === "") {
        issues.push({ path: `${at}.cmd`, message: "cmd must be a non-empty string" });
      }
      if (!Number.isInteger(anchor.exit_code)) {
        issues.push({ path: `${at}.exit_code`, message: "exit_code must be an integer" });
      }
      break;
    case "coverage":
      if (
        typeof anchor.lines !== "number" ||
        Number.isNaN(anchor.lines) ||
        anchor.lines < 0 ||
        anchor.lines > 100
      ) {
        issues.push({ path: `${at}.lines`, message: "lines must be a percentage between 0 and 100" });
      }
      if (anchor.scope !== undefined && typeof anchor.scope !== "string") {
        issues.push({ path: `${at}.scope`, message: "scope must be a string" });
      }
      break;
    default:
      issues.push({ path: `${at}.kind`, message: "unknown anchor kind" });
  }
  return issues;
}

/**
 * Shrink a payload that does not fit: keep the identifying half of each anchor
 * and drop prose. The result is still a valid report — just marked.
 *
 * @param {unknown[]} acceptance
 * @param {unknown[]} evidence
 * @param {{maxBytes?: number}} [options]
 * @returns {{acceptance: unknown[], evidence: unknown[], truncated: boolean, fits: boolean}}
 */
export function boundEvidence(acceptance, evidence, options = {}) {
  const { maxBytes = REPORT_MAX_BYTES } = options;
  const shrink = (value) => {
    if (typeof value !== "string") return value;
    return value.length > TRUNCATED_STRING_CHARS ? `${value.slice(0, TRUNCATED_STRING_CHARS)}…` : value;
  };

  const slimAcceptance = (Array.isArray(acceptance) ? acceptance : []).map((item) =>
    item !== null && typeof item === "object" ? { text: shrink(item.text), status: item.status } : item,
  );
  const slimEvidence = (Array.isArray(evidence) ? evidence : []).map((anchor) => {
    if (anchor === null || typeof anchor !== "object") return anchor;
    const copy = { ...anchor };
    for (const [key, value] of Object.entries(copy)) copy[key] = shrink(value);
    return copy;
  });

  const size = (a, e) =>
    utf8Bytes(JSON.stringify(a)) + utf8Bytes(JSON.stringify(e));

  if (size(slimAcceptance, slimEvidence) <= maxBytes) {
    return { acceptance: slimAcceptance, evidence: slimEvidence, truncated: true, fits: true };
  }

  // Still too big: keep the first anchors that fit, and record how many were kept.
  const keep = [];
  for (const anchor of slimEvidence) {
    const next = [...keep, anchor];
    if (size(slimAcceptance, next) > maxBytes) break;
    keep.push(anchor);
  }
  return {
    acceptance: slimAcceptance,
    evidence: keep,
    truncated: true,
    fits: keep.length > 0 && size(slimAcceptance, keep) <= maxBytes,
  };
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

/** @param {unknown[]|string} value */
export function acceptanceFromJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `evidence_json` is normally a JSON array. When the payload had to be
 * truncated it becomes `{truncated: true, items: [...], note}` — one shape for
 * the common case, one for the exception, and this reader hides the seam.
 *
 * @param {unknown} value
 * @returns {{items: unknown[], truncated: boolean, note: string|null}}
 */
export function evidenceFromJson(value) {
  if (Array.isArray(value)) return { items: value, truncated: false, note: null };
  if (value !== null && typeof value === "object") {
    return {
      items: Array.isArray(value.items) ? value.items : [],
      truncated: value.truncated === true,
      note: typeof value.note === "string" ? value.note : null,
    };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { items: [], truncated: false, note: null };
  }
  try {
    return evidenceFromJson(JSON.parse(value));
  } catch {
    return { items: [], truncated: false, note: null };
  }
}

/** @param {unknown} value */
export function serializeAcceptance(value) {
  return JSON.stringify(acceptanceFromJson(value));
}

/** @param {unknown} value @param {{truncated?: boolean, note?: string|null}} [options] */
export function serializeEvidence(value, options = {}) {
  const { items, truncated, note } = evidenceFromJson(value);
  const isTruncated = options.truncated ?? truncated;
  if (!isTruncated) return JSON.stringify(items);
  return JSON.stringify({
    truncated: true,
    items,
    note:
      options.note ??
      note ??
      `truncated to fit ${REPORT_MAX_BYTES} bytes; the full payload stays with the author`,
  });
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Validate and prepare a report for insertion.
 *
 * @param {object} input
 * @param {{taskRound: number, now: string, maxBytes?: number, maxItems?: number}} context
 * @throws {DomainError} REPORT_INVALID (with `details.issues`) / REPORT_ROUND_MISMATCH / REPORT_TOO_LARGE
 */
export function normalizeReportCreate(input, context) {
  const { taskRound, now, maxBytes = REPORT_MAX_BYTES, maxItems = REPORT_MAX_ITEMS } = context;
  assertIsoMillis(now, "now");

  if (input !== null && typeof input === "object" && input.round !== undefined && input.round !== null) {
    if (input.round !== taskRound) {
      throw new DomainError("REPORT_ROUND_MISMATCH", {
        message: `report round ${input.round} does not match the task's current delivery round ${taskRound}`,
        details: { field: "round", received: input.round, taskRound },
      });
    }
  }

  const result = validateReport(input, { taskRound, maxBytes, maxItems });
  if (!result.ok) {
    throw new DomainError("REPORT_INVALID", {
      message: `report rejected: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      details: { issues: result.issues, taskRound },
      hint: { fix: "every acceptance item needs a status, and at least one evidence anchor is required" },
    });
  }

  // Bound only when the payload is actually too big: an ordinary report must be
  // stored verbatim (a note that survives validation must survive storage).
  const plainAcceptanceJson = JSON.stringify(result.report.acceptance);
  const plainEvidenceJson = JSON.stringify(result.report.evidence);
  const oversized = utf8Bytes(plainAcceptanceJson) + utf8Bytes(plainEvidenceJson) > maxBytes;
  const { acceptance, evidence, truncated } = oversized
    ? boundEvidence(result.report.acceptance, result.report.evidence, { maxBytes })
    : { acceptance: result.report.acceptance, evidence: result.report.evidence, truncated: false };
  const acceptanceJson = JSON.stringify(acceptance);
  const evidenceJson = serializeEvidence(evidence, { truncated });
  // Truncation may not empty the evidence list: an evidence-free report must
  // never reach the gate, not even by accident of size.
  if (evidenceFromJson(evidenceJson).items.length === 0) {
    throw new DomainError("REPORT_TOO_LARGE", {
      message: `evidence cannot fit in ${maxBytes} bytes; trim the anchors and retry`,
      details: { maxBytes, anchors: result.report.evidence.length },
    });
  }
  if (utf8Bytes(acceptanceJson) + utf8Bytes(evidenceJson) > maxBytes) {
    throw new DomainError("REPORT_TOO_LARGE", {
      message: `report payload exceeds ${maxBytes} bytes even after truncation`,
      details: { maxBytes, acceptanceBytes: utf8Bytes(acceptanceJson) },
    });
  }

  return {
    ...result.report,
    round: taskRound,
    acceptance,
    acceptanceJson,
    evidence: evidenceFromJson(evidenceJson),
    evidenceJson,
    truncated,
    createdAt: now,
  };
}

/**
 * Validate and prepare a **historical** report for insertion, without the
 * delivery gate's "acceptance and evidence must be non-empty" requirement.
 *
 * The gate (`normalizeReportCreate`) governs the delivery/migration path and
 * stays strict — it is what stops an empty report from satisfying the gate. This
 * path only *reads* an old card, so a free-form narrative with no structured
 * acceptance list and no evidence anchor is stored as-is: acceptance `[]`,
 * evidence `[]`, nothing fabricated. Every *type* and *size* check still runs,
 * and the author and the round are validated exactly as the gate validates them.
 *
 * @param {object} input
 * @param {{taskRound: number, now: string, maxBytes?: number, maxItems?: number}} context
 * @throws {DomainError} REPORT_INVALID (with `details.issues`) / REPORT_ROUND_MISMATCH / REPORT_TOO_LARGE
 */
export function normalizeImportedReport(input, context) {
  const { taskRound, now, maxBytes = REPORT_MAX_BYTES, maxItems = REPORT_MAX_ITEMS } = context;
  assertIsoMillis(now, "now");

  if (input !== null && typeof input === "object" && input.round !== undefined && input.round !== null) {
    if (input.round !== taskRound) {
      throw new DomainError("REPORT_ROUND_MISMATCH", {
        message: `report round ${input.round} does not match the task's current delivery round ${taskRound}`,
        details: { field: "round", received: input.round, taskRound },
      });
    }
  }

  const result = validateReport(input, { taskRound, maxBytes, maxItems, allowEmpty: true });
  if (!result.ok) {
    throw new DomainError("REPORT_INVALID", {
      message: `imported report rejected: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      details: { issues: result.issues, taskRound },
    });
  }

  const acceptanceJson = JSON.stringify(result.report.acceptance);
  const evidenceJson = JSON.stringify(result.report.evidence);
  if (utf8Bytes(acceptanceJson) + utf8Bytes(evidenceJson) > maxBytes) {
    throw new DomainError("REPORT_TOO_LARGE", {
      message: `report payload exceeds ${maxBytes} bytes`,
      details: { maxBytes, acceptanceBytes: utf8Bytes(acceptanceJson) },
    });
  }

  return {
    ...result.report,
    round: taskRound,
    acceptance: result.report.acceptance,
    acceptanceJson,
    evidence: evidenceFromJson(evidenceJson),
    evidenceJson,
    truncated: false,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const CAMEL = {
  id: "id",
  task_id: "taskId",
  round: "round",
  seg: "seg",
  session_id: "sessionId",
  conclusion: "conclusion",
  acceptance_json: "acceptanceJson",
  evidence_json: "evidenceJson",
  leftovers: "leftovers",
  author_kind: "authorKind",
  author_id: "authorId",
  source_seq: "sourceSeq",
  created_at: "createdAt",
  origin: "origin",
};

/** @param {object} row */
export function reportFromRow(row) {
  if (row === null || row === undefined) return null;
  const report = {};
  for (const [column, field] of Object.entries(CAMEL)) {
    report[field] = row[column] === undefined ? null : row[column];
  }
  report.acceptance = acceptanceFromJson(row.acceptance_json);
  report.evidence = evidenceFromJson(row.evidence_json);
  return report;
}
