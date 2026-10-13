/**
 * The SLA patrol — `PROTOCOL §⑮`'s wait rows as a *pure* decision.
 *
 * The loop's patrol used to watch exactly one row of the SLA table: an
 * `in_progress` card whose heartbeat went stale. That is one of six rows, and
 * the two mechanisms that drive the same board (this loop and the openclaw-side
 * cron) were both blind to the other five — a card parked on the leader, a
 * delivery nobody ever accepted, an unanswered confirmation gate, a defect
 * whose fix card was never created. This module is the loop's half of the fix,
 * written against the shared contract
 * (`team/guides/sla-inspection-contract.md`, "C1"): the **same alert tuple**,
 * the **same tier ladder**, the **same de-duplication key** and the **same
 * working-hours basis** as the peer mechanism, so the two can never label one
 * card differently.
 *
 * Three properties are load-bearing and each has a test:
 *
 *   * **notify-only.** Every alert carries `target: "leader"` and there is no
 *     code path here that writes a card. The releasability hint says "this card
 *     *looks* releasable"; releasing it stays the leader's act (`§⑦`).
 *   * **zero-cost idle.** Nothing crossing a tier produces no alert at all, so
 *     a quiet board costs no notification and no model turn.
 *   * **fail-safe, never false-green.** An unreadable origin alerts (at `warn`,
 *     with no threshold) rather than staying quiet, and an undecidable
 *     open/closed predicate is treated as **open**.
 *
 * Thresholds are *not* invented here: `SLA_ROWS` carries `PROTOCOL §⑮`'s
 * published limits next to a reference string, which is the runtime mapping
 * table the contract requires (§2, hook H6). `L` = the row's normal limit, `F` =
 * its further timeout, `P` = this mechanism's own period. `warn` is `L − P`
 * (fixed at 0 when `P ≥ L`) — the contract's adopted option A, which invents no
 * new SLA number.
 *
 * Pure: no `node:` specifiers, no clock of its own (`now` is always an input),
 * no filesystem. `scripts/supervisor.mjs` owns the I/O half.
 */

import { CLAIM_STALE_ANY_MS, CLAIM_STALE_SAME_MS } from "./constants.mjs";

/** This mechanism's identity in the shared tuple (§4 #21). */
export const MECHANISM = "loop-patrol";

/**
 * The measurement basis (§6.4): a **fixed civil window in Asia/Shanghai**,
 * accumulated, off-hours rolled over. Asia/Shanghai is UTC+8 all year (no DST),
 * so the conversion is exact integer arithmetic and needs no timezone database —
 * and a host in another zone still measures the same `T`, which is the point.
 */
export const WORKING_WINDOW = Object.freeze({
  zone: "Asia/Shanghai",
  offsetMinutes: 480,
  startHour: 9,
  endHour: 23,
});

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Iteration guard: ten years of days is far beyond any admissible wait. */
const MAX_DAYS = 3_660;

/** Statuses a card never leaves — used by the releasability hint. */
export const TERMINAL_STATUSES = Object.freeze(["done", "canceled"]);

/** `blocked_reason` values the contract gives **no** `§⑮` row (gap G-3). */
const VISIBILITY_ONLY_BLOCK_REASONS = new Set(["dependency", "external", "resource"]);

/**
 * The `PROTOCOL §⑮` runtime mapping table.
 *
 * One entry per published row **plus** the two the contract adds or preserves:
 * `inspector_liveness` is carried for completeness even though this mechanism
 * does not emit it (the peer's marker does not exist on this board yet), and
 * `heartbeat_stale` is carried because the loop already covers it — through the
 * *existing* stale alert, which is a published consumer contract and must not
 * be re-shaped (§10.4). `coveredBy` says which code path emits each row, so
 * "is row X covered?" is answered by the table rather than by reading around.
 *
 * Values are `PROTOCOL §⑮`'s, referenced — never re-derived, never invented.
 */
