#!/usr/bin/env node
/**
 * The dependency-security gate.
 *
 * Scanners produce evidence; this decides what it means. It reads the JSON reports of
 * osv-scanner and of `npm audit`, normalises them into one finding shape, and applies the
 * policy the project agreed on:
 *
 *   * an advisory at **CVSS >= 7.0** (High or Critical) blocks;
 *   * a waiver releases a block, but only if it is unexpired and was granted for no more
 *     than **90 days** — **30 days** for a Critical;
 *   * a block **never fails the run by itself**. The gate exits non-zero only when
 *     `SCAN_STRICT=1` is set (or `--strict` is passed), so the scheduled jobs can alert
 *     without turning a known advisory into a red build.
 *
 * Exit codes:
 *   0  the gate ran; nothing unwaived is blocking (findings may still be reported)
 *   1  `SCAN_STRICT=1`/`--strict` and at least one unwaived High/Critical advisory
 *   2  a usage error, or no scanner report could be read at all — a scan that never ran is
 *      not a pass, so this fails even in the default alert-only mode
 *
 * Node builtins only; no network, no dependencies, no clock other than the one it is
 * given (default: today, UTC).
 *
 *   node scripts/security/scan-gate.mjs --input osv-results.json --input npm-audit.json \
 *        --waivers scripts/security/waivers.json --summary "$GITHUB_STEP_SUMMARY"
 */

import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** An advisory at or above this CVSS base score blocks. */
export const CVSS_BLOCK_THRESHOLD = 7.0;

/** The longest window a waiver may be granted for, by severity. */
export const WAIVER_MAX_DAYS = Object.freeze({ critical: 30, default: 90 });

/** A waiver without a real reason is not a waiver. */
export const MIN_WAIVER_REASON_LENGTH = 8;

/** The environment variable that turns alerting into enforcement. */
export const STRICT_ENV = "SCAN_STRICT";

/** Process exit codes, named so the tests and the docs can agree on them. */
export const EXIT = Object.freeze({ PASS: 0, BLOCKED: 1, USAGE: 2 });

/**
 * This repository commits exactly one lockfile — `web/package-lock.json`, which pins the
 * board frontend's build-time devDependencies. An npm audit report does not name the
 * lockfile it came from, so findings from it are labelled with this path. It is a label
 * for the summary, not a path the gate ever opens.
 */
export const NPM_AUDIT_MANIFEST = "web/package-lock.json";

/** A failure of the gate itself (bad usage, unreadable ledger) — never a finding. */
export class ScanGateError extends Error {
  /**
   * @param {string} code short machine-readable code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ScanGateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/** Severity bands, highest first, with the CVSS score each starts at. */
const SEVERITY_BANDS = Object.freeze([
  { min: 9.0, name: "critical" },
  { min: 7.0, name: "high" },
  { min: 4.0, name: "moderate" },
]);

/** Sort/display weight per severity: a higher rank is more severe. */
const SEVERITY_RANK = Object.freeze({ critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 });

/**
 * The CVSS band a score falls in.
 *
 * @param {unknown} score
 * @returns {"critical"|"high"|"moderate"|"low"|"unknown"} `unknown` only when there is no
 *   usable score at all — a score of 0 is `low`, not `unknown`
 */
export function severityFromScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0) return "unknown";
  for (const band of SEVERITY_BANDS) {
    if (score >= band.min) return band.name;
  }
  return "low";
}

/**
 * The band a scanner-labelled severity maps to.
 *
 * @param {unknown} label
 * @returns {"critical"|"high"|"moderate"|"low"|"unknown"}
 */
export function severityFromLabel(label) {
  const text = String(label ?? "").trim().toLowerCase();
  if (text === "critical") return "critical";
  if (text === "high") return "high";
  if (text === "moderate" || text === "medium") return "moderate";
  if (text === "low") return "low";
  return "unknown";
}

/**
 * Whether a severity is one the policy blocks on.
 *
 * @param {string} severity
 * @returns {boolean}
 */
export function blocksSeverity(severity) {
  return severity === "critical" || severity === "high";
}

