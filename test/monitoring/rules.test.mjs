/**
 * Tests for `monitoring/lib/rules.mjs` — the Prometheus alerting rules and the
 * validator that keeps them honest.
 *
 * Two layers are asserted: the rules file that is actually committed (its three alerts,
 * their thresholds, severities and `for:` windows), and the validator itself — every
 * rule that could silently drift is mutated here and must be reported. The thresholds
 * are cross-checked against `SLO_TARGETS` (the same numbers `/health` uses) and the
 * metric names against `registry.mjs`, so the rule file, the health endpoint and the
 * metrics cannot disagree.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { describe, it } from "node:test";

import {
  REQUEST_DURATION_SECONDS,
  REQUEST_FAILURES_TOTAL,
  REQUEST_TOTAL,
} from "../../monitoring/lib/registry.mjs";
import { REQUIRED_ALERTS, RULES_REL_PATH, parseRules, validateRules } from "../../monitoring/lib/rules.mjs";
import { SLO_TARGETS, SLO_WINDOW_TEXT, formatRatio, formatSeconds } from "../../monitoring/lib/slo.mjs";

const RULES_URL = new URL(`../../${RULES_REL_PATH}`, import.meta.url);

async function committedRules() {
  return parseRules(await readFile(fileURLToPath(RULES_URL), "utf8"));
}

/** The committed document, deep-cloned so a test can mutate it. */
async function mutableRules() {
  return structuredClone(await committedRules());
}

const alertNamed = (doc, name) => doc.groups[0].rules.find((rule) => rule.alert === name);

describe("rules — the committed rules file", () => {
  it("parses as YAML and passes validation with no problems", async () => {
    const report = validateRules(await committedRules());
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    assert.deepEqual([...report.groupNames], ["task-panel-slo"]);
  });

  it("pins exactly the three SLO alerts, their severities and their `for:` windows", async () => {
    assert.deepEqual(REQUIRED_ALERTS, [
      "TaskPanelAvailabilityBelowSLO",
      "TaskPanelErrorRate5xxAboveBudget",
      "TaskPanelP95LatencyAboveBudget",
    ]);

    const report = validateRules(await committedRules());
    assert.deepEqual(Object.keys(report.alerts).sort(), [...REQUIRED_ALERTS].sort());
    assert.deepEqual(
      Object.fromEntries(Object.entries(report.alerts).map(([name, alert]) => [name, { for: alert.for, severity: alert.severity }])),
      {
        TaskPanelAvailabilityBelowSLO: { for: "5m", severity: "critical" },
        TaskPanelErrorRate5xxAboveBudget: { for: "5m", severity: "critical" },
        TaskPanelP95LatencyAboveBudget: { for: "10m", severity: "warning" },
      },
    );
  });

  it("encodes the thresholds `/health` uses, over the shared 5m window", async () => {
    const doc = await committedRules();
    const availability = alertNamed(doc, "TaskPanelAvailabilityBelowSLO").expr;
    assert.ok(availability.includes(REQUEST_FAILURES_TOTAL));
    assert.ok(availability.includes(REQUEST_TOTAL));
    assert.ok(availability.includes(formatRatio(1 - SLO_TARGETS.availabilityRatio)));

    const errors = alertNamed(doc, "TaskPanelErrorRate5xxAboveBudget").expr;
    assert.ok(errors.includes(REQUEST_TOTAL));
    assert.ok(errors.includes('status=~"5.."'));
    assert.ok(errors.includes(formatRatio(SLO_TARGETS.errorRatio5xx)));

    const latency = alertNamed(doc, "TaskPanelP95LatencyAboveBudget").expr;
    assert.ok(latency.includes(`${REQUEST_DURATION_SECONDS}_bucket`));
    assert.ok(latency.includes("histogram_quantile(0.95"));
    assert.ok(latency.includes(formatSeconds(SLO_TARGETS.p95LatencyMs)));

    for (const rule of doc.groups[0].rules) {
      assert.ok(rule.expr.includes(`[${SLO_WINDOW_TEXT}]`), `${rule.alert} must rate over [${SLO_WINDOW_TEXT}]`);
      assert.ok(typeof rule.annotations.summary === "string" && rule.annotations.summary.length > 0);
    }
  });
});

describe("rules — the validator", () => {
  it("reports a threshold that drifted away from SLO_TARGETS", async () => {
    const doc = await mutableRules();
    const availability = alertNamed(doc, "TaskPanelAvailabilityBelowSLO");
    availability.expr = availability.expr.replace("0.001", "0.01");
    const report = validateRules(doc);
    assert.equal(report.ok, false);
    assert.match(report.problems.join("\n"), /TaskPanelAvailabilityBelowSLO: .*0\.001/);
  });

  it("reports a metric name that no longer exists in the registry", async () => {
    const doc = await mutableRules();
    const errors = alertNamed(doc, "TaskPanelErrorRate5xxAboveBudget");
    errors.expr = errors.expr.replaceAll(REQUEST_TOTAL, "task_panel_requests_huh");
    const report = validateRules(doc);
    assert.equal(report.ok, false);
    assert.match(report.problems.join("\n"), /TaskPanelErrorRate5xxAboveBudget: .*task_panel_http_requests_total/);
  });

  it("reports a missing, unexpected or malformed alert", async () => {
    const missing = await mutableRules();
    missing.groups[0].rules = missing.groups[0].rules.filter((rule) => rule.alert !== "TaskPanelP95LatencyAboveBudget");
    const missingReport = validateRules(missing);
    assert.equal(missingReport.ok, false);
    assert.match(missingReport.problems.join("\n"), /missing alert\(s\): TaskPanelP95LatencyAboveBudget/);

    const extra = await mutableRules();
    extra.groups[0].rules.push({ ...extra.groups[0].rules[0], alert: "TaskPanelMadeUp" });
    const extraReport = validateRules(extra);
    assert.equal(extraReport.ok, false);
    assert.match(extraReport.problems.join("\n"), /unexpected alert\(s\): TaskPanelMadeUp/);

    const malformed = await mutableRules();
    const availability = alertNamed(malformed, "TaskPanelAvailabilityBelowSLO");
    availability.for = "soon";
    availability.labels.severity = "very-loud";
    const malformedReport = validateRules(malformed);
    assert.equal(malformedReport.ok, false);
    assert.match(malformedReport.problems.join("\n"), /TaskPanelAvailabilityBelowSLO: .*for/);
    assert.match(malformedReport.problems.join("\n"), /TaskPanelAvailabilityBelowSLO: .*severity/);
  });

  it("reports a document that is not a rule group at all", () => {
    for (const doc of [null, {}, { groups: "nope" }, { groups: [] }, { groups: [{ rules: [] }] }]) {
      const report = validateRules(doc);
      assert.equal(report.ok, false, JSON.stringify(doc));
      assert.ok(report.problems.length > 0);
    }
  });
});
