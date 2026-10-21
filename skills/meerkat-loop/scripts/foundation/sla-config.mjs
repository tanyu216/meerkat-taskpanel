/**
 * The SLA policy vocabulary — the `TASKD_SLA_*` keys, their defaults and the
 * one parser both the board and the loop agree on.
 *
 * `docs/sla.md` §2 owns the published numbers; this module is their runtime
 * transcription. A deployment overrides a number in the install-root `.env`
 * (`TASKD_SLA_*`), the board validates it and publishes the effective table on
 * `GET /api/v1/sla`, and the loop consumes that. The defaults stay the
 * contract's: changing one is still a contract change, while an override is
 * install configuration.
 *
 * **Pure.** No `node:` imports, no clock, no filesystem: the caller supplies
 * the process environment and the parsed `.env` values. `env-config.mjs` owns
 * the file read (`readConfigFileVars`), which is what lets this module be
 * vendored into the loop payload without dragging I/O along.
 *
 * Precedence is per key: process environment > `.env` > default. A blank
 * process value does not shadow the file (the same rule `env-config.mjs`'s
 * merge uses); a blank **file** value is refused, because that is an operator
 * writing a key and then deleting its value.
 */

import {
  CLAIM_STALE_ANY_MS,
  CLAIM_STALE_SAME_MS,
  DEFAULT_PATROL_SECONDS,
  SLA_ENV_KEYS,
  SLA_ENV_KEY_LIST,
  SLA_ROW_KEYS,
} from "./constants.mjs";
import { DomainError } from "./errors.mjs";

/** The wire shape's version, for a client that feature-detects newer fields. */
export const SLA_CONFIG_VERSION = 1;

/**
 * The peer inspector's fallback cadence, minutes — a mechanism parameter, never
 * an SLA number (`docs/sla.md` §2). A peer that declares `cadence_period_min`
 * in its last-ok marker overrides it.
 */
export const PEER_PERIOD_MIN = 15;

/** Missed peer periods before `inspector_liveness` fires (§5.3). */
export const PEER_LIVENESS_K = 3;

/** How far back a leader event can be called "recent" (§6.3). */
export const LEADER_LOOKBACK_DAYS = 7;

/**
 * The `docs/sla.md` §2 runtime mapping table — the **defaults**.
 *
 * One entry per published row, with the prose the alert tuple carries. The
 * numbers are the contract's; `sla-patrol.mjs` re-exports this as `SLA_ROWS`
 * so the existing contract tests keep their single source.
 */
export const DEFAULT_SLA_ROWS = Object.freeze({
  blocked_clarification: Object.freeze({
    ref: "docs/sla.md §2 · blocked_clarification · blocked awaiting the leader's clarification",
    thresholdRef: "docs/sla.md §2 · blocked_clarification · Normal limit (L)",
    limitMin: 120,
    furtherMin: 1440,
    warnLead: true,
    origin: "blocked_at",
    coveredBy: "sla-patrol",
    action: "the leader must clarify / revise / reassign this card",
  }),
  confirmation_gate: Object.freeze({
    ref: "docs/sla.md §2 · confirmation_gate · Confirmation gate awaiting review",
    thresholdRef: "docs/sla.md §2 · confirmation_gate · Normal limit (L)",
    limitMin: 240,
    furtherMin: 1440,
    warnLead: true,
    origin: "gate_at",
    coveredBy: "sla-patrol",
    action: "the leader must review the confirmation request",
  }),
  defect_card_creation: Object.freeze({
    ref: "docs/sla.md §2 · defect_card_creation · Defect fix card creation",
    thresholdRef: "docs/sla.md §2 · defect_card_creation · Normal limit (L)",
    limitMin: 1440,
    furtherMin: 2880,
    warnLead: true,
    origin: "trail_event",
    coveredBy: "sla-patrol",
    action: "the leader must create the defect fix card and dispatch it",
  }),
  acceptance_card_creation: Object.freeze({
    ref: "docs/sla.md §2 · acceptance_card_creation · Product/UX acceptance queued",
    thresholdRef: "docs/sla.md §2 · acceptance_card_creation · Normal limit (L)",
    limitMin: 1440,
    furtherMin: 2880,
    warnLead: true,
    origin: "status_changed_at",
    coveredBy: "sla-patrol",
    action: "the leader must create the acceptance review card and dispatch it",
  }),
  heartbeat_stale: Object.freeze({
    ref: "docs/sla.md §2 · heartbeat_stale · Worker heartbeat stale",
    thresholdRef: "docs/sla.md §2 · heartbeat_stale · Normal limit (L)",
    limitMin: CLAIM_STALE_SAME_MS / 60_000,
    furtherMin: CLAIM_STALE_ANY_MS / 60_000,
    warnLead: true,
    origin: "heartbeat_at",
    coveredBy: "sla-patrol+legacy-stale-alert",
    action: "the same assignee may re-claim; past the further bound any agent may claim and report",
  }),
  leader_stalled: Object.freeze({
    ref: "docs/sla.md §2 · leader_stalled · Leader patrol stalled",
    thresholdRef: "docs/sla.md §2 · leader_stalled · Normal limit (L)",
    limitMin: 60,
    furtherMin: 360,
    warnLead: false,
    origin: "trail_event",
    coveredBy: "sla-patrol",
    action: "the leader should be reminded that no leader action is observable on the board",
  }),
  inspector_liveness: Object.freeze({
    ref: "docs/sla.md §10 · inspector_liveness · mutual watchdog",
    thresholdRef: null,
    limitMin: null,
    furtherMin: null,
    warnLead: false,
    origin: "unverifiable",
    coveredBy: "sla-patrol",
    action: "tell the leader that one of the two inspectors is not running",
  }),
});

