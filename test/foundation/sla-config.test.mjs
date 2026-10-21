/**
 * The SLA policy vocabulary: the documented defaults, the `TASKD_SLA_*`
 * overrides, and the wire round-trip the loop consumes.
 *
 * The defaults are pinned again in `test/scheduling/sla-patrol.test.mjs`
 * against `docs/sla.md`; here they are checked as *defaults* — the values an
 * unconfigured board publishes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SLA_CONFIG,
  DEFAULT_SLA_ROWS,
  LEADER_LOOKBACK_DAYS,
  PEER_LIVENESS_K,
  PEER_PERIOD_MIN,
  SLA_CONFIG_VERSION,
  applySlaOverrides,
  isSlaEnvKey,
  parseSlaEnvValue,
  readSlaConfig,
  slaEnvDefaults,
  slaFromWire,
  slaToWire,
  validateSlaRows,
} from "../../src/foundation/sla-config.mjs";
import { SLA_ENV_KEYS, SLA_ENV_KEY_LIST } from "../../src/foundation/constants.mjs";
import { SLA_ROWS } from "../../src/foundation/sla-patrol.mjs";

const KEY = SLA_ENV_KEYS;

function fileVars(entries) {
  return new Map(Object.entries(entries));
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err?.code ?? null;
  }
  return null;
}

describe("SLA defaults", () => {
  it("is the documented table", () => {
    assert.equal(DEFAULT_SLA_ROWS.blocked_clarification.limitMin, 120);
    assert.equal(DEFAULT_SLA_ROWS.blocked_clarification.furtherMin, 1440);
    assert.equal(DEFAULT_SLA_ROWS.confirmation_gate.limitMin, 240);
    assert.equal(DEFAULT_SLA_ROWS.confirmation_gate.furtherMin, 1440);
    assert.equal(DEFAULT_SLA_ROWS.defect_card_creation.limitMin, 1440);
    assert.equal(DEFAULT_SLA_ROWS.defect_card_creation.furtherMin, 2880);
    assert.equal(DEFAULT_SLA_ROWS.acceptance_card_creation.limitMin, 1440);
    assert.equal(DEFAULT_SLA_ROWS.acceptance_card_creation.furtherMin, 2880);
    assert.equal(DEFAULT_SLA_ROWS.heartbeat_stale.limitMin, 30);
    assert.equal(DEFAULT_SLA_ROWS.heartbeat_stale.furtherMin, 360);
    assert.equal(DEFAULT_SLA_ROWS.leader_stalled.limitMin, 60);
    assert.equal(DEFAULT_SLA_ROWS.leader_stalled.furtherMin, 360);
    assert.equal(DEFAULT_SLA_ROWS.inspector_liveness.limitMin, null);
    assert.equal(DEFAULT_SLA_CONFIG.periodSeconds, 300);
    assert.equal(DEFAULT_SLA_CONFIG.leaderLookbackDays, LEADER_LOOKBACK_DAYS);
    assert.equal(DEFAULT_SLA_CONFIG.peerPeriodMin, PEER_PERIOD_MIN);
    assert.equal(DEFAULT_SLA_CONFIG.peerLivenessK, PEER_LIVENESS_K);
  });

  it("every key has a default and is listed once", () => {
    const defaults = slaEnvDefaults();
    assert.deepEqual(Object.keys(defaults).sort(), [...SLA_ENV_KEY_LIST].sort());
    assert.equal(defaults[KEY.periodSeconds], "300");
    assert.equal(defaults[KEY.rows.heartbeat_stale.limitMin], "30");
    for (const key of SLA_ENV_KEY_LIST) {
      assert.equal(isSlaEnvKey(key), true, key);
      assert.doesNotThrow(() => parseSlaEnvValue(key, defaults[key]), key);
    }
  });

  it("re-exports the same table under the historical name", () => {
    assert.equal(SLA_ROWS, DEFAULT_SLA_ROWS);
  });
});

describe("readSlaConfig — precedence", () => {
  it("returns the defaults with no configuration at all", () => {
    const config = readSlaConfig({});
    assert.deepEqual(config.rows, DEFAULT_SLA_ROWS);
    assert.equal(config.periodSeconds, 300);
    assert.equal(config.leaderLookbackDays, 7);
    assert.equal(config.peerPeriodMin, 15);
    assert.equal(config.peerLivenessK, 3);
    for (const key of SLA_ENV_KEY_LIST) assert.equal(config.sources[key], "default");
  });

  it("reads a file layer per key and leaves the rest default", () => {
    const config = readSlaConfig({
      envVars: fileVars({
        [KEY.rows.blocked_clarification.limitMin]: "60",
        [KEY.rows.blocked_clarification.furtherMin]: "120",
      }),
    });
    assert.equal(config.rows.blocked_clarification.limitMin, 60);
    assert.equal(config.rows.blocked_clarification.furtherMin, 120);
    assert.equal(config.rows.confirmation_gate.limitMin, 240);
    assert.equal(config.sources[KEY.rows.blocked_clarification.limitMin], "file");
    assert.equal(config.sources[KEY.rows.confirmation_gate.limitMin], "default");
    // The prose survived the merge.
    assert.match(config.rows.blocked_clarification.ref, /docs\/sla\.md §/);
  });

  it("lets the process environment win key by key", () => {
    const config = readSlaConfig({
      env: { [KEY.rows.blocked_clarification.limitMin]: "30" },
      envVars: fileVars({
        [KEY.rows.blocked_clarification.limitMin]: "60",
        [KEY.rows.blocked_clarification.furtherMin]: "120",
      }),
    });
    assert.equal(config.rows.blocked_clarification.limitMin, 30);
    assert.equal(config.rows.blocked_clarification.furtherMin, 120);
    assert.equal(config.sources[KEY.rows.blocked_clarification.limitMin], "env");
    assert.equal(config.sources[KEY.rows.blocked_clarification.furtherMin], "file");
  });

  it("does not let a blank process value shadow the file", () => {
    const config = readSlaConfig({
      env: { [KEY.periodSeconds]: "   " },
      envVars: fileVars({ [KEY.periodSeconds]: "600" }),
    });
    assert.equal(config.periodSeconds, 600);
    assert.equal(config.sources[KEY.periodSeconds], "file");
  });

  it("refuses a blank file value", () => {
    assert.equal(
      codeOf(() => readSlaConfig({ envVars: fileVars({ [KEY.periodSeconds]: "" }) })),
      "CONFIG_FILE_INVALID",
    );
  });
});

describe("parseSlaEnvValue — validation", () => {
  it("refuses non-integers, negatives and out-of-range values", () => {
    for (const raw of ["abc", "-1", "12.5", "1e3", " "]) {
      assert.equal(
        codeOf(() => parseSlaEnvValue(KEY.rows.blocked_clarification.limitMin, raw)),
        "CONFIG_FILE_INVALID",
        JSON.stringify(raw),
      );
    }
    assert.equal(codeOf(() => parseSlaEnvValue(KEY.periodSeconds, "0")), "CONFIG_FILE_INVALID");
    assert.equal(codeOf(() => parseSlaEnvValue(KEY.peerLivenessK, "101")), "CONFIG_FILE_INVALID");
  });

  it("names the key in the error details", () => {
    try {
      parseSlaEnvValue(KEY.periodSeconds, "0");
      assert.fail("expected a refusal");
    } catch (err) {
      assert.equal(err.code, "CONFIG_FILE_INVALID");
      assert.equal(err.details.key, KEY.periodSeconds);
    }
  });
});

describe("cross-field validation", () => {
  it("refuses a further bound below the normal limit", () => {
    assert.equal(
      codeOf(() =>
        readSlaConfig({
          envVars: fileVars({ [KEY.rows.blocked_clarification.furtherMin]: "119" }),
        }),
      ),
      "CONFIG_FILE_INVALID",
    );
  });

  it("checks the effective pair when only one side is set", () => {
    // A limit above the default further bound is equally invalid.
    assert.equal(
      codeOf(() =>
        readSlaConfig({
          envVars: fileVars({ [KEY.rows.blocked_clarification.limitMin]: "2000" }),
        }),
      ),
      "CONFIG_FILE_INVALID",
    );
  });

  it("validateSlaRows accepts equal bounds", () => {
    const rows = applySlaOverrides(DEFAULT_SLA_ROWS, {
      leader_stalled: { limitMin: 60, furtherMin: 60 },
    });
    assert.doesNotThrow(() => validateSlaRows(rows));
  });
});

describe("applySlaOverrides", () => {
  it("changes only the numbers and keeps the prose", () => {
    const rows = applySlaOverrides(DEFAULT_SLA_ROWS, {
      confirimation_typo: { limitMin: 1 },
      confirmation_gate: { limitMin: 90 },
    });
    assert.equal(rows.confirmation_gate.limitMin, 90);
    assert.equal(rows.confirmation_gate.furtherMin, 1440);
    assert.equal(rows.confirmation_gate.warnLead, true);
    assert.equal(rows.confirmation_gate.coveredBy, "sla-patrol");
    assert.match(rows.confirmation_gate.action, /review the confirmation/);
    assert.equal(rows.confirimation_typo, undefined);
  });
});

describe("the wire round-trip", () => {
  it("serialises numbers only and reads them back", () => {
    const config = readSlaConfig({
      envVars: fileVars({
        [KEY.rows.blocked_clarification.limitMin]: "60",
        [KEY.rows.blocked_clarification.furtherMin]: "120",
        [KEY.periodSeconds]: "600",
      }),
    });
    const wire = slaToWire(config);
    assert.equal(wire.version, SLA_CONFIG_VERSION);
    assert.equal(wire.period_seconds, 600);
    assert.equal(wire.rows.blocked_clarification.limit_min, 60);
    assert.equal(wire.rows.blocked_clarification.further_min, 120);
    assert.equal(wire.rows.blocked_clarification.action, undefined);

    const parsed = slaFromWire(wire);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.config.rows.blocked_clarification.limitMin, 60);
    assert.equal(parsed.config.rows.confirmation_gate.limitMin, 240);
    assert.equal(parsed.config.periodSeconds, 600);
  });

  it("reports a missing block, an error block and a malformed field", () => {
    assert.deepEqual(slaFromWire(undefined), { ok: false, reason: "missing" });
    assert.equal(slaFromWire({ error: "CONFIG_FILE_INVALID", message: "bad" }).reason, "error");
    assert.equal(slaFromWire({ period_seconds: "600" }).reason, "invalid");
    assert.equal(slaFromWire({ rows: { blocked_clarification: { limit_min: -1 } } }).reason, "invalid");
    assert.equal(
      slaFromWire({ rows: { blocked_clarification: { limit_min: 2000 } } }).reason,
      "invalid",
      "cross-field check runs on the effective rows",
    );
  });

  it("ignores unknown rows and unknown fields", () => {
    const parsed = slaFromWire({
      period_seconds: 300,
      rows: {
        blocked_clarification: { limit_min: 60, further_min: 120 },
        a_future_row: { limit_min: 1, further_min: 2 },
        confirmation_gate: { limit_min: 240, further_min: 1440, extra: "ignored" },
      },
      something_new: true,
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.config.rows.a_future_row, undefined);
  });
});
