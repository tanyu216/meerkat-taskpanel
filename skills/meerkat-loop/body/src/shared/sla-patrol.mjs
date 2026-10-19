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
 * Four rulings of the contract's v1.1 write-back are implemented here, and each
 * is the difference between two mechanisms agreeing and merely resembling each
 * other:
 *
 *   * **`leader_stalled` attribution is on the author, not the kind** (§6.3-D,
 *     "F2"). A `change` comment written by a *worker* must not reset the stall
 *     clock; one written by the *leader* must. See `isLeaderTrailEntry`.
 *   * **`heartbeat_stale` is a real SLA channel** (§10.4, "F4"). The legacy
 *     `{stale:[…]}` envelope stays exactly as its published consumer knows it,
 *     and this pass emits the §4 tuple *beside* it — the legacy shape is not a
 *     substitute for the channel.
 *   * **`confidence` is pinned** (§6.2, "F6"): `high` iff the chosen origin was
 *     read verbatim, `low` iff it was derived, approximated or undecidable.
 *   * **`inspector_liveness` is the mutual watchdog** (§5.3 / §8.4, "F3"): each
 *     mechanism publishes a last-successful-run marker and watches the peer's,
 *     because "a silent inspector reads exactly like a healthy board".
 *
 * Pure: no `node:` specifiers, no clock of its own (`now` is always an input),
 * no filesystem. `scripts/supervisor.mjs` owns the I/O half.
 */

import { CLAIM_STALE_ANY_MS, CLAIM_STALE_SAME_MS } from "./constants.mjs";

/** This mechanism's identity in the shared tuple (§4 #21). */
export const MECHANISM = "loop-patrol";

/** The other half of the mutual watchdog (§8.4) — the openclaw-side cron inspector. */
export const PEER_MECHANISM = "openclaw-cron";

/**
 * The peer's own cadence, in minutes — **a mechanism parameter, never an SLA
 * number** (§2). The peer (`sla-scan`) registers itself at 15 min, which its own
 * card pinned so that `warn = L − P` stays inside the tightest `§⑮` limit
 * (`heartbeat_stale`, 30 min); taking the same number here is what makes the two
 * mechanisms' derived liveness bounds comparable at all.
 */
export const PEER_PERIOD_MIN = 15;

/**
 * How many of the peer's own periods it may miss before it counts as down
 * (§5.3: `peer_stale ⇔ now − peer.last_ok > k × P_peer`). A small integer: one
 * missed period is a scheduling hiccup, three is a stopped inspector.
 */
export const PEER_LIVENESS_K = 3;

/**
 * The leader's action lookback, in days (a mechanism parameter, §6.3-D).
 *
 * A board whose whole history is older than this shows *no* leader event to the
 * inspector, and the contract's answer there is not silence: the row is emitted
 * with `confidence: "low"` and the origin recorded as unverifiable — "an
 * inspector that has never seen the leader act must say so rather than stay
 * quiet".
 */
export const LEADER_LOOKBACK_DAYS = 7;

/**
 * The comment kinds the contract counts as a leader's *action* (§6.3-D set (a)).
 * `change` is deliberately in it: the ruling that excludes it excludes a
 * *worker's* change, not the leader's — see `isLeaderTrailEntry`.
 */
export const LEADER_COMMENT_KINDS = Object.freeze(["confirm", "decision", "change"]);

/**
 * Who counts as the leader when a trail entry is attributed (§6.3-D, "F2").
 *
 * The contract forbids hard-coding a person (`§3`: "the name is never
 * hard-coded"), and a TaskPanel board has no role column — but every comment
 * does carry an author (`author_kind` and `author_id`, plus the resolved `author`
 * object on the wire) — and since `0023` that kind is a **platform**, not one of
 * three category words, so `LEADER_AUTHOR_KIND` below is the one reserved value
 * rather than the first of a list. The board's own I5 names the *decision
 * authority*: `isDecisionComment` and
 * `repos.comments.listDecisions` both read `author_kind = 'human'` with kinds
 * {decision, confirm, change}, and `awaiting` resumes only on a human comment —
 * "an agent comment neither satisfies the payload nor resumes the card".
 *
 * So the default filter is the board's own: **an author that is not a worker
 * agent**, i.e. `author_kind === "human"`. A deployment whose leader writes as
 * an `agent` (the openclaw side addresses its liaison by name, default the
 * current coordinator) narrows it further by passing `leaderId` — the *same*
 * filter, one author narrower, which is how the two mechanisms keep one set.
 */