/** The default configuration, before any `.env` override. */
export const DEFAULT_SLA_CONFIG = Object.freeze({
  rows: DEFAULT_SLA_ROWS,
  periodSeconds: DEFAULT_PATROL_SECONDS,
  leaderLookbackDays: LEADER_LOOKBACK_DAYS,
  peerPeriodMin: PEER_PERIOD_MIN,
  peerLivenessK: PEER_LIVENESS_K,
});

/**
 * One key's accepted range. The row pairs share a range; the mechanism keys
 * each have their own.
 */
const KEY_RANGES = new Map();
KEY_RANGES.set(SLA_ENV_KEYS.periodSeconds, { min: 1, max: 86_400 });
KEY_RANGES.set(SLA_ENV_KEYS.leaderLookbackDays, { min: 0, max: 3_660 });
KEY_RANGES.set(SLA_ENV_KEYS.peerPeriodMin, { min: 1, max: 1_440 });
KEY_RANGES.set(SLA_ENV_KEYS.peerLivenessK, { min: 1, max: 100 });
for (const row of SLA_ROW_KEYS) {
  KEY_RANGES.set(SLA_ENV_KEYS.rows[row].limitMin, { min: 0, max: 525_600 });
  KEY_RANGES.set(SLA_ENV_KEYS.rows[row].furtherMin, { min: 0, max: 525_600 });
}

/** @param {string} key */
export function isSlaEnvKey(key) {
  return KEY_RANGES.has(key);
}

/** @param {string} message @param {object} details */
function configError(message, details) {
  return new DomainError("CONFIG_FILE_INVALID", { message, details });
}

/**
 * Parse one `TASKD_SLA_*` value.
 *
 * @param {string} key
 * @param {unknown} raw
 * @returns {number}
 */
export function parseSlaEnvValue(key, raw) {
  const range = KEY_RANGES.get(key);
  if (range === undefined) {
    throw configError(`unknown SLA configuration key "${key}"`, { key });
  }
  const text = String(raw ?? "").trim();
  if (text === "") {
    throw configError(`${key} is empty`, { key });
  }
  if (!/^\d+$/.test(text)) {
    throw configError(`${key} must be a non-negative integer (got ${JSON.stringify(text)})`, {
      key,
      received: text,
    });
  }
  const value = Number.parseInt(text, 10);
  if (value < range.min || value > range.max) {
    throw configError(`${key} must be between ${range.min} and ${range.max} (got ${value})`, {
      key,
      received: value,
      min: range.min,
      max: range.max,
    });
  }
  return value;
}

/** One value from a `Map` or a plain object; `undefined` means "not configured". */
function readVar(vars, key) {
  if (vars === null || vars === undefined) return undefined;
  if (typeof vars.get === "function") return vars.has(key) ? vars.get(key) : undefined;
  return Object.hasOwn(vars, key) ? vars[key] : undefined;
}

/**
 * Apply only the numeric halves of an override table, preserving every prose
 * field (`ref`, `thresholdRef`, `warnLead`, `origin`, `coveredBy`, `action`).
 *
 * @param {Record<string, object>} baseRows
 * @param {Record<string, {limitMin?: number, furtherMin?: number}>|null|undefined} overrides
 * @returns {Record<string, object>}
 */