export const SLA_ROWS = Object.freeze({
  blocked_clarification: Object.freeze({
    ref: "PROTOCOL §⑮ · blocked awaiting the leader's clarification",
    thresholdRef: "PROTOCOL §⑮ · blocked awaiting the leader's clarification · Normal limit",
    limitMin: 120,
    furtherMin: 1440,
    warnLead: true,
    origin: "blocked_at",
    coveredBy: "sla-patrol",
    action: "the leader must clarify / revise / reassign this card",
  }),
  confirmation_gate: Object.freeze({
    ref: "PROTOCOL §⑮ · Confirmation gate awaiting review (§⑭)",
    thresholdRef: "PROTOCOL §⑮ · Confirmation gate awaiting review (§⑭) · Normal limit",
    limitMin: 240,
    furtherMin: 1440,
    warnLead: true,
    origin: "gate_at",
    coveredBy: "sla-patrol",
    action: "the leader must review the confirmation request (§⑭)",
  }),
  defect_card_creation: Object.freeze({
    ref: "PROTOCOL §⑮ · Defect fix card creation (§⑨)",
    thresholdRef: "PROTOCOL §⑮ · Defect fix card creation (§⑨) · Normal limit",
    limitMin: 1440,
    furtherMin: 2880,
    warnLead: true,
    origin: "trail_event",
    coveredBy: "sla-patrol",
    action: "the leader must create the defect fix card and dispatch it (§⑨)",
  }),
  acceptance_card_creation: Object.freeze({
    ref: "PROTOCOL §⑮ · Product/UX acceptance queued (§⑨.1)",
    thresholdRef: "PROTOCOL §⑮ · Product/UX acceptance queued (§⑨.1) · Normal limit",
    limitMin: 1440,
    furtherMin: 2880,
    warnLead: true,
    origin: "status_changed_at",
    coveredBy: "sla-patrol",
    action: "the leader must create the acceptance review card and dispatch it (§⑨.1)",
  }),
  heartbeat_stale: Object.freeze({
    ref: "PROTOCOL §⑮ · Worker heartbeat stale (§①)",
    thresholdRef: "PROTOCOL §⑮ · Worker heartbeat stale (§①) · Normal limit",
    limitMin: CLAIM_STALE_SAME_MS / MS_PER_MINUTE,
    furtherMin: CLAIM_STALE_ANY_MS / MS_PER_MINUTE,
    warnLead: true,
    origin: "heartbeat_at",
    // The legacy `stale` / `heartbeat-unreadable` alerts already cover this row,
    // byte for byte. Re-emitting it as a tuple would double-notify one
    // condition, so the coverage stays where the published consumer is.
    coveredBy: "legacy-stale-alert",
    action: "the same assignee may re-claim; past the further bound any agent may claim and report",
  }),
  leader_stalled: Object.freeze({
    ref: "PROTOCOL §⑮ · Leader patrol stalled",
    thresholdRef: "PROTOCOL §⑮ · Leader patrol stalled · Normal limit",
    limitMin: 60,
    furtherMin: 360,
    // §5.2 rule 5: this row's published bound is already a "no action for"
    // bound, so the `−P` lead is deliberately NOT applied and there is no
    // `overdue` state — only `warn` (at `L`) and `escalate` (at `F`).
    warnLead: false,
    origin: "trail_event",
    coveredBy: "sla-patrol",
    action: "the leader should be reminded that no leader action is observable on the board",
  }),
  inspector_liveness: Object.freeze({
    ref: "shared contract §5.3 · inspector liveness (not a PROTOCOL §⑮ row)",
    thresholdRef: null,
    limitMin: null,
    furtherMin: null,
    warnLead: false,
    origin: "unverifiable",
    // Not emitted by this mechanism yet: it needs the peer's last-successful-run
    // marker, and the peer inspector's marker does not exist on this board.
    coveredBy: "not-implemented",
    action: "tell the leader that one of the two inspectors is not running",
  }),
});

/** A `PROTOCOL §⑮`-stamped constant, for the drift check and for error messages. */
export function slaRowRef(row) {
  return SLA_ROWS[row]?.ref ?? null;
}

/** The runtime limit for a row, in working minutes (`null` when the row has none). */
export function slaLimitMin(row) {
  const spec = SLA_ROWS[row];
  return spec === undefined || spec.limitMin === null ? null : spec.limitMin;
}

/**
 * The working-minute point at which a row's `warn` fires: `L − P`, clamped at 0,
 * or `L` itself for the one row exempt from the lead (§5.2).
 *
 * @param {string} row
 * @param {number} periodSeconds this mechanism's own period
 * @returns {number|null}
 */
export function warnLeadMinutes(row, periodSeconds) {
  const spec = SLA_ROWS[row];
  if (spec === undefined || spec.limitMin === null) return null;
  if (!spec.warnLead) return spec.limitMin;
  const periodMin = Number.isFinite(periodSeconds) && periodSeconds > 0 ? periodSeconds / 60 : 0;
  return Math.max(0, spec.limitMin - periodMin);
}

/** Default cap on cards read in one patrol pass. */
export const DEFAULT_BOARD_LIMIT = 500;
/** Default cap on trails read in one patrol pass (each is one provider read). */
export const DEFAULT_TRAIL_LIMIT = 200;

/**
 * Which cards need their comment trail read.
 *
 * Three rows read the process trail (`confirmation_gate`, `defect_card_creation`
 * and the releasability hint on `blocked_clarification`), and a trail is one
 * provider read per card — so the pass must not fetch a trail it cannot use. The
 * filter is *exact* rather than approximate: a trail is read only once the card
 * is old enough for a trail-derived row to be able to fire, i.e. once its
 * relevant elapsed time has reached that row's `warn` lead. Below the lead no
 * alert could be emitted and therefore no trail-derived value is ever needed.
 *
 * A card whose `status_changed_at` cannot be read is fetched anyway: an
 * unreadable origin must not be able to *suppress* a row (§9.3).
 *
 * @param {object[]} cards
 * @param {{now?: string|number, periodSeconds?: number}} input
 * @returns {string[]} card identifiers whose trail the pass should read
 */