export const LEADER_AUTHOR_KIND = "human";

/**
 * Is this trail entry attributable to the leader?
 *
 * The filter is on the **author** — the contract's point is that `kind` alone
 * cannot tell a leader's `change` from a worker's, and counting the worker's
 * would let any chatty worker mask a real stall.
 *
 * @param {object} comment a trail entry (the wire comment: `kind`, `author_kind`, `author_id`)
 * @param {string|null} [leaderId] an explicit liaison id, when the deployment knows one
 * @returns {boolean}
 */
export function isLeaderTrailEntry(comment, leaderId = null) {
  const kind = comment?.kind;
  if (!LEADER_COMMENT_KINDS.includes(kind)) return false;
  const id = String(comment?.author_id ?? "").trim();
  if (leaderId !== null && leaderId !== undefined && String(leaderId).trim() !== "") {
    return id !== "" && id === String(leaderId).trim();
  }
  return String(comment?.author_kind ?? "").trim() === LEADER_AUTHOR_KIND;
}

/** The reassignment shape the `assignee_changed` basis reads (§7.4, "F7"). */
const REASSIGN_SHAPE = /改派|reassign|assignee\s*[:=]/i;

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

/**
 * The `meta.accepted_by` marker the workflow pass writes when it (not a human)
 * moves a card to `done` after a review verdict. A `done` card carrying it is
 * **not** a leader event: `leader_stalled` counts leader acts, and an automated
 * acceptance must not reset the leader's clock (nor hide a real stall).
 */
export const LOOP_ACCEPTOR = "loop-review";

/** A meta / wire value as a non-negative integer, or `null`. */
function intOrNull(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

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
    // The legacy `stale` / `heartbeat-unreadable` alert keeps its published
    // envelope, untouched — but it is **not** the SLA channel (§10.4, "F4"): a
    // row that never emits the §4 tuple cannot take part in the shared ledger,
    // so the peer's identical finding would be notified twice. Both go out; this
    // is the half the ledger can de-duplicate across mechanisms.
    coveredBy: "sla-patrol+legacy-stale-alert",
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
    // Emitted when the deployment points the pass at the peer's last-successful-
    // run marker (§8.4). The peer's marker has not landed yet, so an unwired
    // deployment registers that as an explicit dependency instead of alarming
    // every period — see `inspectorLivenessDetection` and `planSlaPatrol`.
    coveredBy: "sla-patrol",
    action: "tell the leader that one of the two inspectors is not running",
  }),
});