export function applySlaOverrides(baseRows, overrides) {
  const out = {};
  for (const [row, spec] of Object.entries(baseRows)) {
    const override = overrides?.[row] ?? {};
    out[row] = Object.freeze({
      ...spec,
      ...(Number.isInteger(override.limitMin) ? { limitMin: override.limitMin } : {}),
      ...(Number.isInteger(override.furtherMin) ? { furtherMin: override.furtherMin } : {}),
    });
  }
  return Object.freeze(out);
}

/**
 * The cross-row rule: a further bound below its normal limit would escalate
 * before it is overdue. Read against the **effective** values, so setting one
 * side alone is still checked against the other side's default.
 *
 * @param {Record<string, object>} rows
 */
export function validateSlaRows(rows) {
  for (const row of SLA_ROW_KEYS) {
    const spec = rows[row];
    if (spec === undefined || spec.limitMin === null || spec.furtherMin === null) continue;
    if (spec.furtherMin < spec.limitMin) {
      throw configError(
        `${row}: the further bound (${spec.furtherMin}) is below the normal limit (${spec.limitMin})`,
        { row, limitMin: spec.limitMin, furtherMin: spec.furtherMin },
      );
    }
  }
}

/**
 * The effective SLA configuration.
 *
 * @param {{env?: NodeJS.ProcessEnv|Record<string,string>|null, envVars?: Map<string,string>|Record<string,string>|null}} [input]
 * @returns {{
 *   rows: Record<string, object>, periodSeconds: number,
 *   leaderLookbackDays: number, peerPeriodMin: number, peerLivenessK: number,
 *   sources: Record<string, "env"|"file"|"default">,
 * }}
 */
export function readSlaConfig(input = {}) {
  const { env = null, envVars = null } = input;
  const sources = {};
  const values = {};

  const resolve = (key) => {
    const fromEnv = env === null || env === undefined ? undefined : env[key];
    if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== "") {
      values[key] = parseSlaEnvValue(key, fromEnv);
      sources[key] = "env";
      return;
    }
    const raw = readVar(envVars, key);
    if (raw !== undefined) {
      values[key] = parseSlaEnvValue(key, raw);
      sources[key] = "file";
      return;
    }
    sources[key] = "default";
  };

  for (const key of SLA_ENV_KEY_LIST) resolve(key);

  const overrides = {};
  for (const row of SLA_ROW_KEYS) {
    const limitKey = SLA_ENV_KEYS.rows[row].limitMin;
    const furtherKey = SLA_ENV_KEYS.rows[row].furtherMin;
    const override = {};
    if (values[limitKey] !== undefined) override.limitMin = values[limitKey];
    if (values[furtherKey] !== undefined) override.furtherMin = values[furtherKey];
    if (Object.keys(override).length > 0) overrides[row] = override;
  }

  const rows = applySlaOverrides(DEFAULT_SLA_ROWS, overrides);
  validateSlaRows(rows);

  return {
    rows,
    periodSeconds: values[SLA_ENV_KEYS.periodSeconds] ?? DEFAULT_SLA_CONFIG.periodSeconds,
    leaderLookbackDays: values[SLA_ENV_KEYS.leaderLookbackDays] ?? DEFAULT_SLA_CONFIG.leaderLookbackDays,
    peerPeriodMin: values[SLA_ENV_KEYS.peerPeriodMin] ?? DEFAULT_SLA_CONFIG.peerPeriodMin,
    peerLivenessK: values[SLA_ENV_KEYS.peerLivenessK] ?? DEFAULT_SLA_CONFIG.peerLivenessK,
    sources,
  };
}

/**
 * The `/api/v1/sla` and `/meta.capabilities.sla` projection. Only numbers cross
 * the wire; the prose (`ref`, `action`, …) stays local to the engine.
 *
 * @param {object} config
 */
export function slaToWire(config) {
  return {
    version: SLA_CONFIG_VERSION,
    period_seconds: config.periodSeconds,
    leader_lookback_days: config.leaderLookbackDays,
    peer_period_min: config.peerPeriodMin,
    peer_liveness_k: config.peerLivenessK,
    rows: Object.fromEntries(
      SLA_ROW_KEYS.map((row) => [
        row,
        {
          limit_min: config.rows[row].limitMin,
          further_min: config.rows[row].furtherMin,
        },
      ]),
    ),
  };
}

/** @param {unknown} value @param {{min:number,max:number}} range @returns {number|null} */
function wireInt(value, range) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= range.min && value <= range.max ? value : null;
}

