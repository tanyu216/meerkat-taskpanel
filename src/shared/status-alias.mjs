/**
 * `task-interface v1` ↔ core status aliases (F2 ruling).
 *
 * The card's seven states are canonical. v1 says `ready`/`failed`; those are
 * aliases that are resolved *at the boundary* (md import, CLI in M2) and never
 * stored. The raw legacy value is preserved in `meta_json.legacy_status` so an
 * export can put the original word back — round-tripping old cards must be
 * byte-stable.
 *
 * Pure: no `node:` specifiers.
 */

/** Legacy/v1 words → canonical status. */
export const LEGACY_TO_CORE_STATUS = Object.freeze({
  ready: "todo",
  failed: "canceled",
  // Spelling variants seen in hand-written cards. These are *not* v1 words; the
  // raw value still lands in `legacy_status` so the card round-trips.
  cancelled: "canceled",
  "in-review": "in_review",
  "in-progress": "in_progress",
});

/** Canonical status → the legacy word to restore on export, when one exists. */
export const CORE_TO_LEGACY_STATUS = Object.freeze({
  todo: "ready",
  canceled: "failed",
});

/**
 * Resolve a raw status string to its canonical value.
 *
 * @param {unknown} raw
 * @returns {{ok: true, status: string, legacyStatus: string|null}|{ok: false, raw: unknown}}
 *   `legacyStatus` is the original text when it is not already canonical, so
 *   the caller can persist it for a reversible export.
 */
export function resolveStatus(raw) {
  if (typeof raw !== "string") return { ok: false, raw };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, raw };
  const lowered = trimmed.toLowerCase();
  if (Object.hasOwn(LEGACY_TO_CORE_STATUS, lowered)) {
    return { ok: true, status: LEGACY_TO_CORE_STATUS[lowered], legacyStatus: trimmed };
  }
  if (isCanonical(lowered)) {
    return { ok: true, status: lowered, legacyStatus: lowered === trimmed ? null : trimmed };
  }
  return { ok: false, raw };
}

/**
 * The word to write back into a card's frontmatter for a canonical status.
 *
 * @param {string} status canonical status
 * @param {string|null} [legacyStatus] the value recorded at import time
 * @returns {string} `legacyStatus` wins so `import → export` is byte-stable
 */
export function exportStatusValue(status, legacyStatus = null) {
  if (typeof legacyStatus === "string" && legacyStatus.trim() !== "") return legacyStatus;
  return status;
}

/** @param {unknown} value */
export function isCanonical(value) {
  return (
    value === "backlog" ||
    value === "todo" ||
    value === "in_progress" ||
    value === "in_review" ||
    value === "blocked" ||
    value === "done" ||
    value === "canceled"
  );
}