/** A `PROTOCOL §⑮`-stamped constant, for the drift check and for error messages. */
export function slaRowRef(row) {
  return SLA_ROWS[row]?.ref ?? null;
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

/**
 * The `card_id` a **board-level** row carries.
 *
 * `leader_stalled` and `inspector_liveness` are facts about the board, not about
 * one card, so §4 #3's "the card the wait belongs to (or the card holding the
 * evidence)" has no card to name. Both get this stable sentinel rather than a
 * fabricated id: it keeps their `dedup_key`s constant across passes (§8.3's
 * "notify once" for one outage), and the runner can tell "there is no card here"
 * from "the card could not be read" — which matters, because the pre-emit
 * re-check (§9.6) re-reads a card and would otherwise call the provider for a
 * card that never existed.
 */
export const BOARD_CARD_ID = "board";

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

/**
 * Does the trail record a reassignment after `since` — the evidence channel of
 * `releasable_basis: "assignee_changed"` (§7.4, "F7")?
 *
 * The board snapshot carries only the *current* `assignee`, so a pre-emit read
 * can never show that it changed; the trail is the only machine-readable change
 * channel, and both mechanisms read **the same one** — the substantive-change
 * entries, written by the leader (a reassignment is the leader's act, §⑪). The
 * body then has to say it *is* a reassignment: a card can be `change`d a dozen
 * times for other reasons, and reporting each of those as "the assignee moved"
 * would be a false hint rather than a fail-safe one — a releasability hint is a
 * hint, and over-reporting it is noise, not coverage.
 *
 * @param {object[]} trail
 * @param {string|number|null} since the block's origin (`blocked_at`)
 * @param {string|null} [leaderId] the deployment's explicit liaison id, if it has one
 * @returns {boolean}
 */
export function trailReassignedAfter(trail, since, leaderId = null) {
  const bound = instant(since);
  if (bound === null) return false;
  return commentsOf(trail).some((comment) => {
    if (comment?.kind !== "change") return false;
    if ((commentAt(comment) ?? -Infinity) <= bound) return false;
    if (!isLeaderTrailEntry(comment, leaderId)) return false;
    return REASSIGN_SHAPE.test(String(comment?.body ?? ""));
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

  // The releasability hint (§7.4) — a *hint*, never an action. All three bases
  // are decidable now: the last one used to be dropped because "the read surface
  // carries no assignee history", but the contract names the **evidence channel**
  // for it (the §7 substantive-change trail, "F7"), and that trail is exactly
  // what this function is already holding.
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
  } else if (reason === "out_of_bounds") {
    if (blockedAt !== null && trailReassignedAfter(trail, blockedAt, context.leaderId ?? null)) {
      releasable = true;
      releasableBasis = "assignee_changed";
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

  // §6.3-B, "F6": the chosen origin is an exact timestamp — the frontmatter
  // `status_changed_at`, or one uniquely-identified `kind=defect` entry — so
  // reading it verbatim is `confidence: "high"`. The **only** path that lowers
  // it is an *undecidable* open predicate (§6.2's "no readable candidate"
  // clause), and there is exactly one of those here: a board snapshot the read
  // did not complete (`boardTruncated`), where "no fix card in the snapshot" may
  // simply mean the fix card was past the page. That is still reported as open —
  // fail-safe — but it says so.
  const undecidable = context.boardTruncated === true;
  const openPredicate = undecidable ? "no_fix_card_undecidable" : "no_fix_card";

  const spec = SLA_ROWS.defect_card_creation;
  return {
    row: "defect_card_creation",
    origin: {
      kind: "trail_event",
      at: new Date(at).toISOString(),
      source,
      confidence: undecidable ? "low" : "high",
    },
    thresholdMin: spec.limitMin,
    thresholdRef: spec.thresholdRef,
    visibilityOnly: false,
    releasable: false,
    releasableBasis: null,
    blockedReason: blockedReasonOf(card),
    openPredicate,
    action: undecidable
      ? `${spec.action} — the board read was incomplete, so the fix-card check could not be decided; the wait is treated as open`
      : spec.action,
    evidence: evidenceOf(card, spec.thresholdRef, openPredicate),
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
  // A review card suppresses this row only for the round it audits. A card that
  // was rejected and re-delivered is a *new* round with no review card yet — a
  // last round's review card must not silence it (the rejection path relies on
  // this: the next delivery has to be reviewed again). A review card written
  // before `review_round` existed carries `null`, which still suppresses — that
  // was the pre-round behaviour and the only honest reading of such a card.
  const round = intOrNull(card?.delivery_round);
  for (const id of idsOf(card)) {
    const rounds = context.reviewOfRefs.get(id);
    if (rounds !== undefined && (rounds.has(null) || rounds.has(round))) return null;
  }

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
 * **The attribution set is the author's, not the kind's** (§6.3-D, "F2") — see
 * `isLeaderTrailEntry`. The measurable leader events are a `{confirm, decision,
 * change}` entry *authored by the leader*, a card **created** by the leader, and
 * a transition to `done` (leader-only per `task-interface` §4). A worker's
 * `change` does not reset the stall clock; the leader's does. That single set is
 * what both mechanisms must use, so neither may add or drop a member.
 *
 * **Confidence follows §6.2/§6.3-D ("F6")**: an exact leader-event timestamp is
 * `high` — picking the *latest* of several exact candidates is deterministic and
 * does not lower it. `low` is reserved for the one case the contract names: a
 * lookback window with **no** leader event. The pre-lookback origin is still
 * emitted (dropping it would silently soften the deepest stall); it is the
 * *confidence* that says the board is quiet, not a missing alert.
 */
function leaderStalledDetection(context) {
  if (!context.pendingLeaderWork) return null;
  const spec = SLA_ROWS.leader_stalled;
  const anchor = context.anchorCard ?? {};
  const event = context.leaderEvent;
  if (event === null) {
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
      action: `${spec.action} — no leader-attributed event is readable on this board at all`,
      cardOverride: context.anchorCard ?? null,
      evidence: evidenceOf(anchor, null, "leader_owed_work"),
    };
  }
  return {
    row: "leader_stalled",
    origin: {
      kind: event.kind,
      at: new Date(event.at).toISOString(),
      source: event.source,
      confidence: event.inLookback ? "high" : "low",
    },
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

/**
 * The `worker heartbeat stale` row, as the **SLA channel** (§10.4, "F4").
 *
 * The legacy `{stale:[…]}` alert keeps its published envelope and its consumer —
 * this pass does not touch it. But the legacy shape carries no `dedup_key`, no
 * `sla_row` and no working-hours basis, so it cannot take part in the shared
 * ledger: the peer mechanism's identical finding about the same heartbeat would
 * be a second notification. The contract's ruling is therefore that the row
 * **also** emits the §4 tuple, and this is it.
 *
 * Origin = `heartbeat_at` (an exact frontmatter field ⇒ `confidence: "high"`).
 * An unreadable heartbeat is *not* green (§6.5): it alerts at `warn` with
 * `measure_start_kind: "unverifiable"` and no threshold, mirroring the legacy
 * `heartbeat-unreadable` alert rather than replacing it.
 */
function heartbeatStaleDetection(card) {
  if (card?.status !== "in_progress") return null;
  const spec = SLA_ROWS.heartbeat_stale;
  const hb = instant(card?.heartbeat_at);
  if (hb === null) {
    return {
      row: "heartbeat_stale",
      origin: { kind: "unverifiable", at: null, source: "missing", confidence: "low" },
      thresholdMin: null,
      thresholdRef: null,
      visibilityOnly: false,
      releasable: false,
      releasableBasis: null,
      blockedReason: blockedReasonOf(card),
      openPredicate: "in_progress",
      action: `${spec.action} — the heartbeat on this card cannot be read; verify its timestamps`,
      evidence: evidenceOf(card, null, "in_progress"),
    };
  }
  return {
    row: "heartbeat_stale",
    origin: { kind: "heartbeat_at", at: card.heartbeat_at, source: "frontmatter", confidence: "high" },
    thresholdMin: spec.limitMin,
    thresholdRef: spec.thresholdRef,
    visibilityOnly: false,
    releasable: false,
    releasableBasis: null,
    blockedReason: blockedReasonOf(card),
    openPredicate: "in_progress",
    action: spec.action,
    evidence: evidenceOf(card, spec.thresholdRef, "in_progress"),
  };
}

/**
 * The `inspector liveness` row — the mutual watchdog (§5.3 / §8.4, "F3").
 *
 * Each mechanism publishes a last-successful-run marker and watches the peer's;
 * if the peer's is older than `k × P_peer` the watcher says so at `warn`. It is
 * the only defence against the failure mode this team has already been bitten
 * by: **a silent inspector reads exactly like a healthy board**.
 *
 * The bound is *derived* and the row carries `threshold_min: null`, so no SLA
 * value is invented (§5.3 discipline). Two cases the caller decides, because
 * only the caller can see the filesystem:
 *
 *   * **no marker at all** (`peerLastOkAt` unreadable) — the peer has not landed
 *     its half yet. Alarming every period on that would be the "never green"
 *     failure mode the contract exists to prevent, so the default is a visible
 *     dependency note and no alert; a deployment that *requires* the peer (both
 *     mechanisms installed) sets `peerRequired` and gets the alarm instead.
 *   * **a marker that is stale** — always an alert. A peer that once ran and
 *     stopped is exactly what the watchdog is for.
 *
 * @param {{peerLastOkAt?: string|number|null, now: string|number, peerPeriodMinutes?: number, k?: number, peerRequired?: boolean}} input
 * @returns {{row: string, origin: object, ...}|null}
 */
export function inspectorLivenessDetection(input = {}) {
  const spec = SLA_ROWS.inspector_liveness;
  const k = Number.isFinite(input.k) && input.k > 0 ? input.k : PEER_LIVENESS_K;
  const peerPeriod = Number.isFinite(input.peerPeriodMinutes) && input.peerPeriodMinutes > 0
    ? input.peerPeriodMinutes
    : PEER_PERIOD_MIN;
  const boundMin = k * peerPeriod;
  const lastOk = instant(input.peerLastOkAt ?? null);
  const now = instant(input.now);

  if (lastOk === null) {
    if (input.peerRequired !== true) return null;
    return {
      row: "inspector_liveness",
      origin: { kind: "unverifiable", at: null, source: "missing", confidence: "low" },
      thresholdMin: null,
      thresholdRef: null,
      visibilityOnly: true,
      releasable: false,
      releasableBasis: null,
      blockedReason: null,
      openPredicate: `peer ${PEER_MECHANISM} has never published a last-ok marker`,
      action: spec.action,
      cardOverride: null,
      evidence: livenessEvidence(null, null, boundMin, "absent"),
    };
  }

  const ageMin = now === null ? null : Math.floor((now - lastOk) / MS_PER_MINUTE);
  // A clock that cannot be read is not a healthy peer (§9.3 / hook H4: an
  // injected fault must alarm, never yield a clean envelope). The age is
  // unknowable, so the row goes out at `warn` with `confidence: "low"` and says
  // which half was unreadable rather than quietly deciding the peer is fine.
  if (ageMin === null) {
    return {
      row: "inspector_liveness",
      origin: { kind: "unverifiable", at: null, source: "missing", confidence: "low" },
      thresholdMin: null,
      thresholdRef: null,
      visibilityOnly: true,
      releasable: false,
      releasableBasis: null,
      blockedReason: null,
      openPredicate: `peer ${PEER_MECHANISM} last-ok present but the observer's clock is unreadable`,
      action: `${spec.action} — the liveness age could not be computed`,
      cardOverride: null,
      evidence: livenessEvidence(null, null, boundMin, "unverifiable"),
    };
  }
  if (ageMin <= boundMin) return null;
  return {
    row: "inspector_liveness",
    origin: { kind: "trail_event", at: new Date(lastOk).toISOString(), source: "mechanism-marker", confidence: "high" },
    // No §⑮ row ⇒ no due point: `warn` is the only tier this can ever reach
    // (§5.3), which is why the threshold is null rather than a guessed bound.
    thresholdMin: null,
    thresholdRef: null,
    visibilityOnly: true,
    releasable: false,
    releasableBasis: null,
    blockedReason: null,
    openPredicate: `peer ${PEER_MECHANISM} last-ok older than ${k} × ${peerPeriod}min`,
    action: spec.action,
    cardOverride: null,
    evidence: livenessEvidence(new Date(lastOk).toISOString(), ageMin, boundMin, "present"),
  };
}

/** The liveness row has no card, so its evidence carries the peer's own facts. */
function livenessEvidence(peerLastOk, peerAgeMin, peerBoundMin, peerState) {
  return {
    status: "mechanism",
    status_changed_at: null,
    has_sessions: null,
    has_workspace: null,
    threshold_ref: null,
    open_predicate: "peer_liveness",
    peer: PEER_MECHANISM,
    peer_last_ok: peerLastOk,
    peer_age_min: peerAgeMin,
    peer_bound_min: peerBoundMin,
    peer_state: peerState,
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * The rows §5.1 lists as "work pending on a leader action".
 *
 * `heartbeat_stale` and `inspector_liveness` are deliberately **not** members: a
 * worker whose heartbeat went quiet, and a peer inspector that stopped, are both
 * facts about the *board* rather than leader-owed items — admitting either would
 * make a quiet night read as a stalled leader and break zero-cost idle (§9.4).
 */
const LEADER_OWED_ROWS = new Set([
  "blocked_clarification",
  "confirmation_gate",
  "defect_card_creation",
  "acceptance_card_creation",
]);

/**
 * The board-wide facts the per-card detectors share.
 *
 * The leader event is the **latest leader-attributed** one, with the attribution
 * of §6.3-D ("F2"): the author decides, the kind does not. `inLookback` records
 * whether that event is recent enough for the row to call it exact — a board
 * whose newest such event is a week old is not the same as a board that has
 * never shown one, and §6.2 wants that difference in the `confidence`, not in
 * silence.
 */
function boardContext(cards, trails, options = {}) {
  // `<original ref> → the delivery rounds this board has a review card for`.
  // A set rather than a boolean: a stale review card from round 1 must not
  // suppress the round-2 delivery (see `acceptanceDetection`).
  const reviewOfRefs = new Map();
  const terminalRefs = new Set();
  const leaderId = options.leaderId ?? null;
  const truncated = options.boardTruncated === true;
  const lookbackMs = (Number.isFinite(options.lookbackDays) && options.lookbackDays >= 0
    ? options.lookbackDays
    : LEADER_LOOKBACK_DAYS) * 24 * 60 * MS_PER_MINUTE;
  const now = instant(options.now);
  let leaderEvent = null;

  const note = (at, kind, source) => {
    if (at === null) return;
    if (leaderEvent === null || at > leaderEvent.at) {
      leaderEvent = {
        at,
        kind,
        source,
        // An unreadable clock cannot make an event "recent": the fail-safe
        // direction of an inspector is to say the board is quiet, not to
        // pretend it just saw the leader.
        inLookback: now !== null && now - at <= lookbackMs,
      };
    }
  };

  /**
   * Is a card's creator the leader — the same filter, applied to a card field?
   *
   * The creator IS the reporter (0019): the wire's `reporter` actor ref carries
   * the id and kind that used to ride in `creator_id`/`creator_kind`.
   */
  const createdByLeader = (card) => {
    const reporter = card?.reporter ?? null;
    const id = String(reporter?.id ?? "").trim();
    if (leaderId !== null && String(leaderId).trim() !== "") {
      return id !== "" && id === String(leaderId).trim();
    }
    return String(reporter?.kind ?? "").trim() === LEADER_AUTHOR_KIND;
  };

  for (const card of cards) {
    const reviewOf = card?.meta?.review_of;
    if (typeof reviewOf === "string" && reviewOf.trim() !== "") {
      const ref = reviewOf.trim();
      const rounds = reviewOfRefs.get(ref) ?? new Set();
      // No `review_round` on an older card is `null`, not 0: it means "the
      // round this card audits was never recorded", which suppresses every
      // round (the conservative reading — silence, not a false alarm).
      rounds.add(intOrNull(card?.meta?.review_round));
      reviewOfRefs.set(ref, rounds);
    }
    if (TERMINAL_STATUSES.includes(card?.status)) {
      for (const id of idsOf(card)) terminalRefs.add(id);
    }
    // Creating a card is the leader's act (§⑩: the sole dispatcher) — and it is
    // attributed like every other leader event: by who did it.
    if (createdByLeader(card)) note(instant(card?.created_at), "created_at", "frontmatter");
    // `done` is a leader-only transition (task-interface §4), so no author test
    // can narrow it further: the transition itself is the attribution. The one
    // exception is the loop's own automated acceptance: a `done` the workflow
    // pass wrote carries `meta.accepted_by = "loop-review"`, and counting it
    // would let the loop mask a stalled leader indefinitely.
    if (card?.status === "done" && card?.meta?.accepted_by !== LOOP_ACCEPTOR) {
      note(instant(card?.status_changed_at), "status_changed_at", "frontmatter");
    }

    // A trail entry is leader-attributed when its **author** is the leader
    // (§6.3-D). The kinds are `{confirm, decision, change}`; `change` is in the
    // set precisely because a *worker's* change must not reset the stall clock.
    for (const comment of commentsOf(trails[String(card?.identifier ?? card?.id ?? "")])) {
      if (!isLeaderTrailEntry(comment, leaderId)) continue;
      note(commentAt(comment), "trail_event", "comments");
    }
  }

  return { cards, reviewOfRefs, terminalRefs, leaderEvent, leaderId, boardTruncated: truncated };
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
 *   leaderId?: string|null,
 *   lookbackDays?: number,
 *   boardTruncated?: boolean,
 *   peerLastOkAt?: string|number|null,
 *   peerRequired?: boolean,
 *   peerPeriodMinutes?: number,
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
  const context = boardContext(cards, trails, {
    leaderId: input.leaderId ?? null,
    lookbackDays: input.lookbackDays,
    boardTruncated: input.boardTruncated,
    now,
  });

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
      heartbeatStaleDetection(card),
    ];
    for (const entry of found) {
      if (entry !== null) detections.push({ card, id, ...entry });
    }
  }

  // `leader_stalled` is a board-level row, so it is evaluated once — and only
  // when there is *pending leader work*. The union below is deliberately the
  // four rows §5.1 lists as leader-owed (a card awaiting acceptance, a blocked
  // card whose wait is open, an unanswered gate, an open defect wait): a stale
  // heartbeat and a silent peer inspector are **not** leader-owed items, and
  // letting either into this union would make a quiet board look like a stalled
  // leader — which is the zero-cost-idle rule (§9.4) failing every night.
  const leaderOwed = detections.filter((entry) => LEADER_OWED_ROWS.has(entry.row));
  if (leaderOwed.length > 0) {
    const anchorCard = leaderOwed
      .map((entry) => entry.card)
      .sort((a, b) => String(a?.status_changed_at ?? "").localeCompare(String(b?.status_changed_at ?? "")))[0];
    const found = leaderStalledDetection({ ...context, pendingLeaderWork: true, anchorCard });
    if (found !== null) {
      const anchor = found.cardOverride ?? anchorCard ?? {};
      detections.push({ card: anchor, id: String(anchor?.identifier ?? anchor?.id ?? BOARD_CARD_ID), ...found });
    }
  }

  // The mutual watchdog (§8.4) is board-level too, and has no card of its own —
  // so it is anchored on a stable pseudo-id, which keeps its `dedup_key` the
  // same for every observation of the same peer outage (§8.3's "notify once").
  const liveness = inspectorLivenessDetection({
    peerLastOkAt: input.peerLastOkAt ?? null,
    now,
    k: input.peerLivenessK,
    peerPeriodMinutes: input.peerPeriodMinutes,
    peerRequired: input.peerRequired,
  });
  if (liveness !== null) detections.push({ card: null, id: BOARD_CARD_ID, ...liveness });

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
 *   * `heartbeat_stale` — the card must still be `in_progress` (the live read
 *     cannot see the heartbeat's age, but it *can* see the card having left the
 *     only status this row applies to, and that alone is grounds to drop);
 *   * `leader_stalled` — nothing: the live read cannot see the rest of the board,
 *     so a single-card re-check has no evidence either way;
 *   * `inspector_liveness` — nothing, for the same reason: the peer's marker is
 *     not on the card the re-check reads.
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
    case "heartbeat_stale":
      return status === "in_progress" ? { ok: true } : { ok: false, reason: `live_status:${status}` };
    case "leader_stalled":
    case "inspector_liveness":
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
