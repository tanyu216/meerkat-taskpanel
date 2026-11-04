/**
 * The board's closed vocabularies, as the browser needs them.
 *
 * This file is a **mirror** of the domain's definitions — `src/core/domain/enums.mjs`
 * (statuses, awaiting categories), `src/core/domain/priority.mjs` (priorities) and
 * `src/core/domain/acceptance-mode.mjs` (acceptance modes). `web/` cannot import
 * `src/` — a different build, and only `web/dist` crosses into the runtime image —
 * so the values are declared here and `test/web/enums.drift.test.mjs` holds the two
 * sides together. Add a value on one side and not the other and that test fails.
 *
 * Plain ESM with no Vue import, so the drift test can read it in Node.
 */

/**
 * The canonical statuses: the seven board stages, in board order, plus M1's
 * `awaiting` overlay appended after them.
 *
 * `awaiting` is **not** an eighth column. It is an attention state a card wears
 * while staying on its stage (`in_progress`), so it is deliberately *absent* from
 * `COLUMN_STATUSES` — the board still renders exactly seven columns. The
 * vocabulary is here because the move menu, the i18n labels and the waiting view
 * all need to know the word.
 */
export const STATUSES = Object.freeze([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
  "awaiting",
]);

/** M1 — running, but parked on a human. */
export const AWAITING = "awaiting";

/** The seven *stage* statuses — the board's columns, and `[data-card]`'s `data-status`. */
export const COLUMN_STATUSES = Object.freeze(STATUSES.filter((status) => status !== AWAITING));

/**
 * The finished statuses — the board's working set puts them **after** every
 * active card, newest completion first. Mirrors
 * `src/core/domain/status.mjs#TERMINAL_STATUSES`;
 * `test/web/enums.drift.test.mjs` keeps the two in lockstep.
 */
export const TERMINAL_STATUSES = Object.freeze(["done", "canceled"]);

/**
 * The statuses the board's supplementary active read asks for (the complement of
 * the terminal pair, derived so a new status joins it automatically). `awaiting`
 * is a non-terminal overlay and belongs on the board's active side.
 */
export const NON_TERMINAL_STATUSES = Object.freeze(
  STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status)),
);

/** The five priorities, most urgent first (contract `DOMAINS.PRIORITY`; `none` is the display band for an unset value). */
export const PRIORITIES = Object.freeze(["urgent", "high", "medium", "low", "none"]);

/** The awaiting categories the core writes, all of them questions to a human. */
export const AWAITING_CATEGORIES = Object.freeze(["E1", "E2", "E3", "E4", "E5"]);

/** The three values a card stores. */
export const ACCEPTANCE_MODES = Object.freeze(["off", "auto", "human"]);
