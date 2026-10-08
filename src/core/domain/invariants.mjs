/**
 * The six invariants, as a registry.
 *
 * Each one lives in the schema (`0002_invariants.sql` / `0003_reports.sql`) and
 * is re-stated here so a caller can act on it *before* opening a transaction,
 * and so the contract tests can name the thing they are checking. The reason
 * code is shared by both layers on purpose: an agent reading a 409 should not
 * have to know which layer refused it.
 *
 * Pure: no `node:` specifiers.
 */

import { DomainError } from "../../shared/errors.mjs";
import { isTerminalStatus } from "./status.mjs";

/** @type {Record<string, {id: string, name: string, reason: string, layer: string, statement: string}>} */
export const INVARIANTS = Object.freeze({
  I1: Object.freeze({
    id: "I1",
    name: "claim-is-atomic",
    reason: "CLAIM_LOST",
    layer: "sql+cas",
    statement: "one UPDATE … WHERE status='todo' AND version=? — at most one caller sees a changed row",
  }),
  I2: Object.freeze({
    id: "I2",
    name: "single-execution",
    reason: "EXECUTION_ACTIVE",
    layer: "policy",
    statement: "a fresh claim blocks other actors; in_progress without a claimer is corruption",
  }),
  I3: Object.freeze({
    id: "I3",
    name: "terminal-is-forever",
    reason: "TERMINAL_STATE",
    layer: "sql",
    statement: "done and canceled have no outgoing transitions",
  }),
  I4: Object.freeze({
    id: "I4",
    name: "comments-append-only",
    reason: "COMMENT_APPEND_ONLY",
    layer: "sql",
    statement: "comments are inserted and read, never updated or deleted",
  }),
  I5: Object.freeze({
    id: "I5",
    name: "decisions-are-on-the-record",
    reason: "COMMENT_APPEND_ONLY",
    layer: "sql+policy",
    statement: "a human decision is a comment of kind decision/confirm/change and shares I4's immutability",
  }),
  I6: Object.freeze({
    id: "I6",
    name: "archive-only-finished-work",
    reason: "ARCHIVE_NOT_TERMINAL",
    layer: "sql+policy",
    statement: "only done/canceled tasks may be archived, and archiving never changes status",
  }),
});

/** @returns {string[]} */
export function invariantIds() {
  return Object.keys(INVARIANTS);
}

/** @param {string} id */
export function invariantById(id) {
  const invariant = INVARIANTS[id];
  if (invariant === undefined) {
    throw new DomainError("VALIDATION_FAILED", { message: `unknown invariant ${JSON.stringify(id)}` });
  }
  return invariant;
}

/**
 * The JS half of I4: any attempt to rewrite history is refused here too, so a
 * caller gets the reason code without a round trip.
 *
 * @param {"update"|"delete"} operation
 * @param {{id?: string}} [target]
 */
export function assertCommentAppendOnly(operation, target = {}) {
  throw new DomainError("COMMENT_APPEND_ONLY", {
    message: `comments are append-only (${operation} refused)`,
    details: { operation, commentId: target.id ?? null },
    hint: { fix: "add a new comment of kind 'change' instead of editing an existing one" },
  });
}

/**
 * The JS half of I3.
 * @param {string} from @param {string} to
 */
export function assertNotTerminal(from, to) {
  if (isTerminalStatus(from)) {
    throw new DomainError("TERMINAL_STATE", {
      message: `${from} is terminal; it cannot move to ${to}`,
      details: { from, to },
    });
  }
  return true;
}