/**
 * Whether `SCAN_STRICT` asks for enforcement.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStrictEnv(value) {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// CVSS
// ---------------------------------------------------------------------------

/** CVSS v3 base-metric weights (CVSS v3.0 and v3.1 share this formula). */
const CVSS3 = Object.freeze({
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  PR_UNCHANGED: { N: 0.85, L: 0.62, H: 0.27 },
  PR_CHANGED: { N: 0.85, L: 0.68, H: 0.5 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
});

/**
 * The CVSS v3.1 defined `Roundup`: round up to one decimal place, without floating-point
 * drift deciding the boundary.
 *
 * @param {number} input
 * @returns {number}
 */
function roundUp(input) {
  const intInput = Math.round(input * 100000);
  if (intInput % 10000 === 0) return intInput / 100000;
  return (Math.floor(intInput / 10000) + 1) / 10;
}

/**
 * The CVSS v3.0/v3.1 base score of a vector string.
 *
 * Temporal and environmental metrics, if present, are ignored — the gate blocks on the
 * base score, which is the one a CVE database publishes and the one a waiver can be
 * argued about.
 *
 * @param {unknown} vector e.g. `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`
 * @returns {number|null} `null` when the vector is not a scoreable v3 base vector
 */
export function cvssV3BaseScore(vector) {
  if (typeof vector !== "string") return null;
  const text = vector.trim();
  const parts = text.split("/");
  if (!/^cvss:3\.[01]$/i.test(parts[0] ?? "")) return null;

  /** @type {Record<string, string>} */
  const metrics = {};
  for (const part of parts.slice(1)) {
    const colon = part.indexOf(":");
    if (colon <= 0) return null;
    metrics[part.slice(0, colon).toUpperCase()] = part.slice(colon + 1).toUpperCase();
  }

  const scopeChanged = metrics.S === "C";
  if (metrics.S !== "U" && metrics.S !== "C") return null;

  const av = CVSS3.AV[metrics.AV];
  const ac = CVSS3.AC[metrics.AC];
  const ui = CVSS3.UI[metrics.UI];
  const pr = (scopeChanged ? CVSS3.PR_CHANGED : CVSS3.PR_UNCHANGED)[metrics.PR];
  const c = CVSS3.CIA[metrics.C];
  const i = CVSS3.CIA[metrics.I];
  const a = CVSS3.CIA[metrics.A];
  if ([av, ac, ui, pr, c, i, a].some((weight) => weight === undefined)) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return roundUp(raw);
}

/**
 * Score a CVSS vector string. Only v3 vectors are scored: a v4 base score needs the v4
 * macro-vector tables, and a v2 "vector" carries no version prefix, so an advisory that
 * offers only those is left unscored and falls back to its severity label.
 *
 * @param {unknown} vector
 * @returns {number|null}
 */
export function scoreFromVector(vector) {
  return cvssV3BaseScore(vector);
}

/**
 * Read a plain CVSS base score out of a value that is, or looks like, a number.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function numericScore(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 10 ? parsed : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** @returns {boolean} whether `value` is a plain object */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {unknown[]} `value` when it is an array, otherwise an empty one */
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/** A deterministic string comparison — no locale, no surprises. */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// osv-scanner reports
// ---------------------------------------------------------------------------

/**
 * The severity of one OSV vulnerability record, most authoritative source first:
 * a numeric score, a v3 vector, then the advisory's own label.
 *
 * @param {Record<string, unknown>} vuln
 * @returns {{score: number|null, severity: string, scoreSource: string|null}}
 */
function osvSeverity(vuln) {
  let score = null;
  let scoreSource = null;

  for (const entry of arrayOf(vuln.severity)) {
    if (!isObject(entry)) continue;
    const type = String(entry.type ?? "").toUpperCase();
    const raw = entry.score;

    const direct = numericScore(raw);
    if (direct !== null && (score === null || direct > score)) {
      score = direct;
      scoreSource = type || "score";
      continue;
    }
    const derived = scoreFromVector(raw);
    if (derived !== null && (score === null || derived > score)) {
      score = derived;
      scoreSource = type;
    }
  }

  if (score !== null) return { score, severity: severityFromScore(score), scoreSource };

  const database = isObject(vuln.database_specific) ? vuln.database_specific : {};
  const ecosystem = isObject(vuln.ecosystem_specific) ? vuln.ecosystem_specific : {};
  const nested = numericScore(isObject(database.cvss) ? database.cvss.score : null);
  if (nested !== null) return { score: nested, severity: severityFromScore(nested), scoreSource: "database_specific.cvss" };

  const label = severityFromLabel(database.severity ?? ecosystem.severity);
  return { score: null, severity: label, scoreSource: label === "unknown" ? null : "label" };
}

/**
 * Parse an osv-scanner `--format json` report.
 *
 * Never throws: a report that is not shaped like an osv report comes back as `errors`, so
 * the caller decides whether that is fatal. Nulls inside the arrays are skipped rather
 * than crashing the gate.
 *
 * @param {unknown} doc
 * @returns {{findings: object[], errors: string[]}}
 */
export function parseOsvReport(doc) {
  const results = isObject(doc) && Array.isArray(doc.results) ? doc.results : null;
  if (results === null) return { findings: [], errors: ["osv: report has no `results` array"] };

  /** @type {object[]} */
  const findings = [];
  for (const result of results) {
    if (!isObject(result)) continue;
    const manifest = isObject(result.source) && typeof result.source.path === "string" ? result.source.path : null;

    for (const entry of arrayOf(result.packages)) {
      if (!isObject(entry)) continue;
      const pkg = isObject(entry.package) ? entry.package : {};

      for (const vuln of arrayOf(entry.vulnerabilities)) {
        if (!isObject(vuln)) continue;
        const { score, severity, scoreSource } = osvSeverity(vuln);
        findings.push({
          source: "osv",
          id: typeof vuln.id === "string" && vuln.id !== "" ? vuln.id : null,
          aliases: arrayOf(vuln.aliases).filter((alias) => typeof alias === "string"),
          package: typeof pkg.name === "string" ? pkg.name : null,
          version: typeof pkg.version === "string" ? pkg.version : null,
          ecosystem: typeof pkg.ecosystem === "string" ? pkg.ecosystem : null,
          title: typeof vuln.summary === "string" ? vuln.summary : null,
          manifest,
          score,
          scoreSource,
          severity,
        });
      }
    }
  }

  return { findings: dedupeFindings(findings), errors: [] };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = [finding.source, finding.id, finding.package, finding.version, finding.score].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// npm audit reports
// ---------------------------------------------------------------------------

/**
 * The GHSA identifier an npm advisory URL points at, if it is one.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
function ghsaFromUrl(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  return match === null ? null : match[0];
}

/**
 * Parse an `npm audit --json` report.
 *
 * npm reports a package, and under `via` the advisories that make it vulnerable. Each
 * advisory becomes a finding with its **own** severity (npm's `cvss` block, else its
 * label); a package whose `via` holds only strings is a transitive entry, and is reported
 * once with npm's aggregate severity for that package — which is the number npm itself
 * gates `--audit-level` on.
 *
 * @param {unknown} doc
 * @param {{manifest?: string}} [options]
 * @returns {{findings: object[], errors: string[]}}
 */
export function parseNpmAuditReport(doc, options = {}) {
  const map = isObject(doc) && isObject(doc.vulnerabilities) ? doc.vulnerabilities : null;
  if (map === null) return { findings: [], errors: ["npm-audit: report has no `vulnerabilities` map"] };

  const manifest = typeof options.manifest === "string" ? options.manifest : NPM_AUDIT_MANIFEST;
  /** @type {object[]} */
  const findings = [];

  for (const entry of Object.values(map)) {
    if (!isObject(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name : null;
    const aggregate = severityFromLabel(entry.severity);
    const advisories = arrayOf(entry.via).filter(isObject);

    if (advisories.length === 0) {
      findings.push({
        source: "npm",
        id: null,
        aliases: [],
        package: name,
        version: null,
        ecosystem: "npm",
        title: name === null ? null : `${name} is vulnerable`,
        manifest,
        range: typeof entry.range === "string" ? entry.range : null,
        score: null,
        scoreSource: aggregate === "unknown" ? null : "label",
        severity: aggregate,
      });
      continue;
    }

    for (const advisory of advisories) {
      const cvss = isObject(advisory.cvss) ? advisory.cvss : {};
      const score = numericScore(cvss.score) ?? scoreFromVector(cvss.vectorString);
      const id = ghsaFromUrl(advisory.url) ?? (advisory.source === undefined ? null : String(advisory.source));
      findings.push({
        source: "npm",
        id,
        aliases: [],
        package: name,
        version: null,
        ecosystem: "npm",
        title: typeof advisory.title === "string" ? advisory.title : null,
        manifest,
        range: typeof entry.range === "string" ? entry.range : null,
        score,
        scoreSource: score === null ? "label" : "advisory",
        severity: score === null ? severityFromLabel(advisory.severity) : severityFromScore(score),
      });
    }
  }

  return { findings: dedupeFindings(findings), errors: [] };
}

// ---------------------------------------------------------------------------
// Report dispatch
// ---------------------------------------------------------------------------

/**
 * Identify which scanner wrote a report.
 *
 * @param {unknown} doc
 * @returns {"osv"|"npm"|null}
 */
export function detectFormat(doc) {
  if (!isObject(doc)) return null;
  if (typeof doc.auditReportVersion === "number") return "npm";
  if (isObject(doc.vulnerabilities) && isObject(doc.metadata?.vulnerabilities)) return "npm";
  if (Array.isArray(doc.results)) return "osv";
  return null;
}

/**
 * Parse a scanner report, auto-detecting its format unless one is forced.
 *
 * @param {unknown} doc
 * @param {"auto"|"osv"|"npm"} [format]
 * @param {{manifest?: string}} [options]
 * @returns {{findings: object[], errors: string[], format: "osv"|"npm"|null}}
 */
export function parseReport(doc, format = "auto", options = {}) {
  if (format !== "auto" && format !== "osv" && format !== "npm") {
    return { findings: [], errors: [`unknown report format: ${format}`], format: null };
  }

  const resolved = format === "auto" ? detectFormat(doc) : format;
  if (resolved === null) {
    return { findings: [], errors: ["unrecognised report: not an osv-scanner or npm audit JSON document"], format: null };
  }

  const parsed = resolved === "osv" ? parseOsvReport(doc) : parseNpmAuditReport(doc, options);
  return { findings: parsed.findings, errors: parsed.errors, format: resolved };
}

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` — the only date shape a waiver may use. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` date to UTC midnight.
 *
 * @param {unknown} value
 * @returns {number|null} epoch ms, or `null` for anything else (including an impossible
 *   date such as `2026-02-31`)
 */
export function parseDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!DATE_PATTERN.test(text)) return null;

  const parsed = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === text ? parsed : null;
}

/**
 * Whole days from `from` to `to` (negative when `to` is earlier).
 *
 * @param {number} from epoch ms
 * @param {number} to epoch ms
 * @returns {number}
 */
export function daysBetween(from, to) {
  return Math.round((to - from) / 86400000);
}

/**
 * Read a waiver ledger: `{ "waivers": [ ... ] }`, or a bare array of the same entries.
 *
 * A structurally broken entry is kept, flagged `valid: false` and given an
 * `invalidReason`, rather than dropped — a waiver that quietly disappears is worse than
 * one that is loudly ignored, because the advisory it covered starts blocking again.
 *
 * @param {unknown} doc
 * @returns {{waivers: object[], errors: string[]}}
 */
export function parseWaiverLedger(doc) {
  const list = Array.isArray(doc) ? doc : isObject(doc) && Array.isArray(doc.waivers) ? doc.waivers : null;
  if (list === null) return { waivers: [], errors: ["waivers: expected a `{ \"waivers\": [ ... ] }` ledger (or a bare array)"] };

  /** @type {object[]} */
  const waivers = [];
  /** @type {string[]} */
  const errors = [];

  list.forEach((entry, index) => {
    const waiver = normalizeWaiver(entry, index);
    if (waiver.valid !== true) errors.push(`waivers[${index}] (${waiver.id || "no id"}): ${waiver.invalidReason}`);
    waivers.push(waiver);
  });

  return { waivers, errors };
}

/**
 * Normalise one ledger entry, deciding whether it is structurally usable at all.
 *
 * Idempotent, so `evaluateGate` can run it over entries that a caller built by hand as
 * well as over the ones `parseWaiverLedger` already produced.
 *
 * @param {unknown} entry
 * @param {number} [index]
 * @returns {object}
 */
function normalizeWaiver(entry, index = 0) {
  const source = isObject(entry) ? entry : {};
  const waiver = {
    id: typeof source.id === "string" ? source.id.trim() : "",
    package: typeof source.package === "string" && source.package.trim() !== "" ? source.package.trim() : null,
    reason: typeof source.reason === "string" ? source.reason.trim() : "",
    granted: typeof source.granted === "string" ? source.granted.trim() : "",
    expires: typeof source.expires === "string" ? source.expires.trim() : "",
    valid: true,
    invalidReason: null,
  };

  const problems = [];
  if (waiver.id === "") problems.push("missing `id`");
  if (waiver.reason.length < MIN_WAIVER_REASON_LENGTH) {
    problems.push(`\`reason\` must be at least ${MIN_WAIVER_REASON_LENGTH} characters saying why this is acceptable`);
  }
  const granted = parseDate(waiver.granted);
  const expires = parseDate(waiver.expires);
  if (granted === null) problems.push("`granted` must be a YYYY-MM-DD date");
  if (expires === null) problems.push("`expires` must be a YYYY-MM-DD date");
  if (granted !== null && expires !== null && expires < granted) problems.push("`expires` is before `granted`");

  if (problems.length > 0) {
    waiver.valid = false;
    waiver.invalidReason = problems.join("; ");
  }
  return waiver;
}

/** The longest window a waiver may be granted for, given what it covers. */
function waiverCapFor(severity) {
  return severity === "critical" ? WAIVER_MAX_DAYS.critical : WAIVER_MAX_DAYS.default;
}

/** Whether a waiver names this finding — by id or alias, and, if scoped, by package. */
function waiverApplies(waiver, finding) {
  if (waiver.package !== null && waiver.package !== "*" && waiver.package !== finding.package) return false;
  const targets = [finding.id, ...arrayOf(finding.aliases)]
    .filter((value) => typeof value === "string" && value !== "")
    .map((value) => value.toLowerCase());
  return targets.includes(waiver.id.toLowerCase());
}

/**
 * Whether a structurally valid waiver still covers this finding on this date: not yet in
 * effect is refused, past its expiry is refused, and so is a window longer than the cap
 * for the severity it covers (Critical 30 days, everything else 90) — that cap is what
 * stops a waiver from becoming a permanent exception.
 *
 * @param {object} waiver
 * @param {object} finding
 * @param {number} nowMs
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function checkWaiverWindow(waiver, finding, nowMs) {
  const granted = parseDate(waiver.granted);
  const expires = parseDate(waiver.expires);
  if (granted === null || expires === null) return { ok: false, reason: "waiver has an unreadable date" };
  if (granted > nowMs) return { ok: false, reason: `waiver was granted ${waiver.granted}, in the future` };
  if (nowMs > expires) return { ok: false, reason: `waiver expired on ${waiver.expires}` };

  const days = daysBetween(granted, expires);
  const cap = waiverCapFor(finding.severity);
  if (days > cap) {
    return { ok: false, reason: `waiver window ${days} days exceeds the ${cap}-day cap for ${finding.severity} severity` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Today, UTC, as `YYYY-MM-DD`. */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Apply the policy to a set of findings.
 *
 * Pure: the inputs are not mutated, and the clock is a parameter (a `YYYY-MM-DD` string or
 * epoch ms), so the same input always yields the same decision.
 *
 * @param {object} options
 * @param {object[]} [options.findings] normalised findings, from the parsers
 * @param {object[]} [options.waivers] from `parseWaiverLedger`
 * @param {string|number} [options.now] defaults to today, UTC
 * @param {boolean} [options.strict] enforce the threshold with a non-zero exit
 * @param {boolean} [options.blockUnknown] also block findings whose severity cannot be read
 * @param {number} [options.threshold]
 * @param {string[]} [options.scanErrors] problems the parsers reported
 * @returns {object} the decision
 */
export function evaluateGate(options = {}) {
  const {
    findings = [],
    waivers = [],
    strict = false,
    blockUnknown = false,
    threshold = CVSS_BLOCK_THRESHOLD,
    scanErrors = [],
  } = options;

  const nowMs = typeof options.now === "number" ? options.now : (parseDate(options.now ?? todayUtc()) ?? parseDate(todayUtc()));
  const now = new Date(nowMs).toISOString().slice(0, 10);
  const ledger = waivers.map((entry, index) => normalizeWaiver(entry, index));

  const evaluated = findings.map((finding) => {
    const severity = typeof finding.severity === "string" && finding.severity !== "" ? finding.severity : severityFromScore(finding.score);
    const blocking = blocksSeverity(severity) || (blockUnknown && severity === "unknown");

    const annotated = { ...finding, severity, blocking, status: "advisory", waiver: null, waiverRejected: null };
    if (!blocking) {
      annotated.status = severity === "unknown" ? "unknown" : "advisory";
      return annotated;
    }

    /** @type {string[]} */
    const rejected = [];
    for (const waiver of ledger) {
      if (!waiverApplies(waiver, annotated)) continue;
      if (waiver.valid !== true) {
        rejected.push(`${waiver.id}: ${waiver.invalidReason}`);
        continue;
      }
      const verdict = checkWaiverWindow(waiver, annotated, nowMs);
      if (verdict.ok) {
        annotated.status = "waived";
        annotated.waiver = waiver;
        return annotated;
      }
      rejected.push(`${waiver.id}: ${verdict.reason}`);
    }

    annotated.status = "blocked";
    annotated.waiverRejected = rejected.length > 0 ? rejected.join("; ") : null;
    return annotated;
  });

  evaluated.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.score ?? -1) - (a.score ?? -1) ||
      compareText(String(a.package), String(b.package)) ||
      compareText(String(a.id), String(b.id)),
  );

  const blocked = evaluated.filter((finding) => finding.status === "blocked");
  const waived = evaluated.filter((finding) => finding.status === "waived");
  const advisory = evaluated.filter((finding) => finding.status === "advisory");
  const unknown = evaluated.filter((finding) => finding.status === "unknown");

  return {
    policy: {
      threshold,
      strict,
      mode: strict ? "strict" : "alert-only",
      blockUnknown,
      maxWaiverDays: { ...WAIVER_MAX_DAYS },
      now,
    },
    findings: evaluated,
    blocked,
    waived,
    advisory,
    unknown,
    scanErrors: [...scanErrors],
    counts: {
      total: evaluated.length,
      blocked: blocked.length,
      waived: waived.length,
      advisory: advisory.length,
      unknown: unknown.length,
    },
    ok: blocked.length === 0,
    exitCode: strict && blocked.length > 0 ? EXIT.BLOCKED : EXIT.PASS,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One line describing a finding. */
function findingLine(finding) {
  const where = [finding.package, finding.version].filter(Boolean).join("@");
  const score = finding.score === null || finding.score === undefined ? "—" : finding.score.toFixed(1);
  const extras = [];
  if (finding.status === "waived" && finding.waiver !== null) extras.push(`waiver expires ${finding.waiver.expires}`);
  if (finding.waiverRejected !== null) extras.push(`waiver refused: ${finding.waiverRejected}`);
  return [
    finding.status.padEnd(8),
    finding.severity.padEnd(8),
    score.padStart(4),
    where.padEnd(24),
    finding.id ?? "(no advisory id)",
    finding.manifest ?? "—",
    extras.join(" / "),
  ]
    .join("  ")
    .trimEnd();
}

/**
 * The human-readable verdict.
 *
 * @param {object} decision
 * @returns {string[]} lines
 */
export function renderText(decision) {
  const { counts, policy } = decision;
  const lines = [
    `scan-gate: ${counts.total} findings — ${counts.blocked} blocked, ${counts.waived} waived, ${counts.advisory} below threshold, ${counts.unknown} unscored (mode: ${policy.mode})`,
  ];

  if (decision.findings.length > 0) {
    lines.push("  status   severity  cvss  package                  advisory");
    for (const finding of decision.findings) lines.push(`  ${findingLine(finding)}`);
  } else {
    lines.push("  no findings");
  }

  for (const error of decision.scanErrors) lines.push(`  scan-error: ${error}`);
  return lines;
}

/**
 * The GitHub step summary — the durable record of what the gate decided and why.
 *
 * @param {object} decision
 * @returns {string} markdown
 */
export function renderSummary(decision) {
  const { counts, policy } = decision;
  const lines = [
    "## Dependency security scan",
    "",
    `**Gate:** CVSS >= ${policy.threshold.toFixed(1)} blocks · waivers up to ${policy.maxWaiverDays.default} days (Critical ${policy.maxWaiverDays.critical}) · mode: **${policy.mode}** · evaluated ${policy.now}`,
    "",
  ];

  if (counts.blocked === 0 && counts.total === 0) {
    lines.push("No unwaived High/Critical advisories. Nothing blocks.", "");
  } else {
    lines.push(
      counts.blocked === 0
        ? "No unwaived High/Critical advisories. Nothing blocks."
        : `${counts.blocked} unwaived High/Critical ${counts.blocked === 1 ? "advisory" : "advisories"} ${policy.strict ? "blocked the run" : "would block (set `SCAN_STRICT=1` to enforce)"}.`,
      "",
    );
  }

  if (decision.findings.length > 0) {
    lines.push("| Status | Severity | CVSS | Package | Advisory | Manifest | Note |", "|---|---|---|---|---|---|---|");
    for (const finding of decision.findings) {
      const where = [finding.package, finding.version].filter(Boolean).join("@");
      const note =
        finding.status === "waived" && finding.waiver !== null
          ? `waived until ${finding.waiver.expires} — ${finding.waiver.reason}`
          : (finding.waiverRejected ?? "");
      lines.push(
        `| ${finding.status} | ${finding.severity} | ${finding.score === null || finding.score === undefined ? "" : finding.score.toFixed(1)} | ${where} | ${finding.id ?? ""} | ${finding.manifest ?? ""} | ${note} |`,
      );
    }
    lines.push("");
  }

  if (decision.scanErrors.length > 0) {
    lines.push("### Scanner problems", "");
    for (const error of decision.scanErrors) lines.push(`- ${error}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/security/scan-gate.mjs --input <report.json> [options]

Reads scanner JSON (osv-scanner and/or \`npm audit --json\`) and reports whether anything
unwaived is at or above CVSS ${CVSS_BLOCK_THRESHOLD.toFixed(1)}.

Options:
  --input <file>       a scanner report; repeat for osv-scanner + npm audit (required)
  --format <f>         auto (default) | osv | npm — force the parser for every --input
  --waivers <file>     the waiver ledger (default: scripts/security/waivers.json)
  --now <YYYY-MM-DD>   the date to evaluate waivers at (default: today, UTC)
  --strict             enforce the threshold with exit ${EXIT.BLOCKED} (same as ${STRICT_ENV}=1)
  --block-unknown      also block advisories whose severity cannot be read
  --json               print the decision as JSON on stdout
  --summary <file>     append a markdown summary (e.g. "$GITHUB_STEP_SUMMARY")
  --help               print this

Exit codes: ${EXIT.PASS} nothing blocking · ${EXIT.BLOCKED} strict and blocked · ${EXIT.USAGE} usage or no readable report

Environment: ${STRICT_ENV}=1 enforces the threshold; anything else alerts only.`;

/**
 * Read one `--input`, tolerating failure: a report that cannot be read is a scan problem,
 * which the caller reports, not a crash.
 *
 * @param {string} file
 * @param {"auto"|"osv"|"npm"} format
 * @returns {Promise<{ok: true, findings: object[], errors: string[]} | {ok: false, error: string}>}
 */
async function readReport(file, format) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    return { ok: false, error: `${file}: cannot read the report (${err.code ?? err.message})` };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${file}: not valid JSON (${err.message})` };
  }

  const parsed = parseReport(doc, format);
  return { ok: true, findings: parsed.findings, errors: parsed.errors.map((error) => `${file}: ${error}`) };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        input: { type: "string", multiple: true },
        format: { type: "string", default: "auto" },
        waivers: { type: "string" },
        now: { type: "string" },
        strict: { type: "boolean", default: false },
        "block-unknown": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        summary: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`scan-gate: ${err.message}\n\n${USAGE}\n`);
    return EXIT.USAGE;
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.PASS;
  }

  if (!["auto", "osv", "npm"].includes(values.format)) {
    process.stderr.write(`scan-gate: unknown --format "${values.format}" (expected auto, osv or npm)\n`);
    return EXIT.USAGE;
  }
  if (values.now !== undefined && parseDate(values.now) === null) {
    process.stderr.write(`scan-gate: --now must be a YYYY-MM-DD date, got "${values.now}"\n`);
    return EXIT.USAGE;
  }

  const inputs = values.input ?? [];
  if (inputs.length === 0) {
    process.stderr.write(`scan-gate: at least one --input is required\n\n${USAGE}\n`);
    return EXIT.USAGE;
  }

  /** @type {object[]} */
  const findings = [];
  /** @type {string[]} */
  const scanErrors = [];
  let readable = 0;

  for (const file of inputs) {
    const result = await readReport(file, values.format);
    if (!result.ok) {
      scanErrors.push(result.error);
      continue;
    }
    readable += 1;
    findings.push(...result.findings);
    scanErrors.push(...result.errors);
  }

  // A scan that produced nothing readable is not a pass, whatever the mode: there is no
  // evidence to gate on, and silently reporting "clean" would be the wrong answer.
  if (readable === 0) {
    process.stderr.write(
      `scan-gate: no scanner report could be read — refusing to report a pass on a scan that did not happen\n`,
    );
    for (const error of scanErrors) process.stderr.write(`  ${error}\n`);
    return EXIT.USAGE;
  }

  const waiversFile = values.waivers ?? null;
  /** @type {object[]} */
  let waivers = [];
  let waiverErrors = [];
  if (waiversFile !== null) {
    try {
      const ledger = JSON.parse(await readFile(waiversFile, "utf8"));
      ({ waivers, errors: waiverErrors } = parseWaiverLedger(ledger));
    } catch (err) {
      // A ledger that cannot be read means nothing is waived — fail closed, loudly.
      waiverErrors = [`${waiversFile}: cannot read the waiver ledger (${err.code ?? err.message})`];
    }
  }
  scanErrors.push(...waiverErrors);

  const strict = values.strict || isStrictEnv(process.env[STRICT_ENV]);
  const decision = evaluateGate({
    findings,
    waivers,
    now: values.now,
    strict,
    blockUnknown: values["block-unknown"],
    scanErrors,
  });

  // Scan problems are reported on stderr whatever the output mode, so `--json` keeps a
  // clean stdout while a missing or unreadable report is still impossible to miss.
  for (const error of decision.scanErrors) process.stderr.write(`scan-gate: scan-error: ${error}\n`);

  if (values.summary !== undefined) {
    try {
      await appendFile(values.summary, renderSummary(decision));
    } catch (err) {
      process.stderr.write(`scan-gate: cannot write --summary ${values.summary} (${err.code ?? err.message})\n`);
      return EXIT.USAGE;
    }
  }

  const report = (line) => process.stdout.write(`${line}\n`);
  if (values.json) {
    report(JSON.stringify(decision, null, 2));
  } else {
    for (const line of renderText(decision)) report(line);
  }

  if (decision.exitCode !== EXIT.PASS) {
    process.stderr.write(
      `scan-gate: BLOCKED — ${decision.counts.blocked} unwaived High/Critical ${decision.counts.blocked === 1 ? "advisory" : "advisories"} at or above CVSS ${decision.policy.threshold.toFixed(1)} (strict mode; see the summary for the waiver trail)\n`,
    );
  } else if (decision.counts.blocked > 0) {
    process.stderr.write(
      `scan-gate: ${decision.counts.blocked} unwaived High/Critical advisory ${decision.counts.blocked === 1 ? "is" : "are"} alerting only — set ${STRICT_ENV}=1 to fail the run\n`,
    );
  }

  return decision.exitCode;
}

// Guarded so the module can be imported by the test suite without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
