/**
 * Tests for `scripts/security/scan-gate.mjs` — the dependency-security gate.
 *
 * The gate turns scanner JSON into one verdict: a High/Critical advisory (CVSS >= 7.0)
 * blocks unless a waiver covers it, and it only *fails* the run when `SCAN_STRICT=1`.
 *
 * What is mocked: nothing but external I/O. The parsers, the CVSS arithmetic, the waiver
 * clock and the decision function are pure and are called directly; the CLI cases spawn
 * the real script against real files in a temp dir and pass an explicit `--now`, so no
 * case depends on the wall clock, the network or a scanner being installed.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe, it } from "node:test";

import {
  CVSS_BLOCK_THRESHOLD,
  EXIT,
  MIN_WAIVER_REASON_LENGTH,
  STRICT_ENV,
  WAIVER_MAX_DAYS,
  cvssV3BaseScore,
  daysBetween,
  detectFormat,
  evaluateGate,
  isStrictEnv,
  numericScore,
  parseDate,
  parseNpmAuditReport,
  parseOsvReport,
  parseReport,
  parseWaiverLedger,
  renderSummary,
  renderText,
  severityFromLabel,
  severityFromScore,
  scoreFromVector,
} from "./scan-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts", "security", "scan-gate.mjs");

/** Today, as the gate would default it — only used by the one case that asserts the default. */
const NOW = "2026-10-10";

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh temp dir, removed after the suite. */
async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "meerkat-taskpanel-scan-gate-"));
  tempDirs.push(dir);
  return dir;
}

/** Write `files` (`name → value`; a string is written verbatim) into a fresh temp dir. */
async function makeTree(files) {
  const dir = await makeTempDir();
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return dir;
}

/** Run the gate CLI. `env` is merged over a copy of the real environment. */
function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, [STRICT_ENV]: "", ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Fixtures — shaped like the real scanner output
// ---------------------------------------------------------------------------

/** A minimal osv-scanner JSON report around one advisory. */
function osvReport({ id = "GHSA-aaaa-bbbb-cccc", aliases = ["CVE-2026-1111"], vector, severity, dbSeverity, pkg = "left-pad", version = "1.0.0", path = "web/package-lock.json" } = {}) {
  const vuln = { id, aliases, summary: `${pkg} is vulnerable` };
  if (vector !== undefined || severity !== undefined) {
    vuln.severity = vector === undefined ? [] : [{ type: severity ?? "CVSS_V3", score: vector }];
  }
  if (dbSeverity !== undefined) vuln.database_specific = { severity: dbSeverity };

  return {
    results: [
      {
        source: { path, type: "lockfile" },
        packages: [{ package: { name: pkg, version, ecosystem: "npm" }, vulnerabilities: [vuln] }],
      },
    ],
  };
}

/** A minimal npm-audit JSON report around one vulnerable package. */
function npmReport({ name = "vite", via = [], severity = "high", range = "<=5.4.11" } = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities: { [name]: { name, severity, via, range, nodes: [`node_modules/${name}`], fixAvailable: true } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  };
}

/** A finding, as `evaluateGate` would receive it parsed. */
function finding(overrides = {}) {
  return {
    source: "osv",
    id: "GHSA-aaaa-bbbb-cccc",
    aliases: [],
    package: "left-pad",
    version: "1.0.0",
    ecosystem: "npm",
    title: "left-pad is vulnerable",
    manifest: "web/package-lock.json",
    score: 9.8,
    ...overrides,
  };
}

/**
 * A waiver ledger entry. The default window is 30 days and still in effect at `NOW`,
 * because the severity-wide cap is the Critical one (30); a case that wants a longer
 * window has to say so, which is exactly what the cap is for.
 */
function waiver(overrides = {}) {
  return { id: "GHSA-aaaa-bbbb-cccc", reason: "not reachable from the shipped runtime", granted: "2026-09-20", expires: "2026-10-20", ...overrides };
}

// ---------------------------------------------------------------------------
// CVSS v3 base score
// ---------------------------------------------------------------------------