/**
 * Read a board's published SLA configuration, all-or-nothing.
 *
 * A missing block (an older board) is `{ok: false, reason: "missing"}` and the
 * caller uses the defaults; an error block is `reason: "error"`; a malformed
 * field is `reason: "invalid"`. Unknown rows and unknown fields are ignored so
 * a newer board can add one without breaking an older loop.
 *
 * @param {object|null|undefined} wire
 * @returns {{ok: true, config: object}|{ok: false, reason: string, error?: string, message?: string, details?: object}}
 */
export function slaFromWire(wire) {
  if (wire === null || wire === undefined) return { ok: false, reason: "missing" };
  if (typeof wire !== "object") return { ok: false, reason: "invalid", details: { field: "sla" } };
  if (typeof wire.error === "string" && wire.error !== "") {
    return { ok: false, reason: "error", error: wire.error, message: wire.message ?? "" };
  }

  const periodSeconds = wireInt(wire.period_seconds, KEY_RANGES.get(SLA_ENV_KEYS.periodSeconds));
  const leaderLookbackDays = wireInt(
    wire.leader_lookback_days,
    KEY_RANGES.get(SLA_ENV_KEYS.leaderLookbackDays),
  );
  const peerPeriodMin = wireInt(wire.peer_period_min, KEY_RANGES.get(SLA_ENV_KEYS.peerPeriodMin));
  const peerLivenessK = wireInt(wire.peer_liveness_k, KEY_RANGES.get(SLA_ENV_KEYS.peerLivenessK));

  for (const [field, value, raw] of [
    ["period_seconds", periodSeconds, wire.period_seconds],
    ["leader_lookback_days", leaderLookbackDays, wire.leader_lookback_days],
    ["peer_period_min", peerPeriodMin, wire.peer_period_min],
    ["peer_liveness_k", peerLivenessK, wire.peer_liveness_k],
  ]) {
    if (raw !== undefined && raw !== null && value === null) {
      return { ok: false, reason: "invalid", details: { field, received: raw } };
    }
  }

  const overrides = {};
  const rawRows = wire.rows;
  if (rawRows !== undefined && rawRows !== null && typeof rawRows === "object") {
    for (const row of SLA_ROW_KEYS) {
      const entry = rawRows[row];
      if (entry === undefined || entry === null || typeof entry !== "object") continue;
      const override = {};
      for (const [field, key] of [
        ["limit_min", "limitMin"],
        ["further_min", "furtherMin"],
      ]) {
        const range = KEY_RANGES.get(SLA_ENV_KEYS.rows[row][key]);
        const value = wireInt(entry[field], range);
        if (entry[field] !== undefined && entry[field] !== null && value === null) {
          return { ok: false, reason: "invalid", details: { row, field, received: entry[field] } };
        }
        if (value !== null) override[key] = value;
      }
      if (Object.keys(override).length > 0) overrides[row] = override;
    }
  }

  const rows = applySlaOverrides(DEFAULT_SLA_ROWS, overrides);
  try {
    validateSlaRows(rows);
  } catch (err) {
    return { ok: false, reason: "invalid", details: err?.details ?? { field: "rows" } };
  }

  return {
    ok: true,
    config: {
      rows,
      periodSeconds: periodSeconds ?? DEFAULT_SLA_CONFIG.periodSeconds,
      leaderLookbackDays: leaderLookbackDays ?? DEFAULT_SLA_CONFIG.leaderLookbackDays,
      peerPeriodMin: peerPeriodMin ?? DEFAULT_SLA_CONFIG.peerPeriodMin,
      peerLivenessK: peerLivenessK ?? DEFAULT_SLA_CONFIG.peerLivenessK,
    },
  };
}

/**
 * Every SLA key with its default as a string — the `.env` template and the
 * install test read this rather than a second hand-kept list.
 *
 * @returns {Record<string, string>}
 */
export function slaEnvDefaults() {
  const out = {};
  out[SLA_ENV_KEYS.periodSeconds] = String(DEFAULT_SLA_CONFIG.periodSeconds);
  out[SLA_ENV_KEYS.leaderLookbackDays] = String(DEFAULT_SLA_CONFIG.leaderLookbackDays);
  out[SLA_ENV_KEYS.peerPeriodMin] = String(DEFAULT_SLA_CONFIG.peerPeriodMin);
  out[SLA_ENV_KEYS.peerLivenessK] = String(DEFAULT_SLA_CONFIG.peerLivenessK);
  for (const row of SLA_ROW_KEYS) {
    out[SLA_ENV_KEYS.rows[row].limitMin] = String(DEFAULT_SLA_ROWS[row].limitMin);
    out[SLA_ENV_KEYS.rows[row].furtherMin] = String(DEFAULT_SLA_ROWS[row].furtherMin);
  }
  return out;
}
