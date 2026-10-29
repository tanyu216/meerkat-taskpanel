/**
 * Static assertions on the dependency-security workflow and its documentation.
 *
 * These read the shipped files as text — the same style as `test/docker.test.mjs` does for
 * the container artifacts — because a YAML workflow cannot be *run* offline. What they pin
 * is the contract the card asks for: the triggers (PR + weekly full + daily
 * incremental + tag; no branch pushes), the two scanners, a syft SBOM produced by
 * this workflow itself, alert-only by default with `SCAN_STRICT=1` to enforce, a
 * required check that always reports, and the promise that the two workflows it
 * must not touch stay out of it.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const WORKFLOW = ".github/workflows/security-scan.yml";

async function read(relPath) {
  return readFile(join(ROOT, relPath), "utf8");
}

/** Per-field bounds for a 5-field cron, as GitHub Actions accepts them. */
const CRON_BOUNDS = [
  [0, 59, "minute"],
  [0, 23, "hour"],
  [1, 31, "day of month"],
  [1, 12, "month"],
  [0, 6, "day of week"],
];

/**
 * Assert a cron entry is one GitHub Actions will accept.
 *
 * This is not pedantry: an invalid cron does not red a *job*, it voids the whole
 * workflow file. The run then completes with **zero jobs** and registers no status
 * checks at all, so nothing in the UI explains the absence — which is exactly how
 * `17 3 * * 2-7` sat in this workflow unnoticed. Day-of-week is 0-6 (Sunday is 0);
 * POSIX cron also accepts 7, Actions does not.
 */
function assertValidGithubCron(cron, label) {
  const fields = cron.trim().split(/\s+/);
  assert.equal(fields.length, 5, `${label}: expected 5 cron fields, got ${JSON.stringify(cron)}`);

  fields.forEach((field, index) => {
    const [lo, hi, name] = CRON_BOUNDS[index];
    for (const part of field.split(",")) {
      const parsed = /^(\*|\d+|\d+-\d+)(?:\/\d+)?$/.exec(part);
      assert.ok(parsed, `${label}: unparseable ${name} field ${JSON.stringify(part)} in ${JSON.stringify(cron)}`);

      const values =
        parsed[1] === "*" ? [] : parsed[1].includes("-") ? parsed[1].split("-").map(Number) : [Number(parsed[1])];
      for (const value of values) {
        assert.ok(
          value >= lo && value <= hi,
          `${label}: ${name} ${value} is outside ${lo}-${hi} in ${JSON.stringify(cron)} — GitHub rejects the entire workflow file`,
        );
      }
    }
  });
}

