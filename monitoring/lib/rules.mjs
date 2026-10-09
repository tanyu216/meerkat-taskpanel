/**
 * The Prometheus alerting rules: parsing them, and — the point of this module — checking
 * that the committed YAML still agrees with the code.
 *
 * An alerting rule is a *copy* of a threshold. Copies drift: someone relaxes
 * `SLO_TARGETS.availabilityRatio` to 99% and the rule keeps alerting (or stops) at the
 * old number, silently. So `ALERT_SPECS` is derived from `SLO_TARGETS` and the registry's
 * metric names, and `validateRules()` fails when an expression no longer carries them.
 * The rule names, severities and `for:` windows are pinned the same way.
 *
 * `validateRules` is pure — the caller reads the file — so a test can mutate a parsed
 * document and assert every drift is caught.
 */

import { REQUEST_DURATION_SECONDS, REQUEST_FAILURES_TOTAL, REQUEST_TOTAL } from "./registry.mjs";
import { SLO_TARGETS, SLO_WINDOW_TEXT, formatRatio, formatSeconds } from "./slo.mjs";
import { parseYaml } from "./yaml.mjs";

/** Where the rules file lives, relative to the repository root. */
export const RULES_REL_PATH = "monitoring/prometheus/task-panel.rules.yml";
/** Where compose mounts it inside the Prometheus container. */
export const RULES_PATH_IN_CONTAINER = "/etc/prometheus/rules/task-panel.rules.yml";
/** The single group the rules live in. */
export const RULES_GROUP_NAME = "task-panel-slo";

/** Exactly the alerts that must exist, and nothing else. */
export const REQUIRED_ALERTS = Object.freeze([
  "TaskPanelAvailabilityBelowSLO",
  "TaskPanelErrorRate5xxAboveBudget",
  "TaskPanelP95LatencyAboveBudget",
]);

/** A `for:` value: a duration such as `5m`. */
export const FOR_PATTERN = /^\d+[smhd]$/u;
/** The severities the validator accepts. */
export const SEVERITIES = Object.freeze(["critical", "warning", "info"]);

/**
 * What each alert must say. Every threshold token here is *computed* from `SLO_TARGETS`,
 * so relaxing a target turns the committed rule red until it is updated too.
 */
export const ALERT_SPECS = Object.freeze([
  Object.freeze({
    name: "TaskPanelAvailabilityBelowSLO",
    severity: "critical",
    for: "5m",
    metrics: [REQUEST_FAILURES_TOTAL, REQUEST_TOTAL],
    thresholds: [formatRatio(1 - SLO_TARGETS.availabilityRatio)],
    fragments: ["sum", "rate"],
  }),
  Object.freeze({
    name: "TaskPanelErrorRate5xxAboveBudget",
    severity: "critical",
    for: "5m",
    metrics: [REQUEST_TOTAL],
    thresholds: [formatRatio(SLO_TARGETS.errorRatio5xx)],
    fragments: ['status=~"5.."'],
  }),
  Object.freeze({
    name: "TaskPanelP95LatencyAboveBudget",
    severity: "warning",
    for: "10m",
    metrics: [`${REQUEST_DURATION_SECONDS}_bucket`],
    thresholds: [formatSeconds(SLO_TARGETS.p95LatencyMs)],
    fragments: ["histogram_quantile(0.95"],
  }),
]);

/** Parse the rules document (a thin alias so callers import one module). */
export function parseRules(text) {
  return parseYaml(text);
}

/**
 * Validate a parsed rules document.
 *
 * @param {unknown} doc the parsed YAML
 * @param {{specs?: typeof ALERT_SPECS, windowText?: string}} [options]
 * @returns {{ok: boolean, problems: string[], alerts: Record<string, object>, groupNames: string[]}}
 */
export function validateRules(doc, { specs = ALERT_SPECS, windowText = SLO_WINDOW_TEXT } = {}) {
  const problems = [];
  const alerts = {};
  const groupNames = [];

  const groups = doc?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return { ok: false, problems: ["the document must have a non-empty `groups:` list"], alerts, groupNames };
  }

  for (const [index, group] of groups.entries()) {
    if (group === null || typeof group !== "object" || Array.isArray(group)) {
      problems.push(`group ${index + 1} must be a mapping`);
      continue;
    }
    if (typeof group.name !== "string" || group.name === "") problems.push(`group ${index + 1} must carry a name`);
    else groupNames.push(group.name);

    if (!Array.isArray(group.rules) || group.rules.length === 0) {
      problems.push(`group ${group.name ?? index + 1} must have a non-empty rules list`);
      continue;
    }

    for (const rule of group.rules) {
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
        problems.push(`every rule in ${group.name ?? `group ${index + 1}`} must be a mapping`);
        continue;
      }
      const name = rule.alert;
      if (typeof name !== "string" || name === "") {
        problems.push("every rule must carry an `alert` name");
        continue;
      }
      alerts[name] = {
        group: group.name,
        expr: rule.expr,
        for: rule.for,
        severity: rule.labels?.severity,
        summary: rule.annotations?.summary,
      };
      problems.push(...checkRule(rule, name, { specs, windowText }));
    }
  }

  const expected = specs.map((spec) => spec.name);
  const missing = expected.filter((name) => !(name in alerts));
  const unexpected = Object.keys(alerts).filter((name) => !expected.includes(name));
  if (missing.length > 0) problems.push(`missing alert(s): ${missing.join(", ")}`);
  if (unexpected.length > 0) problems.push(`unexpected alert(s): ${unexpected.join(", ")}`);

  return { ok: problems.length === 0, problems, alerts, groupNames };
}

/** The per-rule checks: shape, then every pinned token the expression must carry. */
function checkRule(rule, name, { specs, windowText }) {
  const problems = [];

  if (typeof rule.expr !== "string" || rule.expr.trim() === "") {
    problems.push(`${name}: expr must be a non-empty string`);
    return problems;
  }
  const expr = rule.expr;

  if (typeof rule.for !== "string" || !FOR_PATTERN.test(rule.for)) problems.push(`${name}: for must be a duration such as 5m`);
  const severity = rule.labels?.severity;
  if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
    problems.push(`${name}: labels.severity must be one of ${SEVERITIES.join(" / ")}`);
  }
  if (typeof rule.annotations?.summary !== "string" || rule.annotations.summary === "") {
    problems.push(`${name}: annotations.summary must be a non-empty string`);
  }
  if (!expr.includes(`[${windowText}]`)) problems.push(`${name}: expr must rate over [${windowText}]`);

  const spec = specs.find((entry) => entry.name === name);
  if (spec === undefined) return problems; // an unexpected alert is reported by the caller

  if (rule.for !== spec.for) problems.push(`${name}: for must be ${spec.for}`);
  if (spec.severity !== undefined && severity !== spec.severity) problems.push(`${name}: severity must be ${spec.severity}`);
  for (const metric of spec.metrics) {
    if (!expr.includes(metric)) problems.push(`${name}: expr must reference ${metric}`);
  }
  for (const threshold of spec.thresholds) {
    if (!expr.includes(threshold)) problems.push(`${name}: expr must threshold at ${threshold} (from SLO_TARGETS)`);
  }
  for (const fragment of spec.fragments) {
    if (!expr.includes(fragment)) problems.push(`${name}: expr must contain ${JSON.stringify(fragment)}`);
  }
  return problems;
}
