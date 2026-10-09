/**
 * Static assertions on the dependency-security workflow and its documentation.
 *
 * These read the shipped files as text — the same style as `test/docker.test.mjs` does for
 * the container artifacts — because a YAML workflow cannot be *run* offline. What they pin
 * is the contract the card asks for: the triggers (push/PR + weekly full + daily
 * incremental + tag), the two scanners, a syft SBOM produced by this workflow itself,
 * alert-only by default with `SCAN_STRICT=1` to enforce, and the promise that the two
 * workflows it must not touch stay out of it.
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

  it("scans pushed branches AND version tags", async () => {
    const text = await read(WORKFLOW);
    assert.match(text, /tags: \["v\*"\]/, "a v* tag push must trigger the workflow");
    assert.match(text, /branches: \["\*\*"\]/);
  });

  it("schedules a weekly full scan and a daily incremental alert", async () => {
    const text = await read(WORKFLOW);
    const crons = [...text.matchAll(/^\s*- cron: "(.+)"$/gm)].map((m) => m[1]);

    assert.equal(crons.length, 2, `expected exactly two cron entries, got ${JSON.stringify(crons)}`);
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

  it("produces the SBOM itself with syft, including on a tag push", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /anchore\/sbom-action/, "syft, via its official action");
    assert.match(text, /format: spdx-json/);
    assert.match(text, /output-file: sbom\.spdx\.json/);
    assert.match(text, /^\s*sbom:$/m, "a dedicated SBOM job");
    assert.match(text, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, "the tag path attaches the SBOM");
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

describe("static: docs/security.md", () => {
  it("documents the gate", async () => {
    const text = await read("docs/security.md");

    assert.ok(text.length > 500, "docs/security.md looks empty");
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
    ]) {
      assert.ok(text.includes(needle), `docs/security.md should mention ${needle}`);
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
