/**
 * Static assertions shared by every workflow, `check.yml` included.
 *
 * `check.yml` used to be excluded because it was owned by a concurrent change.
 * That is no longer true: it is now the single pull-request / integration
 * workflow, so it is policed like the rest. Three properties are cheap to lose
 * and expensive to notice:
 *
 *   - a `concurrency` group, so two runs of the same gate do not race;
 *   - a `timeout-minutes` on every job, so a hung step cannot hold a runner;
 *   - every `uses:` pinned to a commit SHA, so a compromised tag cannot change
 *     what CI runs. Dependabot (`.github/dependabot.yml`) keeps the pins fresh.
 *
 * Two policy rules are pinned here as well: no workflow runs on every branch
 * push (a pull request already covers the commit, and a `dev` push covers the
 * merge), and `check.yml` aggregates its jobs behind one required check.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

async function workflowNames() {
  const names = await readdir(WORKFLOW_DIR);
  return names.filter((name) => name.endsWith(".yml")).sort();
}

/** One `{name, body}` per job under the top-level `jobs:` key. */
function jobBlocks(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(start, -1, "expected a jobs: block");
  const jobs = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs map
    const match = /^ {2}([a-z][\w-]*):$/.exec(line);
    if (match) {
      if (current !== null) jobs.push(current);
      current = { name: match[1], body: [line] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null) jobs.push(current);
  return jobs.map((job) => ({ name: job.name, body: job.body.join("\n") }));
}

describe("workflow hygiene", () => {
  it("gives every workflow a concurrency group and every job a timeout", async () => {
    for (const name of await workflowNames()) {
      const text = await readFile(join(WORKFLOW_DIR, name), "utf8");
      assert.match(
        text,
        /^concurrency:\n(?: {2}#.*\n)* {2}group: /m,
        `${name} has no concurrency group`,
      );
      const jobs = jobBlocks(text);
      assert.ok(jobs.length > 0, `${name} has no jobs`);
      for (const job of jobs) {
        assert.match(job.body, /^ {4}timeout-minutes: \d+$/m, `${name}: job '${job.name}' has no timeout`);
      }
    }
  });

  it("pins every action to a commit SHA", async () => {
    for (const name of await workflowNames()) {
      const text = await readFile(join(WORKFLOW_DIR, name), "utf8");
      const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((match) => match[1]);
      assert.ok(uses.length > 0, `${name} runs no actions?`);
      for (const action of uses) {
        assert.match(
          action,
          /@[0-9a-f]{40}$/,
          `${name}: '${action}' is a mutable tag; pin it to a commit SHA`,
        );
      }
    }
  });

  it("aggregates check.yml behind one required status check", async () => {
    const check = await readFile(join(WORKFLOW_DIR, "check.yml"), "utf8");
    assert.match(check, /^name: check$/m, "check.yml is the pull-request workflow");
    assert.match(check, /^ {2}ci-success:$/m, "expected the ci-success aggregator job");

    const aggregate = jobBlocks(check).find((job) => job.name === "ci-success");
    assert.ok(aggregate, "ci-success must be a job");
    assert.match(
      aggregate.body,
      /^ {4}if: always\(\)$/m,
      "the aggregator must run even when a dependency fails",
    );
    for (const dependency of ["check", "docker", "contract", "paths", "signposts"]) {
      assert.match(
        aggregate.body,
        new RegExp(`^ {4}needs: \\[[^\\]]*\\b${dependency}\\b[^\\]]*\\]$`, "m"),
        `ci-success must depend on ${dependency}`,
      );
    }
  });

  it("runs on pull requests and dev only — never on every branch push", async () => {
    for (const name of await workflowNames()) {
      const text = await readFile(join(WORKFLOW_DIR, name), "utf8");
      assert.doesNotMatch(
        text,
        /branches: \["\*\*"\]/,
        `${name} must not trigger on every branch push`,
      );
    }
    const check = await readFile(join(WORKFLOW_DIR, "check.yml"), "utf8");
    assert.match(check, /^ {2}push:\n {4}branches: \[dev\]$/m, "check.yml runs on dev, not on every branch");
  });
});

describe("dependabot keeps the pins fresh, but not the vendored frontend", () => {
  it("updates github-actions weekly", async () => {
    const text = await readFile(join(ROOT, ".github", "dependabot.yml"), "utf8");
    assert.match(text, /package-ecosystem: github-actions/);
    assert.match(text, /interval: weekly/);
  });

  it("does not open npm PRs for web/", async () => {
    // A bot bump without a re-vendored `web/.vendor/npm-cache` cannot build
    // offline; see docs/docker.md. Those bumps are a hand operation.
    const text = await readFile(join(ROOT, ".github", "dependabot.yml"), "utf8");
    assert.doesNotMatch(text, /package-ecosystem: npm/);
  });
});