describe("cvssV3BaseScore", () => {
  it("computes the published base score for well-known vectors", () => {
    const cases = [
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8], // log4shell
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5],
      ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8],
      ["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H", 5.9],
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0], // scope changed
      ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N", 6.5],
      ["CVSS:3.1/AV:P/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 6.8],
      ["CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8], // 3.0 shares the formula
    ];
    for (const [vector, expected] of cases) {
      assert.equal(cvssV3BaseScore(vector), expected, vector);
    }
  });

  it("ignores temporal/environmental metrics appended to a base vector", () => {
    assert.equal(cvssV3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H/E:P/RL:O/RC:C"), 9.8);
  });

  it("is 0.0 when the impact sub-score is zero", () => {
    assert.equal(cvssV3BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"), 0);
  });

  it("returns null for anything it cannot score, rather than guessing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
      "AV:N/AC:L/Au:N/C:P/I:P/A:P", // a v2 vector carries no prefix and is not scored here
      "CVSS:3.1/AV:N/AC:L/PR:N", // missing metrics
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:Z/I:H/A:H", // invalid metric value
      "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:X/C:H/I:H/A:H", // invalid scope
      42,
    ]) {
      assert.equal(cvssV3BaseScore(bad), null, String(bad));
    }
  });
});

describe("scoreFromVector", () => {
  it("scores v3 vectors and declines v4 vectors", () => {
    assert.equal(scoreFromVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"), 7.5);
    assert.equal(scoreFromVector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"), null);
  });
});

describe("numericScore", () => {
  it("accepts numbers and numeric strings in the CVSS range", () => {
    assert.equal(numericScore(7.5), 7.5);
    assert.equal(numericScore("7.5"), 7.5);
    assert.equal(numericScore(" 10 "), 10);
    assert.equal(numericScore(0), 0);
  });

  it("returns null for anything else", () => {
    for (const bad of [null, undefined, "", "high", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 11, -1, NaN, {}]) {
      assert.equal(numericScore(bad), null, String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// Severity bands
// ---------------------------------------------------------------------------

describe("severityFromScore", () => {
  it("maps a CVSS score onto the four bands, on the boundaries", () => {
    assert.equal(severityFromScore(10), "critical");
    assert.equal(severityFromScore(9.0), "critical");
    assert.equal(severityFromScore(8.9), "high");
    assert.equal(severityFromScore(7.0), "high");
    assert.equal(severityFromScore(6.9), "moderate");
    assert.equal(severityFromScore(4.0), "moderate");
    assert.equal(severityFromScore(3.9), "low");
    assert.equal(severityFromScore(0), "low");
  });

  it("returns `unknown` when there is no score at all", () => {
    for (const missing of [null, undefined, NaN, "7.5", {}]) {
      assert.equal(severityFromScore(missing), "unknown", String(missing));
    }
  });
});

describe("severityFromLabel", () => {
  it("recognises the scanner-labelled severities, case-insensitively", () => {
    assert.equal(severityFromLabel("CRITICAL"), "critical");
    assert.equal(severityFromLabel("high"), "high");
    assert.equal(severityFromLabel("Moderate"), "moderate");
    assert.equal(severityFromLabel("medium"), "moderate");
    assert.equal(severityFromLabel("LOW"), "low");
  });

  it("returns `unknown` for a missing or unrecognised label", () => {
    for (const bad of [null, "", "GARBAGE", 7]) {
      assert.equal(severityFromLabel(bad), "unknown", String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// osv-scanner report
// ---------------------------------------------------------------------------

describe("detectFormat", () => {
  it("tells an osv report from an npm-audit report, and rejects everything else", () => {
    assert.equal(detectFormat(osvReport()), "osv");
    assert.equal(detectFormat(npmReport()), "npm");
    assert.equal(detectFormat({ results: [] }), "osv");
    assert.equal(detectFormat({ auditReportVersion: 2, vulnerabilities: {} }), "npm");
    for (const bad of [null, undefined, [], "text", 42, {}]) {
      assert.equal(detectFormat(bad), null, JSON.stringify(bad));
    }
  });
});

describe("parseOsvReport", () => {
  it("extracts one finding per vulnerable package, with its score and severity", () => {
    const { findings, errors } = parseOsvReport(osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }));

    assert.deepEqual(errors, []);
    assert.equal(findings.length, 1);
    const [found] = findings;
    assert.equal(found.source, "osv");
    assert.equal(found.id, "GHSA-aaaa-bbbb-cccc");
    assert.deepEqual(found.aliases, ["CVE-2026-1111"]);
    assert.equal(found.package, "left-pad");
    assert.equal(found.version, "1.0.0");
    assert.equal(found.ecosystem, "npm");
    assert.equal(found.manifest, "web/package-lock.json");
    assert.equal(found.score, 9.8);
    assert.equal(found.severity, "critical");
  });

  it("reads a CVSS_V2 numeric score", () => {
    const { findings } = parseOsvReport(osvReport({ severity: "CVSS_V2", vector: "5.0" }));
    assert.equal(findings[0].score, 5);
    assert.equal(findings[0].severity, "moderate");
  });

  it("falls back to the database_specific severity label when no score can be computed", () => {
    const { findings } = parseOsvReport(osvReport({ severity: "CVSS_V4", vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", dbSeverity: "HIGH" }));
    assert.equal(findings[0].score, null);
    assert.equal(findings[0].severity, "high");
  });

  it("reports an unscored advisory with no label as `unknown`", () => {
    const { findings } = parseOsvReport(osvReport({ severity: "CVSS_V4", vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }));
    assert.equal(findings[0].severity, "unknown");
  });

  it("de-duplicates the same advisory reported for the same package twice", () => {
    const report = osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" });
    report.results.push(...report.results);
    const { findings } = parseOsvReport(report);
    assert.equal(findings.length, 1);
  });

  it("keeps the same advisory for two different packages as two findings", () => {
    const report = osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" });
    report.results[0].packages.push({ package: { name: "other-pkg", version: "2.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-aaaa-bbbb-cccc", aliases: [] }] });
    const { findings } = parseOsvReport(report);
    assert.deepEqual(findings.map((f) => f.package).sort(), ["left-pad", "other-pkg"]);
  });

  it("survives nulls in the results/packages/vulnerabilities arrays", () => {
    const { findings, errors } = parseOsvReport({ results: [null, { packages: [null, { package: null, vulnerabilities: [null] }] }] });
    assert.deepEqual(errors, []);
    assert.deepEqual(findings, []);
  });

  it("reports a report with no `results` array instead of throwing", () => {
    const { findings, errors } = parseOsvReport({ something: "else" });
    assert.deepEqual(findings, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /results/);
  });

  it("is tolerant of an empty report — a clean scan is not an error", () => {
    const { findings, errors } = parseOsvReport({ results: [] });
    assert.deepEqual(findings, []);
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------------------
// npm audit report
// ---------------------------------------------------------------------------

describe("parseNpmAuditReport", () => {
  it("extracts a finding per advisory, scored from the advisory's cvss block", () => {
    const via = {
      source: 1097679,
      name: "vite",
      title: "Vite dev server bypasses server.fs.deny",
      url: "https://github.com/advisories/GHSA-x574-m823-4x7w",
      severity: "moderate",
      cwe: ["CWE-22"],
      cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" },
    };
    const { findings, errors } = parseNpmAuditReport(npmReport({ via: [via] }));

    assert.deepEqual(errors, []);
    assert.equal(findings.length, 1);
    const [found] = findings;
    assert.equal(found.source, "npm");
    assert.equal(found.id, "GHSA-x574-m823-4x7w", "the GHSA id is taken from the advisory URL");
    assert.equal(found.package, "vite");
    assert.equal(found.manifest, "web/package-lock.json");
    assert.equal(found.score, 7.5);
    assert.equal(found.severity, "high");
  });

  it("computes the score from the vector when only a vector is given", () => {
    const { findings } = parseNpmAuditReport(npmReport({ via: [{ title: "t", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "moderate", cvss: { vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" } }] }));
    assert.equal(findings[0].score, 7.5);
    assert.equal(findings[0].severity, "high");
  });

  it("uses the advisory's own label when it carries no cvss block", () => {
    const { findings } = parseNpmAuditReport(npmReport({ via: [{ title: "t", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "critical" }] }));
    assert.equal(findings[0].score, null);
    assert.equal(findings[0].severity, "critical");
  });

  it("keeps a transitive entry (string-only `via`) as a finding with the aggregate severity", () => {
    const { findings } = parseNpmAuditReport(npmReport({ name: "esbuild", via: ["vite"], severity: "high" }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].package, "esbuild");
    assert.equal(findings[0].id, null);
    assert.equal(findings[0].severity, "high");
  });

  it("reports a report with no `vulnerabilities` map instead of throwing", () => {
    const { findings, errors } = parseNpmAuditReport({ auditReportVersion: 2 });
    assert.deepEqual(findings, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /vulnerabilities/);
  });

  it("treats an empty vulnerability map as a clean scan", () => {
    const { findings, errors } = parseNpmAuditReport({ auditReportVersion: 2, vulnerabilities: {} });
    assert.deepEqual(findings, []);
    assert.deepEqual(errors, []);
  });
});

describe("parseReport", () => {
  it("auto-detects the format and reports which one it used", () => {
    const osv = parseReport(osvReport());
    assert.equal(osv.format, "osv");
    assert.equal(osv.findings.length, 1);

    const npm = parseReport(npmReport());
    assert.equal(npm.format, "npm");
    assert.equal(npm.findings.length, 1);
  });

  it("honours an explicit format and rejects an unknown one", () => {
    assert.equal(parseReport({ results: [] }, "osv").format, "osv");

    const forced = parseReport(osvReport(), "npm");
    assert.equal(forced.findings.length, 0, "forcing the wrong parser yields nothing, not a crash");
    assert.ok(forced.errors.length > 0);

    const unknown = parseReport(osvReport(), "trivy");
    assert.equal(unknown.format, null);
    assert.match(unknown.errors[0], /unknown report format/);
  });

  it("reports a document it cannot identify", () => {
    const result = parseReport({ hello: "world" });
    assert.deepEqual(result.findings, []);
    assert.equal(result.format, null);
    assert.match(result.errors[0], /unrecognised/);
  });
});

// ---------------------------------------------------------------------------
// Waivers
// ---------------------------------------------------------------------------

describe("parseDate / daysBetween", () => {
  it("parses a YYYY-MM-DD date to UTC midnight", () => {
    assert.equal(parseDate("2026-10-10"), Date.UTC(2026, 9, 10));
    assert.equal(parseDate(" 2026-01-01 "), Date.UTC(2026, 0, 1));
  });

  it("returns null for a malformed or impossible date", () => {
    for (const bad of [null, "", "2026-13-01", "2026-02-31", "10/10/2026", "2026-10-10T00:00:00Z", 20261010]) {
      assert.equal(parseDate(bad), null, String(bad));
    }
  });

  it("counts whole days between two dates", () => {
    assert.equal(daysBetween(parseDate("2026-01-01"), parseDate("2026-01-31")), 30);
    assert.equal(daysBetween(parseDate("2026-01-01"), parseDate("2026-01-01")), 0);
    assert.equal(daysBetween(parseDate("2026-10-31"), parseDate("2026-10-01")), -30);
  });
});

describe("parseWaiverLedger", () => {
  it("reads a `{ waivers: [...] }` ledger", () => {
    const { waivers, errors } = parseWaiverLedger({ waivers: [waiver()] });
    assert.deepEqual(errors, []);
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0].id, "GHSA-aaaa-bbbb-cccc");
    assert.equal(waivers[0].reason, "not reachable from the shipped runtime");
    assert.equal(waivers[0].valid, true);
  });

  it("accepts a bare array too", () => {
    const { waivers } = parseWaiverLedger([waiver()]);
    assert.equal(waivers.length, 1);
  });

  it("scopes a waiver to a package when one is given, and leaves it unscoped otherwise", () => {
    const scoped = parseWaiverLedger({ waivers: [waiver({ package: "left-pad" })] }).waivers[0];
    assert.equal(scoped.package, "left-pad");
    assert.equal(parseWaiverLedger({ waivers: [waiver()] }).waivers[0].package, null);
  });

  it("reports a ledger it cannot read", () => {
    for (const bad of [null, "text", 42, {}]) {
      const { waivers, errors } = parseWaiverLedger(bad);
      assert.deepEqual(waivers, []);
      assert.equal(errors.length, 1, JSON.stringify(bad));
      assert.match(errors[0], /waivers/);
    }
  });

  it("marks a structurally broken entry invalid instead of dropping it silently", () => {
    const ledger = {
      waivers: [
        waiver({ id: "" }),
        waiver({ reason: "short" }),
        waiver({ granted: "not-a-date" }),
        waiver({ expires: "2026-02-31" }),
        waiver({ granted: "2026-08-01", expires: "2026-07-01" }),
        { id: "GHSA-ok", reason: "a long enough reason", granted: "2026-08-01", expires: "2026-10-01" },
      ],
    };
    const { waivers, errors } = parseWaiverLedger(ledger);

    assert.equal(waivers.length, 6, "nothing is dropped");
    assert.equal(waivers.filter((w) => w.valid).length, 1, "only the last entry is usable");
    for (const entry of waivers.slice(0, 5)) {
      assert.equal(entry.valid, false, JSON.stringify(entry));
      assert.ok(entry.invalidReason.length > 0);
    }
    assert.ok(errors.length >= 1, "the ledger flags what it found");
    assert.ok(MIN_WAIVER_REASON_LENGTH >= 8);
  });
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

describe("evaluateGate", () => {
  it("passes a clean scan", () => {
    const decision = evaluateGate({ findings: [], now: NOW });
    assert.equal(decision.ok, true);
    assert.equal(decision.exitCode, EXIT.PASS);
    assert.deepEqual(decision.blocked, []);
    assert.equal(decision.counts.total, 0);
  });

  it("blocks on an unwaived High, but still exits 0 by default (alert-only)", () => {
    const decision = evaluateGate({ findings: [finding({ score: 9.8 })], now: NOW });

    assert.equal(decision.blocked.length, 1);
    assert.equal(decision.ok, false, "the gate reports the block");
    assert.equal(decision.exitCode, EXIT.PASS, "…but the default is alert-only");
    assert.equal(decision.policy.strict, false);
    assert.equal(decision.policy.mode, "alert-only");
    assert.equal(decision.findings[0].severity, "critical");
    assert.equal(decision.findings[0].status, "blocked");
  });

  it("exits non-zero in strict mode", () => {
    const decision = evaluateGate({ findings: [finding({ score: 7.0 })], now: NOW, strict: true });
    assert.equal(decision.exitCode, EXIT.BLOCKED);
    assert.equal(decision.policy.mode, "strict");
  });

  it("is unaffected by anything below the threshold", () => {
    for (const score of [0, 3.9, 4.0, 6.9]) {
      const decision = evaluateGate({ findings: [finding({ score })], now: NOW, strict: true });
      assert.equal(decision.exitCode, EXIT.PASS, `score ${score}`);
      assert.equal(decision.findings[0].status, "advisory");
    }
  });

  it("blocks at exactly the threshold", () => {
    const decision = evaluateGate({ findings: [finding({ score: CVSS_BLOCK_THRESHOLD })], now: NOW, strict: true });
    assert.equal(decision.exitCode, EXIT.BLOCKED);
  });

  it("blocks on a label-only Critical that carries no score", () => {
    const decision = evaluateGate({ findings: [finding({ score: null, severity: "critical" })], now: NOW, strict: true });
    assert.equal(decision.exitCode, EXIT.BLOCKED);
  });

  it("lets a valid waiver release a block", () => {
    const decision = evaluateGate({ findings: [finding({ score: 9.8 })], waivers: [waiver()], now: NOW, strict: true });

    assert.equal(decision.exitCode, EXIT.PASS);
    assert.equal(decision.ok, true);
    assert.equal(decision.findings[0].status, "waived");
    assert.equal(decision.waived.length, 1);
    assert.equal(decision.waived[0].waiver.id, "GHSA-aaaa-bbbb-cccc");
  });

  it("matches a waiver by alias as well as by id, case-insensitively", () => {
    const byAlias = evaluateGate({ findings: [finding({ aliases: ["CVE-2026-1111"] })], waivers: [waiver({ id: "cve-2026-1111" })], now: NOW });
    assert.equal(byAlias.findings[0].status, "waived");
  });

  it("does not apply a waiver scoped to another package", () => {
    const decision = evaluateGate({ findings: [finding()], waivers: [waiver({ package: "another-pkg" })], now: NOW });
    assert.equal(decision.findings[0].status, "blocked");
  });

  it("applies a waiver scoped to the matching package", () => {
    const decision = evaluateGate({ findings: [finding()], waivers: [waiver({ package: "left-pad" })], now: NOW });
    assert.equal(decision.findings[0].status, "waived");
  });

  it("refuses an expired waiver, naming the date", () => {
    const decision = evaluateGate({ findings: [finding()], waivers: [waiver({ granted: "2026-06-01", expires: "2026-10-09" })], now: NOW, strict: true });

    assert.equal(decision.exitCode, EXIT.BLOCKED);
    assert.equal(decision.findings[0].status, "blocked");
    assert.match(decision.findings[0].waiverRejected, /expired/i);
    assert.match(decision.findings[0].waiverRejected, /2026-10-09/);
  });

  it("treats the expiry date itself as still covered, and the next day as expired", () => {
    assert.equal(evaluateGate({ findings: [finding()], waivers: [waiver({ granted: "2026-09-10", expires: "2026-10-10" })], now: NOW }).findings[0].status, "waived");
    assert.equal(evaluateGate({ findings: [finding()], waivers: [waiver({ granted: "2026-09-11", expires: "2026-10-09" })], now: NOW }).findings[0].status, "blocked");
  });

  it("caps a High waiver at 90 days", () => {
    const ok = evaluateGate({ findings: [finding({ score: 7.5 })], waivers: [waiver({ granted: "2026-07-15", expires: "2026-10-13" })], now: NOW, strict: true });
    assert.equal(ok.exitCode, EXIT.PASS, "exactly 90 days is allowed");
    assert.equal(ok.findings[0].status, "waived");

    const tooLong = evaluateGate({ findings: [finding({ score: 7.5 })], waivers: [waiver({ granted: "2026-07-14", expires: "2026-10-13" })], now: NOW, strict: true });
    assert.equal(tooLong.exitCode, EXIT.BLOCKED, "91 days is not");
    assert.match(tooLong.findings[0].waiverRejected, /90/);
  });

  it("caps a Critical waiver at 30 days", () => {
    const ok = evaluateGate({ findings: [finding({ score: 9.8 })], waivers: [waiver({ granted: "2026-09-20", expires: "2026-10-20" })], now: NOW, strict: true });
    assert.equal(ok.exitCode, EXIT.PASS, "exactly 30 days is allowed");

    const tooLong = evaluateGate({ findings: [finding({ score: 9.8 })], waivers: [waiver({ granted: "2026-09-19", expires: "2026-10-20" })], now: NOW, strict: true });
    assert.equal(tooLong.exitCode, EXIT.BLOCKED);
    assert.match(tooLong.findings[0].waiverRejected, /30/);
  });

  it("keeps a High waiver that is longer than 30 days valid (the Critical cap does not apply)", () => {
    const decision = evaluateGate({ findings: [finding({ score: 8.0 })], waivers: [waiver({ granted: "2026-08-01", expires: "2026-10-30" })], now: NOW });
    assert.equal(decision.findings[0].status, "waived");
  });

  it("refuses a structurally invalid waiver", () => {
    const decision = evaluateGate({ findings: [finding()], waivers: [waiver({ reason: "short" })], now: NOW });
    assert.equal(decision.findings[0].status, "blocked");
    assert.match(decision.findings[0].waiverRejected, /reason/i);
  });

  it("keeps an unknown-severity advisory as advisory by default, and blocks it on request", () => {
    const unscored = finding({ score: null, severity: undefined, aliases: [] });
    const lenient = evaluateGate({ findings: [unscored], now: NOW, strict: true });
    assert.equal(lenient.exitCode, EXIT.PASS);
    assert.equal(lenient.findings[0].status, "unknown");
    assert.equal(lenient.unknown.length, 1);

    const strictOnUnknown = evaluateGate({ findings: [unscored], now: NOW, strict: true, blockUnknown: true });
    assert.equal(strictOnUnknown.exitCode, EXIT.BLOCKED);
    assert.equal(strictOnUnknown.findings[0].status, "blocked");
  });

  it("carries the scanner's own errors into the decision", () => {
    const decision = evaluateGate({ findings: [], scanErrors: ["osv: report has no `results` array"], now: NOW });
    assert.deepEqual(decision.scanErrors, ["osv: report has no `results` array"]);
    assert.equal(decision.exitCode, EXIT.PASS);
  });

  it("orders the findings deterministically, most severe first", () => {
    const decision = evaluateGate({
      findings: [
        finding({ id: "GHSA-low", score: 2.0, package: "a" }),
        finding({ id: "GHSA-crit", score: 9.8, package: "b" }),
        finding({ id: "GHSA-high", score: 7.5, package: "c" }),
        finding({ id: "GHSA-none", score: null, package: "d" }),
      ],
      now: NOW,
    });
    assert.deepEqual(decision.findings.map((f) => f.id), ["GHSA-crit", "GHSA-high", "GHSA-low", "GHSA-none"]);
  });

  it("is pure: the same input yields a deep-equal decision and does not mutate it", () => {
    const input = { findings: [finding()], waivers: [waiver()], now: NOW, strict: true };
    const snapshot = JSON.stringify(input);
    assert.deepEqual(evaluateGate(input), evaluateGate(input));
    assert.equal(JSON.stringify(input), snapshot);
  });

  it("defaults the clock to today when none is given", () => {
    const decision = evaluateGate({ findings: [finding()], waivers: [waiver()] });
    assert.equal(decision.policy.now, new Date().toISOString().slice(0, 10));
  });

  it("reports the waiver policy it enforces", () => {
    const decision = evaluateGate({ findings: [], now: NOW });
    assert.equal(decision.policy.threshold, 7.0);
    assert.deepEqual(decision.policy.maxWaiverDays, { critical: 30, default: 90 });
    assert.equal(WAIVER_MAX_DAYS.critical, 30);
    assert.equal(WAIVER_MAX_DAYS.default, 90);
  });
});

describe("isStrictEnv", () => {
  it("accepts the truthy spellings and nothing else", () => {
    for (const yes of ["1", "true", "TRUE", "yes", "on", " 1 "]) assert.equal(isStrictEnv(yes), true, yes);
    for (const no of [undefined, null, "", "0", "false", "no", "off", "2"]) assert.equal(isStrictEnv(no), false, String(no));
  });
});

describe("rendering", () => {
  it("summarises the verdict in text", () => {
    const decision = evaluateGate({ findings: [finding(), finding({ id: "GHSA-other", score: 5.0, package: "z" })], waivers: [], now: NOW });
    const text = renderText(decision).join("\n");

    assert.match(text, /2 findings/);
    assert.match(text, /1 blocked/);
    assert.match(text, /left-pad/);
    assert.match(text, /alert-only/);
  });

  it("renders a GitHub step summary with the policy, the block and the waiver", () => {
    const decision = evaluateGate({ findings: [finding({ id: "GHSA-aaaa-bbbb-cccc", score: 9.8 })], waivers: [waiver()], now: NOW });
    const summary = renderSummary(decision);

    assert.match(summary, /CVSS >= 7\.0/);
    assert.match(summary, /90/);
    assert.match(summary, /30/);
    assert.match(summary, /left-pad/);
    assert.match(summary, /GHSA-aaaa-bbbb-cccc/);
    assert.match(summary, /waived/i);
  });

  it("says so when nothing blocks", () => {
    const summary = renderSummary(evaluateGate({ findings: [], now: NOW }));
    assert.match(summary, /No unwaived High\/Critical advisories/);
  });
});

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

describe("scan-gate.mjs CLI", () => {
  it("exits 0 on a clean scan and prints a summary", async () => {
    const dir = await makeTree({ "osv.json": { results: [] } });
    const result = runCli(["--input", join(dir, "osv.json"), "--now", NOW]);

    assert.equal(result.status, EXIT.PASS, result.stderr);
    assert.match(result.stdout, /no blocking advisories|0 findings/);
  });

  it("exits 0 but reports a High finding by default (alert-only)", async () => {
    const dir = await makeTree({ "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }) });
    const result = runCli(["--input", join(dir, "osv.json"), "--now", NOW]);

    assert.equal(result.status, EXIT.PASS, result.stderr);
    assert.match(result.stdout, /blocked/i);
    assert.match(result.stdout, /left-pad/);
  });

  it("exits 1 with SCAN_STRICT=1 and an unwaived High", async () => {
    const dir = await makeTree({
      "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }),
      "waivers.json": { waivers: [] },
    });
    const result = runCli(["--input", join(dir, "osv.json"), "--waivers", join(dir, "waivers.json"), "--now", NOW], { [STRICT_ENV]: "1" });

    assert.equal(result.status, EXIT.BLOCKED);
    assert.match(result.stderr, /strict/i);
  });

  it("exits 0 with SCAN_STRICT=1 when a valid waiver covers the finding", async () => {
    const dir = await makeTree({
      "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }),
      "waivers.json": { waivers: [waiver()] },
    });
    const result = runCli(["--input", join(dir, "osv.json"), "--waivers", join(dir, "waivers.json"), "--now", NOW], { [STRICT_ENV]: "1" });

    assert.equal(result.status, EXIT.PASS, result.stderr);
    assert.match(result.stdout, /waived/i);
  });

  it("honours --strict as the flag form of the same switch", async () => {
    const dir = await makeTree({ "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }) });
    assert.equal(runCli(["--input", join(dir, "osv.json"), "--now", NOW, "--strict"]).status, EXIT.BLOCKED);
  });

  it("pins the waiver clock with --now", async () => {
    const dir = await makeTree({
      "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }),
      "waivers.json": { waivers: [waiver({ granted: "2026-09-25", expires: "2026-10-15" })] },
    });
    const args = ["--input", join(dir, "osv.json"), "--waivers", join(dir, "waivers.json"), "--strict"];

    assert.equal(runCli([...args, "--now", "2026-10-10"]).status, EXIT.PASS);
    assert.equal(runCli([...args, "--now", "2026-10-16"]).status, EXIT.BLOCKED);
  });

  it("reads an osv report and an npm-audit report in one run", async () => {
    const dir = await makeTree({
      "osv.json": { results: [] },
      "npm-audit.json": npmReport({ via: [{ title: "t", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "critical" }] }),
    });
    const result = runCli(["--input", join(dir, "osv.json"), "--input", join(dir, "npm-audit.json"), "--now", NOW, "--json"]);

    assert.equal(result.status, EXIT.PASS, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.counts.total, 1);
    assert.equal(decision.findings[0].source, "npm");
  });

  it("prints machine-readable JSON with --json", async () => {
    const dir = await makeTree({ "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }) });
    const result = runCli(["--input", join(dir, "osv.json"), "--now", NOW, "--json", "--strict"]);

    assert.equal(result.status, EXIT.BLOCKED);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.counts.blocked, 1);
    assert.equal(decision.policy.strict, true);
    assert.equal(decision.exitCode, EXIT.BLOCKED);
  });

  it("appends a markdown summary to --summary", async () => {
    const dir = await makeTree({ "osv.json": osvReport({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }), "summary.md": "# existing\n" });
    const summary = join(dir, "summary.md");
    const result = runCli(["--input", join(dir, "osv.json"), "--now", NOW, "--summary", summary]);

    assert.equal(result.status, EXIT.PASS, result.stderr);
    const text = await readFile(summary, "utf8");
    assert.match(text, /^# existing/m, "the summary is appended, not truncated");
    assert.match(text, /left-pad/);
  });

  it("warns — but does not fail — when one of several reports cannot be read", async () => {
    const dir = await makeTree({ "osv.json": { results: [] } });
    const result = runCli(["--input", join(dir, "osv.json"), "--input", join(dir, "missing.json"), "--now", NOW]);

    assert.equal(result.status, EXIT.PASS, result.stderr);
    assert.match(result.stderr, /missing\.json/);
  });

  it("exits 2 when no input at all can be read — a scan that never ran is not a pass", async () => {
    const dir = await makeTree({ "broken.json": "{ not json" });
    const missing = runCli(["--input", join(dir, "missing.json"), "--now", NOW]);
    assert.equal(missing.status, EXIT.USAGE);
    assert.match(missing.stderr, /scan/i);

    const broken = runCli(["--input", join(dir, "broken.json"), "--now", NOW]);
    assert.equal(broken.status, EXIT.USAGE);
  });

  it("exits 2 on a usage error", async () => {
    assert.equal(runCli([]).status, EXIT.USAGE, "no --input");
    assert.equal(runCli(["--input", "x.json", "--nonsense"]).status, EXIT.USAGE, "unknown flag");
    assert.equal(runCli(["--input", "x.json", "--format", "trivy"]).status, EXIT.USAGE, "unknown format");
    assert.equal(runCli(["--input", "x.json", "--now", "yesterday"]).status, EXIT.USAGE, "bad date");
  });

  it("prints usage on --help without needing any input", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, EXIT.PASS);
    assert.match(result.stdout, /scan-gate/);
    assert.match(result.stdout, /SCAN_STRICT/);
  });
});

// ---------------------------------------------------------------------------
// The shipped waiver ledger
// ---------------------------------------------------------------------------

describe("scripts/security/waivers.json", () => {
  it("parses, and every shipped entry is structurally valid", async () => {
    const doc = JSON.parse(await readFile(join(ROOT, "scripts", "security", "waivers.json"), "utf8"));
    const { waivers, errors } = parseWaiverLedger(doc);

    assert.deepEqual(errors, [], `the shipped ledger must be readable: ${errors.join(" | ")}`);
    for (const entry of waivers) {
      assert.equal(entry.valid, true, `waiver ${entry.id} is invalid: ${entry.invalidReason}`);
    }
  });
});