export function trailReadCandidates(cards, input = {}) {
  const now = input.now;
  const periodSeconds = input.periodSeconds;
  const blockedLead = warnLeadMinutes("blocked_clarification", periodSeconds);
  const gateLead = warnLeadMinutes("confirmation_gate", periodSeconds);
  const defectLead = warnLeadMinutes("defect_card_creation", periodSeconds);
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const id = String(card?.identifier ?? card?.id ?? "");
    if (id === "") continue;
    // A finished card owes no defect fix card on this board (`§⑨` step 1 parks
    // the origin card in `blocked` / `canceled`), so it is not read at all —
    // otherwise every archived card would be fetched on every pass forever.
    if (card?.status === "done") continue;
    const statusElapsed = elapsedWorkingMinutes(card?.status_changed_at, now);
    const blockedElapsed =
      card?.status === "blocked"
        ? elapsedWorkingMinutes(card?.blocked_at ?? card?.status_changed_at, now)
        : null;
    const needed =
      statusElapsed === null ||
      (statusElapsed !== null && gateLead !== null && statusElapsed >= gateLead) ||
      (statusElapsed !== null && defectLead !== null && statusElapsed >= defectLead) ||
      (blockedElapsed !== null && blockedLead !== null && blockedElapsed >= blockedLead);
    if (needed) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Working hours (§6.4)
// ---------------------------------------------------------------------------

function instant(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The wait `T` in **working-hours minutes** between two instants: only time
 * inside the Asia/Shanghai 09:00–23:00 window counts, so the clock stops
 * overnight and a card blocked at the end of a working day cannot go "overdue"
 * during the off-hours. The window rolls over rather than resetting, so a wait
 * that spans a weekend / an outage is still measured honestly.
 *
 * @param {string|number|null} from the origin instant
 * @param {string|number|null} to the observation instant
 * @returns {number|null} minutes, or `null` when either instant is unreadable
 *   (the caller must then treat the card as unverifiable, never as fresh)
 */
export function elapsedWorkingMinutes(from, to) {
  const start = instant(from);
  const end = instant(to);
  if (start === null || end === null) return null;
  if (end <= start) return 0;

  const shift = WORKING_WINDOW.offsetMinutes * MS_PER_MINUTE;
  const localStart = start + shift;
  const localEnd = end + shift;
  const dayStart = WORKING_WINDOW.startHour * MS_PER_HOUR;
  const dayEnd = WORKING_WINDOW.endHour * MS_PER_HOUR;

  const firstDay = Math.floor(localStart / MS_PER_DAY);
  const lastDay = Math.min(Math.floor(localEnd / MS_PER_DAY), firstDay + MAX_DAYS);
  let total = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const base = day * MS_PER_DAY;
    const low = Math.max(localStart, base + dayStart);
    const high = Math.min(localEnd, base + dayEnd);
    if (high > low) total += high - low;
  }
  return total / MS_PER_MINUTE;
}

/**
 * The inverse projection, for the tuple's **display-only** `due_at`. It answers
 * "which instant is `minutes` working minutes after `from`" — and nothing
 * decides green from it (§4 #13): the verdict is always
 * `elapsed_working_min ≥ threshold_min`.
 *
 * @param {string|number|null} from
 * @param {number|null} minutes
 * @returns {string|null} an ISO-8601 UTC instant, or `null` when unprojectable
 */
export function addWorkingMinutes(from, minutes) {
  const start = instant(from);
  if (start === null || !Number.isFinite(minutes) || minutes < 0) return null;
  const shift = WORKING_WINDOW.offsetMinutes * MS_PER_MINUTE;
  const dayStart = WORKING_WINDOW.startHour * MS_PER_HOUR;
  const dayEnd = WORKING_WINDOW.endHour * MS_PER_HOUR;

  let remaining = minutes * MS_PER_MINUTE;
  let cursor = start + shift;
  for (let guard = 0; remaining > 0 && guard <= MAX_DAYS + 2; guard++) {
    const base = Math.floor(cursor / MS_PER_DAY) * MS_PER_DAY;
    if (cursor < base + dayStart) cursor = base + dayStart;
    else if (cursor >= base + dayEnd) {
      cursor = base + MS_PER_DAY + dayStart;
      continue;
    }
    const available = base + dayEnd - cursor;
    if (remaining <= available) {
      cursor += remaining;
      remaining = 0;
    } else {
      remaining -= available;
      cursor = base + MS_PER_DAY + dayStart;
    }
  }
  if (remaining > 0) return null;
  return new Date(cursor - shift).toISOString();
}

// ---------------------------------------------------------------------------
// The tier ladder (§5.2)
// ---------------------------------------------------------------------------

/**
 * The highest tier an elapsed wait has crossed, or `null` when it is still
 * inside its lead. One definition, shared by both mechanisms:
 *
 *   * `warn`     ⇔ `T ≥ L − P` (clamped at 0) — "到点提醒", **no breach**
 *   * `overdue`  ⇔ `T ≥ L`
 *   * `escalate` ⇔ `T ≥ F`, where `§⑮` publishes a further bound
 *
 * `leader_stalled` is exempt from the `−P` lead and never reports `overdue`
 * (§5.2 rule 5).
 *
 * @param {string} row a key of `SLA_ROWS`
 * @param {number|null} elapsedMin
 * @param {number} periodMin this mechanism's own period
 * @returns {"warn"|"overdue"|"escalate"|null}
 */
export function tierFor(row, elapsedMin, periodMin) {
  const spec = SLA_ROWS[row];
  if (spec === undefined || spec.limitMin === null) return null;
  if (!Number.isFinite(elapsedMin) || elapsedMin < 0) return null;
  const period = Number.isFinite(periodMin) && periodMin > 0 ? periodMin : 0;
  if (spec.furtherMin !== null && elapsedMin >= spec.furtherMin) return "escalate";
  if (elapsedMin >= spec.limitMin) return spec.warnLead ? "overdue" : "warn";
  if (!spec.warnLead) return null;
  const lead = Math.max(0, spec.limitMin - period);
  return elapsedMin >= lead ? "warn" : null;
}

/** `<card_id>#<sla_row>#<severity>` — deterministic and reproducible by either mechanism. */
export function alertIdFor(cardId, row, severity) {
  return `${cardId}#${row}#${severity}`;
}

/** `<alert_id>@<measure_start_at>` — the idempotency key. A tier promotion is a new key. */
export function dedupKeyFor(alertId, measureStartAt) {
  return `${alertId}@${measureStartAt}`;
}

// ---------------------------------------------------------------------------
// Reading a card's trail
// ---------------------------------------------------------------------------

function commentsOf(trail) {
  return Array.isArray(trail) ? trail : [];
}

function commentAt(comment) {
  return instant(comment?.created_at);
}

/** The proposed stable `§⑭` marker for a confirmation request (gap G-5). */
const CONFIRM_MARKER = /\[confirm-request\]/i;
const MD_PATH = /\.(md|markdown)\b/i;
const CONFIRM_WORD = /(确认|confirm)/i;
const OPEN_ITEMS = /(open item|open question|待决|未决|决策|decision)/i;

/**
 * Does this comment look like the `§⑭` "send back to the leader" request — a
 * doc/plan path, a confirmation ask, and the open items? The contract's priority
 * 2, used **only** because the stable marker is not standard yet; the marker
 * alone (priority 1) is exact, and matching this shape sets `confidence: "low"`.
 */
export function looksLikeConfirmRequest(body) {
  const text = String(body ?? "");
  return MD_PATH.test(text) && CONFIRM_WORD.test(text) && OPEN_ITEMS.test(text);
}

/**
 * The latest confirmation request on a card, or `null` when there is none.
 *
 * Priority order (§6.3-A): an explicit gate-start field (forward-compatible, no
 * such field exists today), then the `[confirm-request]` marker, then the
 * request shape. **No detectable request means no trigger** — the row is about
 * an *unanswered request*, not about a card's age, and inventing a gate would
 * alert on every card on the board.
 *
 * @returns {{at: string|number, source: string, confidence: "high"|"low"}|null}
 */
export function findConfirmRequest(card, trail) {
  const explicit = card?.meta?.gate_at;
  if (instant(explicit) !== null) return { at: explicit, source: "frontmatter", confidence: "high" };

  let marker = null;
  let shaped = null;
  for (const comment of commentsOf(trail)) {
    const at = commentAt(comment);
    if (at === null) continue;
    if (CONFIRM_MARKER.test(String(comment?.body ?? ""))) marker = comment;
    else if (looksLikeConfirmRequest(comment?.body)) shaped = comment;
  }
  const found = marker ?? shaped;
  if (found === null) return null;
  return {
    at: found.created_at,
    source: "comments",
    confidence: marker === null ? "low" : "high",
  };
}

/** Has the gate been answered since `since`? A later `kind=confirm` entry closes it. */
export function confirmAnsweredAfter(trail, since) {
  const bound = instant(since);
  if (bound === null) return false;
  return commentsOf(trail).some((comment) => comment?.kind === "confirm" && (commentAt(comment) ?? -Infinity) > bound);
}

/** The earliest `kind=defect` trail entry's timestamp, or `null`. */
export function firstDefectEntryAt(trail) {
  let earliest = null;
  for (const comment of commentsOf(trail)) {
    if (comment?.kind !== "defect") continue;
    const at = commentAt(comment);
    if (at === null) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/** A trail entry that answers a blocked card (a newer `change`/`confirm` entry). */
export function trailAnsweredAfter(trail, since) {
  const bound = instant(since);
  if (bound === null) return false;
  return commentsOf(trail).some((comment) => {
    if (comment?.kind !== "change" && comment?.kind !== "confirm") return false;
    return (commentAt(comment) ?? -Infinity) > bound;
  });
}

// ---------------------------------------------------------------------------
// Reading the card's own fields
// ---------------------------------------------------------------------------

/**
 * The card's `blocked_reason`, or `null`.
 *
 * Read from the provider's known key when it exists and from the card's meta
 * otherwise — so this keeps working whichever shape the field lands in. An
 * **absent** field behaves exactly as `clarify` (§7.3 item 2): absence preserves
 * today's semantics and never silences the alert.
 */
export function blockedReasonOf(card) {
  const raw = card?.blocked_reason ?? card?.meta?.blocked_reason ?? null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Every id a card of this board is known by (its identifier and its row id). */
function idsOf(card) {
  const out = [];
  if (typeof card?.identifier === "string" && card.identifier !== "") out.push(card.identifier);
  if (typeof card?.id === "string" && card.id !== "") out.push(card.id);
  return out;
}

function sameRef(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.trim();
  const right = b.trim();
  if (left === "" || right === "") return false;
  return left === right;
}

function referencesAny(ref, ids) {
  if (Array.isArray(ref)) return ref.some((entry) => referencesAny(entry, ids));
  return ids.some((id) => sameRef(ref, id));
}

/** Does this card carry the `§15` bug-label convention (`category:bug`)? */
function hasBugLabel(card) {
  const labels = Array.isArray(card?.labels) ? card.labels : [];
  return labels.some((label) => /(^|:)bug$/i.test(String(label).trim()));
}

/**
 * A fix card that references the origin card. Both halves of the `§⑨`
 * convention are required — the `category:bug` label **and** a structural
 * reference back — because either alone is guesswork.
 */
function hasFixCardFor(cards, card) {
  const ids = idsOf(card);
  return cards.some((other) => {
    if (other === card) return false;
    if (!hasBugLabel(other)) return false;
    const meta = other?.meta ?? {};
    return (
      referencesAny(meta.fixes, ids) ||
      referencesAny(meta.review_of, ids) ||
      referencesAny(meta.origin, ids) ||
      referencesAny(meta.parent, ids)
    );
  });
}

/** `depends_on` entries as written on the card (a list, or a separated string). */
function dependsOnOf(card) {
  const raw = card?.meta?.depends_on ?? card?.depends_on ?? null;
  if (Array.isArray(raw)) return raw.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof raw !== "string") return [];
  return raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

function evidenceOf(card, thresholdRef, openPredicate) {
  return {
    status: card?.status ?? null,
    status_changed_at: card?.status_changed_at ?? null,
    // The loop's board carries no `## Sessions` section: the comparable
    // "is anything actually working this card" signal is an execution claim.
    has_sessions: Boolean(card?.claimed_by ?? card?.agent_session),
    // The board holds no project directory (O3), so this mechanism has no
    // workspace to attest. `null` is the honest value; a boolean would be a
    // claim the loop cannot make.
    has_workspace: null,
    threshold_ref: thresholdRef,
    open_predicate: openPredicate,
  };
}

/**
 * The `blocked awaiting the leader's clarification` row.
 *
 * Origin = `blocked_at` (an exact frontmatter field, `confidence: "high"`), with
 * `status_changed_at` as the fallback the contract admits (it can only make the
 * wait look *older*, i.e. over-alert). A card whose timestamps cannot be read at
 * all still alerts, with no threshold — unreadable is not green.
 */
function blockedDetection(card, trail, context) {
  if (card?.status !== "blocked") return null;
  const reason = blockedReasonOf(card);
  const visibilityOnly = reason !== null && VISIBILITY_ONLY_BLOCK_REASONS.has(reason);

  const blockedAt = instant(card?.blocked_at) === null ? null : card.blocked_at;
  const changedAt = instant(card?.status_changed_at) === null ? null : card.status_changed_at;
  const origin = blockedAt !== null
    ? { kind: "blocked_at", at: blockedAt, source: "frontmatter", confidence: "high" }
    : changedAt !== null
      ? { kind: "status_changed_at", at: changedAt, source: "frontmatter", confidence: "low" }
      : { kind: "unverifiable", at: null, source: "missing", confidence: "low" };

  // The releasability hint (§7.4) — a *hint*, never an action. Only two bases
  // are decidable on this board today; `assignee_changed` needs an assignee
  // history the read surface does not carry, so it stays `null` rather than
  // being guessed at.
  let releasable = false;
  let releasableBasis = null;
  if (reason === null || reason === "clarify" || reason === "decision") {
    if (blockedAt !== null && trailAnsweredAfter(trail, blockedAt)) {
      releasable = true;
      releasableBasis = "clarification_trail_after_block";
    }
  } else if (reason === "dependency") {
    const deps = dependsOnOf(card);
    if (deps.length > 0 && deps.every((id) => context.terminalRefs.has(id))) {
      releasable = true;
      releasableBasis = "deps_satisfied";
    }
  }

  const spec = SLA_ROWS.blocked_clarification;
  // `dependency` / `external` / `resource` have **no** `§⑮` row (gap G-3), so
  // they get visibility without a due point rather than an invented limit.
  const noThreshold = visibilityOnly || origin.kind === "unverifiable";
  const openPredicate = origin.kind === "unverifiable" ? "unverifiable" : "blocked";
  return {
    row: "blocked_clarification",
    origin,
    thresholdMin: noThreshold ? null : spec.limitMin,
    thresholdRef: noThreshold ? null : spec.thresholdRef,
    visibilityOnly,
    releasable,
    releasableBasis,
    blockedReason: reason,
    openPredicate,
    action: visibilityOnly
      ? `${spec.action} — blocked on ${reason}; no PROTOCOL §⑮ limit applies, visibility only`
      : spec.action,
    evidence: evidenceOf(card, noThreshold ? null : spec.thresholdRef, openPredicate),
  };
}

/**
 * The `confirmation gate awaiting review` row (§⑭).
 *
 * Trigger and origin both come from the gate request, not from the card's age:
 * a card with no detectable request has no gate, and the row stays silent. An
 * unreadable request timestamp falls back to `status_changed_at` with
 * `confidence: "low"` — the admissible direction again.
 */
function confirmDetection(card, trail) {
  const request = findConfirmRequest(card, trail);
  if (request === null) return null;
  if (confirmAnsweredAfter(trail, request.at)) return null;

  const spec = SLA_ROWS.confirmation_gate;
  const at = instant(request.at) === null ? null : request.at;
  const origin = at !== null
    ? { kind: "gate_at", at, source: request.source, confidence: request.confidence }
    : instant(card?.status_changed_at) === null
      ? { kind: "unverifiable", at: null, source: "missing", confidence: "low" }
      : { kind: "gate_at", at: card.status_changed_at, source: "frontmatter", confidence: "low" };

  return {
    row: "confirmation_gate",
    origin,
    thresholdMin: origin.kind === "unverifiable" ? null : spec.limitMin,
    thresholdRef: spec.thresholdRef,
    visibilityOnly: false,
    releasable: false,
    releasableBasis: null,
    blockedReason: blockedReasonOf(card),
    openPredicate: "gate_open",
    action: spec.action,
    evidence: evidenceOf(card, spec.thresholdRef, "gate_open"),
  };
}

/**
 * The `defect fix card creation` row (§⑨).
 *
 * Trigger: a defect is recorded on the card (a `kind=defect` trail entry — the
 * defect ticket itself lives in the Report, which carries no timestamp, so the
 * trail is the observable). Origin: the earlier of that entry and the card's
 * entry into `blocked` / `canceled`. The open predicate needs a fix card that
 * both carries `category:bug` **and** references this card; when that cannot be
 * decided the wait counts as **open** (§9.3 — an unknown must not become
 * silence).
 */
function defectDetection(card, trail, context) {
  const defectAt = firstDefectEntryAt(trail);
  if (defectAt === null) return null;
  if (hasFixCardFor(context.cards, card)) return null;

  const enteredBlocked = card?.status === "blocked" || card?.status === "canceled";
  const changedAt = enteredBlocked && instant(card?.status_changed_at) !== null ? instant(card.status_changed_at) : null;
  const at = changedAt !== null && changedAt < defectAt ? changedAt : defectAt;
  const source = changedAt !== null && changedAt < defectAt ? "frontmatter" : "comments";

  const spec = SLA_ROWS.defect_card_creation;
  return {
    row: "defect_card_creation",
    origin: { kind: "trail_event", at: new Date(at).toISOString(), source, confidence: "low" },
    thresholdMin: spec.limitMin,
    thresholdRef: spec.thresholdRef,
    visibilityOnly: false,
    releasable: false,
    releasableBasis: null,
    blockedReason: blockedReasonOf(card),
    openPredicate: "no_fix_card",
    action: spec.action,
    evidence: evidenceOf(card, spec.thresholdRef, "no_fix_card"),
  };
}

/**
 * The `product/UX acceptance queued` row (§⑨.1 tail).
 *
 * Applies to **flow A** only; an absent `flow` is treated as A (fail-safe). The
 * wait starts when the card entered delivery (`in_review`) and is open while no
 * card records `review_of = <this card>`.
 */
function acceptanceDetection(card, context) {
  if (card?.status !== "in_review") return null;
  const flow = card?.meta?.flow ?? "A";
  if (String(flow).toUpperCase() !== "A") return null;
  if (context.reviewOfRefs.size > 0 && idsOf(card).some((id) => context.reviewOfRefs.has(id))) return null;

  const changedAt = instant(card?.status_changed_at) === null ? null : card.status_changed_at;
  const spec = SLA_ROWS.acceptance_card_creation;
  const origin = changedAt !== null
    ? { kind: "status_changed_at", at: changedAt, source: "frontmatter", confidence: "high" }
    : { kind: "unverifiable", at: null, source: "missing", confidence: "low" };

  return {
    row: "acceptance_card_creation",
    origin,
    thresholdMin: origin.kind === "unverifiable" ? null : spec.limitMin,
    thresholdRef: spec.thresholdRef,
    visibilityOnly: false,
    releasable: false,
    releasableBasis: null,
    blockedReason: blockedReasonOf(card),
    openPredicate: "no_review_card",
    action: spec.action,
    evidence: evidenceOf(card, spec.thresholdRef, "no_review_card"),
  };
}

/**
 * The `leader patrol stalled` row.
 *
 * Two conditions, both required (§5.1): **work is pending on a leader action**
 * (an idle board is not a stalled leader — that would break zero-cost idle every
 * night), and no leader-attributed board event is observable for longer than the
 * row's bound.
 *
 * The measurable leader events on this board are a card's creation, a card's
 * transition to `done` (a leader-only transition), and a `kind=confirm` /
 * `kind=decision` trail entry. The contract also counts `kind=change`, which
 * workers write constantly; counting it would let any chatty worker mask a real
 * stall, so it is deliberately left out — the direction of that omission is
 * *over*-alert, which is the admissible one. Authorship is not recorded on this
 * board, so "leader-attributed" is the closest decidable proxy, and the alert
 * says so with `confidence: "low"`.
 */
function leaderStalledDetection(context) {
  if (!context.pendingLeaderWork) return null;
  const spec = SLA_ROWS.leader_stalled;
  const at = context.lastLeaderEventAt;
  if (at === null) {
    return {
      row: "leader_stalled",
      origin: { kind: "unverifiable", at: null, source: "missing", confidence: "low" },
      thresholdMin: null,
      thresholdRef: null,
      visibilityOnly: true,
      releasable: false,
      releasableBasis: null,
      blockedReason: null,
      openPredicate: "leader_owed_work",
      action: spec.action,
      cardOverride: context.anchorCard ?? null,
      evidence: evidenceOf(context.anchorCard ?? {}, null, "leader_owed_work"),
    };
  }
  const anchor = context.anchorCard ?? {};
  return {
    row: "leader_stalled",
    origin: { kind: "trail_event", at: new Date(at).toISOString(), source: context.lastLeaderEventSource ?? "frontmatter", confidence: "low" },
    thresholdMin: spec.limitMin,
    thresholdRef: spec.thresholdRef,
    visibilityOnly: false,
    releasable: false,
    releasableBasis: null,
    blockedReason: null,
    openPredicate: "leader_owed_work",
    action: spec.action,
    cardOverride: context.anchorCard ?? null,
    evidence: evidenceOf(anchor, spec.thresholdRef, "leader_owed_work"),
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** The board-wide facts the per-card detectors share. */
function boardContext(cards, trails) {
  const reviewOfRefs = new Set();
  const terminalRefs = new Set();
  let lastLeaderEventAt = null;
  let lastLeaderEventSource = null;

  const note = (at, source) => {
    if (at === null) return;
    if (lastLeaderEventAt === null || at > lastLeaderEventAt) {
      lastLeaderEventAt = at;
      lastLeaderEventSource = source;
    }
  };

  for (const card of cards) {
    const reviewOf = card?.meta?.review_of;
    if (typeof reviewOf === "string" && reviewOf.trim() !== "") reviewOfRefs.add(reviewOf.trim());
    if (TERMINAL_STATUSES.includes(card?.status)) {
      for (const id of idsOf(card)) terminalRefs.add(id);
    }
    // Creating a card is the leader's act (§⑩: the sole dispatcher).
    note(instant(card?.created_at), "frontmatter");
    // `done` is a leader-only transition (task-interface §4).
    if (card?.status === "done") note(instant(card?.status_changed_at), "frontmatter");

    // `confirm` / `decision` are leader-side claims (`§⑭` / `§⑬.5`), so a trail
    // entry of either kind is an observable leader action.
    for (const comment of commentsOf(trails[String(card?.identifier ?? card?.id ?? "")])) {
      if (comment?.kind !== "confirm" && comment?.kind !== "decision") continue;
      note(commentAt(comment), "comments");
    }
  }

  return { cards, reviewOfRefs, terminalRefs, lastLeaderEventAt, lastLeaderEventSource };
}

/**
 * Decide the SLA patrol over the board.
 *
 * One entry per **(card, `§⑮` row)** at its highest newly-crossed tier. A card
 * still inside its lead contributes nothing at all — that is the zero-cost-idle
 * property, and it is a property of this function rather than of how the runner
 * chooses to log.
 *
 * @param {{
 *   cards?: object[],
 *   trails?: Record<string, object[]>,
 *   now: string|number,
 *   periodSeconds?: number,
 *   mechanismHost?: string|null,
 *   mechanism?: string,
 * }} input
 * @returns {{alerts: object[]}} the tuples to emit; a card inside its lead is
 *   simply absent (the pre-emit re-check's `dropped` channel belongs to the
 *   runner, which is the half that can re-read a card)
 */
export function planSlaPatrol(input = {}) {
  const cards = Array.isArray(input.cards) ? input.cards : [];
  const trails = input.trails ?? {};
  const now = input.now;
  const mechanism = input.mechanism ?? MECHANISM;
  const mechanismHost = input.mechanismHost ?? null;
  const periodMin = Number.isFinite(input.periodSeconds) ? input.periodSeconds / 60 : 0;
  const context = boardContext(cards, trails);

  const detections = [];
  for (const card of cards) {
    const id = String(card?.identifier ?? card?.id ?? "");
    if (id === "") continue;
    const trail = trails[id] ?? [];
    const found = [
      blockedDetection(card, trail, context),
      confirmDetection(card, trail),
      defectDetection(card, trail, context),
      acceptanceDetection(card, context),
    ];
    for (const entry of found) {
      if (entry !== null) detections.push({ card, id, ...entry });
    }
  }

  // `leader_stalled` is a board-level row, so it is evaluated once — and only
  // when there is *pending leader work*, which is exactly the union of the four
  // waits above (a card awaiting acceptance, a blocked card whose wait is open,
  // an unanswered gate, an open defect wait). Note this conditions on *pending
  // work*, not on a tier being crossed: the conditioning rule exists so that an
  // idle board — a Tuesday night with nothing dispatched — is never read as a
  // stalled leader.
  const leaderOwed = detections.filter((entry) => entry.row !== "leader_stalled");
  if (leaderOwed.length > 0) {
    const anchorCard = leaderOwed
      .map((entry) => entry.card)
      .sort((a, b) => String(a?.status_changed_at ?? "").localeCompare(String(b?.status_changed_at ?? "")))[0];
    const found = leaderStalledDetection({ ...context, pendingLeaderWork: true, anchorCard });
    if (found !== null) {
      const anchor = found.cardOverride ?? anchorCard ?? {};
      detections.push({ card: anchor, id: String(anchor?.identifier ?? anchor?.id ?? "board"), ...found });
    }
  }

  const alerts = [];
  for (const entry of detections) {
    // The elapsed value is computed here, once per detection, so every row
    // shares one working-hours function rather than each detector carrying its
    // own idea of "how long".
    const elapsed = elapsedWorkingMinutes(entry.origin.at, now);
    // A row with no threshold has no due point, so its only tier is `warn`
    // (§5.3 / §6.5 / §7.4): visibility without a verdict, never a silent drop.
    const tier = entry.thresholdMin === null ? "warn" : tierFor(entry.row, elapsed, periodMin);
    // Inside its lead: not a candidate at all, so it is neither an alert nor a
    // *drop* — `dropped` is for candidates the pre-emit re-check removed (§10.1),
    // and filling it with a line per quiet card every tick would bury them.
    if (tier === null) continue;
    const measureStartAt = entry.origin.at === null ? null : new Date(instant(entry.origin.at)).toISOString();
    const alertId = alertIdFor(entry.id, entry.row, tier);
    const spec = SLA_ROWS[entry.row];
    const action = entry.releasable
      ? `${entry.action} — releasable hint: ${entry.releasableBasis} (the leader decides; the inspector never moves a card)`
      : entry.action;
    alerts.push({
      alert_id: alertId,
      dedup_key: dedupKeyFor(alertId, measureStartAt),
      card_id: entry.id,
      sla_row: entry.row,
      sla_ref: spec.ref,
      severity: tier,
      measure_start_kind: entry.origin.kind,
      measure_start_at: measureStartAt,
      measure_start_source: entry.origin.source,
      elapsed_working_min: elapsed === null ? null : Math.round(elapsed * 1000) / 1000,
      elapsed_basis: "working_hours",
      threshold_min: entry.thresholdMin,
      due_at: entry.thresholdMin === null ? null : addWorkingMinutes(measureStartAt, entry.thresholdMin),
      action,
      target: "leader",
      notify: tier === "escalate" ? "immediate" : "digest",
      releasable: entry.releasable,
      releasable_basis: entry.releasableBasis,
      blocked_reason: entry.blockedReason ?? null,
      confidence: entry.origin.confidence,
      mechanism,
      mechanism_host: mechanismHost,
      // The ledger owns these three (§8.3): a plan on its own has not been
      // observed yet, so the runner overwrites them from the recorded entry
      // before the tuple goes out.
      first_seen: measureStartAt,
      last_seen: null,
      observed_by: [mechanism],
      evidence: entry.evidence ?? null,
    });
  }

  alerts.sort((a, b) => (a.card_id === b.card_id ? a.sla_row.localeCompare(b.sla_row) : a.card_id.localeCompare(b.card_id)));
  return { alerts };
}

// ---------------------------------------------------------------------------
// Pre-emit re-check (§9.6)
// ---------------------------------------------------------------------------

/**
 * Does an alert survive a live second look at the card?
 *
 * The scan above works from a board snapshot that may already be a few seconds
 * old; the contract requires the survivor set to be re-checked against the
 * card's *current* state immediately before the notification goes out, and the
 * two to share one decision rule. The rule restated here is deliberately the
 * narrow, structural half of each detector — the half a fresh single-card read
 * can answer:
 *
 *   * `blocked_clarification` — the card must still be `blocked`;
 *   * `confirmation_gate` — a request must still be the card's latest word;
 *   * `defect_card_creation` — the card must still not be closed out;
 *   * `acceptance_card_creation` — the card must still be `in_review`;
 *   * `leader_stalled` — nothing: the live read cannot see the rest of the board,
 *     so a single-card re-check has no evidence either way.
 *
 * A drop is always *returned*, never swallowed — the existing patrol's
 * "绝不静默丢弃" discipline.
 *
 * @param {object} alert a tuple from `planSlaPatrol`
 * @param {object|null} liveCard the card as re-read now (`null` when gone)
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function stillQualifies(alert, liveCard) {
  if (liveCard === null || liveCard === undefined) {
    return { ok: false, reason: `live_status:${liveCard === undefined ? "missing" : "gone"}` };
  }
  const status = liveCard?.status ?? null;
  switch (alert?.sla_row) {
    case "blocked_clarification":
      return status === "blocked" ? { ok: true } : { ok: false, reason: `live_status:${status}` };
    case "confirmation_gate":
      // A gate lives on a card still being worked. Whether it has been *answered*
      // is a trail fact a single-card read cannot see, so only the card's leaving
      // the working states is decidable here — and a card that stopped being
      // worked no longer owes the leader a review.
      return status === "blocked" || status === "done" || status === "canceled"
        ? { ok: false, reason: `live_status:${status}` }
        : { ok: true };
    case "defect_card_creation":
      return status === "done" ? { ok: false, reason: "live_status:done" } : { ok: true };
    case "acceptance_card_creation":
      return status === "in_review" ? { ok: true } : { ok: false, reason: `live_status:${status}` };
    case "leader_stalled":
      return { ok: true };
    default:
      return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// De-duplication (§8.3)
// ---------------------------------------------------------------------------

/** A fresh, empty ledger. */
export function emptySlaLedger() {
  return { version: 1, seen: {} };
}

/**
 * Split one pass's alerts into the ones to notify and the ones already notified.
 *
 * *Key* = `dedup_key` = `<card>#<row>#<tier>@<origin>`. Three properties are
 * deliberate: the **tier** means a promotion is a *new* key and an escalation is
 * never de-duplicated away; the **origin** means a *new* wait on the same
 * card/row/tier re-notifies (a re-blocked card is a new wait, not a duplicate).
 *
 * Read-only on purpose. The contract's rule is **notify, then record** (§8.3
 * rule 2): an alert that a later check drops before it is sent must not have
 * left a marker behind, or the next tick would suppress the very alert that was
 * never delivered — a lost alert, which is the one failure the ledger must never
 * cause. `recordSlaAlerts` is the write half, called only after the send.
 *
 * An unreadable/absent ledger suppresses nothing: the caller passes an empty one
 * and every alert goes out.
 *
 * @param {object[]} alerts
 * @param {{seen?: Record<string, object>}} ledger
 * @returns {{notify: object[], suppressed: object[]}}
 */
export function partitionSlaAlerts(alerts, ledger) {
  const seen = ledger?.seen && typeof ledger.seen === "object" ? ledger.seen : {};
  const notify = [];
  const suppressed = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const key = alert?.dedup_key;
    if (typeof key !== "string" || key === "") {
      notify.push(alert);
      continue;
    }
    const known = seen[key];
    if (known === undefined) notify.push(alert);
    else suppressed.push(alert);
  }
  return { notify, suppressed };
}

/**
 * Record the alerts that were actually notified — idempotent, and it grows
 * `observed_by` for a suppressed duplicate too, so a duplicate that was *seen*
 * is still auditable even though it was not sent.
 *
 * @param {{seen?: Record<string, object>}} ledger
 * @param {object[]} alerts the ones that went out
 * @param {string} now
 * @param {object[]} [suppressed] duplicates observed but not sent
 * @returns {object} a new ledger
 */
export function recordSlaAlerts(ledger, alerts, now, suppressed = []) {
  const base = ledger && typeof ledger === "object" && ledger.seen && typeof ledger.seen === "object"
    ? ledger
    : emptySlaLedger();
  const seen = { ...base.seen };

  const observe = (alert, fresh) => {
    const key = alert?.dedup_key;
    if (typeof key !== "string" || key === "") return;
    const known = seen[key];
    const observedBy = Array.isArray(known?.observed_by) ? known.observed_by : [];
    const nextObserved = observedBy.includes(alert.mechanism) ? observedBy : [...observedBy, alert.mechanism];
    seen[key] = {
      first_seen: known?.first_seen ?? now,
      last_seen: now,
      observed_by: fresh ? [alert.mechanism] : nextObserved,
    };
  };
  for (const alert of Array.isArray(alerts) ? alerts : []) observe(alert, true);
  for (const alert of Array.isArray(suppressed) ? suppressed : []) observe(alert, false);
  return { version: 1, seen };
}

/**
 * Bound the ledger so a long-lived host does not grow a file forever: keys whose
 * `last_seen` is older than `maxAgeMs` go, and if that is still more than
 * `maxEntries`, the oldest go too. Dropping a key costs at most one duplicate
 * notification, which is the admissible failure (§8.3 rule 2).
 */
export function pruneSlaLedger(ledger, options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 30 * 24 * MS_PER_HOUR;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 5_000;
  const now = instant(options.now);
  const seen = ledger?.seen && typeof ledger.seen === "object" ? ledger.seen : {};

  let entries = Object.entries(seen).filter(([, entry]) => {
    if (now === null) return true;
    const last = instant(entry?.last_seen);
    return last === null || now - last <= maxAgeMs;
  });
  if (entries.length > maxEntries) {
    entries = entries
      .sort((a, b) => (instant(a[1]?.last_seen) ?? 0) - (instant(b[1]?.last_seen) ?? 0))
      .slice(entries.length - maxEntries);
  }
  return { version: 1, seen: Object.fromEntries(entries) };
}