describe("static: security-scan.yml", () => {
  it("exists, is named, and is triggered on push, PR, a schedule and dispatch", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /^name: security-scan$/m);
    assert.match(text, /^on:$/m);
    assert.match(text, /^ {2}push:$/m);
    assert.match(text, /^ {2}pull_request:$/m);
    assert.match(text, /^ {2}schedule:$/m);
    assert.match(text, /^ {2}workflow_dispatch:$/m);
  });

  it("scans version tags, not branch pushes", async () => {
    const text = await read(WORKFLOW);
    assert.match(text, /tags: \["v\*"\]/, "a v* tag push must trigger the workflow");
    assert.doesNotMatch(text, /branches: \["\*\*"\]/, "a branch push is covered by its pull request");
    assert.doesNotMatch(text, /^ {2}paths:$/m, "a path filter would let a required check go missing");
  });

  it("schedules a weekly full scan and a daily incremental alert", async () => {
    const text = await read(WORKFLOW);
    const crons = [...text.matchAll(/^\s*- cron: "(.+)"$/gm)].map((m) => m[1]);

    assert.equal(crons.length, 2, `expected exactly two cron entries, got ${JSON.stringify(crons)}`);
    for (const cron of crons) assertValidGithubCron(cron, WORKFLOW);

    const weekly = crons.find((cron) => /^\d+ \d+ \* \* \d$/.test(cron));
    const daily = crons.find((cron) => cron !== weekly);
    assert.ok(weekly, "expected a weekly (single day-of-week) cron entry");
    assert.ok(daily, "expected a second, daily, cron entry");
    assert.match(daily, /^\d+ \d+ \* \* [\d,-]+$/);
  });

  it("runs osv-scanner and npm audit --audit-level=high", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /google\/osv-scanner-action/, "the official osv-scanner action");
    assert.match(text, /scan-args:/);
    assert.match(text, /--recursive/);
    assert.match(text, /--format=json/);
    assert.match(text, /--output=osv-results\.json/);

    assert.match(text, /npm audit --json --audit-level=high/);
    assert.match(text, /working-directory: web/, "the only committed lockfile is web/package-lock.json");
  });

  it("lets the scanners report findings without failing the run", async () => {
    const text = await read(WORKFLOW);
    const count = [...text.matchAll(/^\s*continue-on-error: true$/gm)].length;
    assert.ok(count >= 2, `both scanner steps must be alert-only, found ${count}`);
  });

  it("always reports, and skips only the expensive work", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /^\s+id: detect$/m, "a dependency-input detector");
    assert.match(text, /steps\.detect\.outputs\.scan == 'true'/, "the scanners key off the detector");
    assert.match(text, /Write empty reports \(no dependency input changed\)/);
    assert.match(text, /\{"results":\[\]\}/, "an osv-shaped empty report");
    assert.match(text, /"auditReportVersion":2/, "an npm-shaped empty report");
    assert.match(text, /^ {2}security-success:$/m, "one aggregated required check");
    assert.match(text, /^ {4}if: always\(\)$/m, "the aggregator runs even when a dependency fails");
  });

  it("runs a secret scan and a SAST arm", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /ghcr\.io\/gitleaks\/gitleaks:v\d+\.\d+\.\d+/, "gitleaks is pinned to a version");
    assert.match(text, /git --redact --report-format json/, "the secret scan reads the tree and its history");
    assert.match(text, /--format gitleaks/, "an empty gitleaks report is still a real report");
    assert.match(text, /github\/codeql-action\/init@[0-9a-f]{40}/, "CodeQL init is pinned to a commit");
    assert.match(text, /github\/codeql-action\/analyze@[0-9a-f]{40}/, "CodeQL analyze is pinned to a commit");
    assert.match(text, /languages: javascript-typescript/);
    assert.match(text, /security-events: write/, "CodeQL uploads results to code scanning");
    assert.match(text, /^\s*secrets:$/m, "a dedicated secret-scan job");
    assert.match(text, /^\s*sast:$/m, "a dedicated SAST job");
  });

  it("aggregates every security job behind security-success", async () => {
    const text = await read(WORKFLOW);
    const needs = text.match(/^ {4}needs: \[(.+)\]$/m);
    assert.ok(needs, "security-success declares its needs");
    for (const job of ["dependency-scan", "sbom", "secrets", "sast"]) {
      assert.ok(needs[1].includes(job), `${job} is behind the required check`);
    }
  });

  it("produces the SBOM itself with syft, including on a tag push", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /anchore\/sbom-action/, "syft, via its official action");
    assert.match(text, /format: spdx-json/);
    assert.match(text, /output-file: sbom\.spdx\.json/);
    assert.match(text, /^\s*sbom:$/m, "a dedicated SBOM job");
    assert.match(text, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, "the tag path attaches the SBOM");
    assert.match(
      text,
      /^\s+if: github\.event_name != 'pull_request'$/m,
      "a pull request does not regenerate the SBOM",
    );
  });

  it("leaves release.yml and check.yml alone", async () => {
    const text = await read(WORKFLOW);

    for (const forbidden of ["release.yml", "check.yml", "git commit", "git push"]) {
      assert.ok(!text.includes(forbidden), `${WORKFLOW} must not touch or rewrite ${forbidden}`);
    }
  });

  it("never installs the application's dependencies", async () => {
    const text = await read(WORKFLOW);
    assert.doesNotMatch(text, /^\s*(-\s*)?run:.*npm (install|ci)\b/m, "the repo is dependency-free; CI must not install");
  });

  it("gates on the threshold and honours SCAN_STRICT", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /node scripts\/security\/scan-gate\.mjs/);
    assert.match(text, /--input osv-results\.json/);
    assert.match(text, /--input npm-audit\.json/);
    assert.match(text, /--waivers scripts\/security\/waivers\.json/);
    assert.match(text, /SCAN_STRICT/);
    assert.match(text, /GITHUB_STEP_SUMMARY/, "the verdict must land in the run summary");
  });

  it("declares minimal, explicit permissions", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /^permissions:$/m);
    assert.match(text, /^ {2}contents: read$/m, "the workflow default is read-only");

    const writes = [...text.matchAll(/^\s*contents: write$/gm)];
    assert.equal(writes.length, 1, "exactly one block grants write");
    assert.match(text, /^ {6}contents: write$/m, "only the SBOM job needs write, to attach the asset to a release");
  });
});

describe("static: docs/tech-spec.md", () => {
  it("documents the gate and its decision policy", async () => {
    const text = await read("docs/tech-spec.md");

    assert.ok(text.length > 500, "docs/tech-spec.md looks empty");
    for (const needle of [
      "osv-scanner",
      "npm audit",
      "syft",
      "CVSS",
      "7.0",
      "SCAN_STRICT",
      "90",
      "30",
      "scripts/security/scan-gate.mjs",
      "scripts/security/waivers.json",
      "gitleaks",
      "CodeQL",
      "security-events",
      ".vue",
    ]) {
      assert.ok(text.includes(needle), `docs/tech-spec.md should mention ${needle}`);
    }
  });
});

describe("static: the security scripts", () => {
  it("ships the gate, its tests and the waiver ledger under scripts/security/", () => {
    for (const rel of ["scan-gate.mjs", "scan-gate.test.mjs", "waivers.json"]) {
      assert.ok(existsSync(join(ROOT, "scripts", "security", rel)), `scripts/security/${rel} must exist`);
    }
  });

  it("keeps the gate free of third-party imports", async () => {
    const text = await read("scripts/security/scan-gate.mjs");
    const imports = [...text.matchAll(/^import .*?from "([^"]+)"/gm)].map((m) => m[1]);

    assert.ok(imports.length > 0, "expected some imports");
    for (const specifier of imports) {
      assert.ok(specifier.startsWith("node:"), `scan-gate.mjs must only import Node builtins, found "${specifier}"`);
    }
  });
});
