/**
 * The loop's per-task process directory.
 *
 * A worker/reviewer subagent inherits the project session's cwd, so the loop can
 * name one **relative** location for everything a task produces:
 *
 *     .meerkat/<identifier>/card.md      the board's export (read-only)
 *     .meerkat/<identifier>/…            notes, logs, evidence, attachments
 *
 * The card brief is machine-generated: only `taskctl export md` and
 * `taskctl export watch` may write it.
 * This module is the single source of the path text, shared by the handoff
 * builders (foundation) and the loop's exporter (`src/orchestrator/card-file.mjs`),
 * so the brief a subagent is told to read is the file the loop actually writes.
 *
 * Pure: no Node builtins, no I/O.
 */

/** The hidden directory under the project's working directory. */
export const MEERKAT_PROCESS_DIR = ".meerkat";

/** The exported card file's name inside a task's directory. */
export const CARD_BRIEF_FILE = "card.md";

/**
 * Statuses at which a card brief stops changing.
 *
 * A **mirror** of `src/core/domain/status.mjs#TERMINAL_STATUSES`, because
 * `foundation` may not import `src/core` and the brief watch (CLI + hub) lives
 * below the core. `test/foundation/card-brief.test.mjs` asserts the two sets
 * stay equal, so a new terminal status cannot silently leave a watch alive.
 */
export const TERMINAL_CARD_STATUSES = Object.freeze(["done", "canceled"]);

/**
 * An identifier as one safe path segment.
 *
 * Board identifiers are already `PREFIX-N`, but this function is also fed from
 * the handoff text: a `/` or a `..` must never escape the task directory.
 * Everything outside the conservative set becomes `_`; an identifier that would
 * name the directory itself (empty, `.`, `..`) becomes `_` too.
 *
 * @param {unknown} identifier
 * @returns {string}
 */
export function taskDirName(identifier) {
  const raw = String(identifier ?? "").trim();
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === "" || safe === "." || safe === "..") return "_";
  return safe;
}

/**
 * The task's process directory, relative to the project working directory.
 *
 * @param {unknown} identifier
 * @returns {string}
 */
export function cardDirRel(identifier) {
  return `${MEERKAT_PROCESS_DIR}/${taskDirName(identifier)}`;
}

/**
 * The card brief, relative to the project working directory.
 *
 * @param {unknown} identifier
 * @returns {string}
 */
export function cardFileRel(identifier) {
  return `${cardDirRel(identifier)}/${CARD_BRIEF_FILE}`;
}
