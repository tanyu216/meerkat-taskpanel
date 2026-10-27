/**
 * Static assertions on `.github/workflows/release-prep.yml`.
 *
 * The repository ships no YAML parser, so a workflow cannot be run in this suite;
 * these read the file as text, the same footing as `test/release/workflow.test.mjs`.
 * What they pin is the boundary of the release-prep step: it may open a branch and
 * a pull request, and it must have **no path to a tag or a publish** — those are
 * the `release-tag` and `release.yml` dispatches, each separately reviewable.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = ".github/workflows/release-prep.yml";

const read = () => readFile(join(ROOT, WORKFLOW), "utf8");

/** Drop whole-line YAML/shell comments: prose about a command is not the command. */
function code(text) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

describe("release-prep: the trigger", () => {
  it("is dispatch-only, from dev, with version and dry_run inputs", async () => {
    const text = code(await read());
    assert.match(text, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(text, /^\s{2}(push|pull_request|schedule|release):/m, "no automatic trigger");
    assert.match(text, /version:\n(?:.*\n)*?\s+required: true/);
    assert.match(text, /dry_run:\n(?:.*\n)*?\s+default: false/);
    assert.match(text, /ref: dev/, "the branch is cut from dev");
    assert.match(text, /fetch-depth: 0/);
  });
});

describe("release-prep: the boundary", () => {
  it("cannot tag or publish", async () => {
    const text = code(await read());
    assert.doesNotMatch(text, /\bnpm publish\b/, "publishing belongs to release.yml");
    assert.doesNotMatch(text, /\bgit tag\b/, "tagging belongs to release-tag");
    assert.doesNotMatch(text, /\bgh release\b/, "the GitHub Release belongs to release.yml");
    assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./, "no registry credential");
  });

  it("commits only the release's files, never the whole tree", async () => {
    const text = code(await read());
    assert.doesNotMatch(text, /git add -A|git commit -a|git add \./, "a sweep would commit anything left behind");
    for (const path of [
      "package.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "src/foundation/constants.mjs",
      "CHANGELOG.md",
    ]) {
      assert.ok(text.includes(path), `the explicit commit list must name ${path}`);
    }
  });

  it("refreshes an existing branch without clobbering a human push", async () => {
    const text = code(await read());
    assert.match(text, /--force-with-lease/, "a re-run is a lease, not a force");
    assert.match(text, /release\/v\$\{VERSION\}/);
  });
});

describe("release-prep: the PR", () => {
  it("tells the reviewer about the merge-commit rule and the token gap", async () => {
    const text = code(await read());
    assert.match(text, /merge commit/i);
    assert.match(text, /[Dd]o not squash/);
    assert.match(text, /close and reopen/i, "GITHUB_TOKEN-authored PRs skip pull_request workflows");
    assert.match(text, /release-tag/);
  });

  it("maintains one PR per branch instead of opening duplicates", async () => {
    const text = code(await read());
    assert.match(text, /gh pr list --head/);
    assert.match(text, /gh pr edit/);
    assert.match(text, /gh pr create/);
  });

  it("dispatches the gate workflows on the release branch", async () => {
    const text = code(await read());
    assert.match(text, /^ {2}actions: write\b/m, "dispatching a workflow needs actions: write");
    for (const workflow of ["check.yml", "security-scan.yml", "web-dom.yml"]) {
      assert.ok(text.includes(`gh workflow run "$workflow"`), `must dispatch ${workflow}`);
    }
    assert.match(text, /gh workflow view/, "an unregistered workflow is skipped, not a failed prep");
    assert.ok(!text.includes("gh workflow run release.yml"), "publishing is not this step's job");
  });
});
