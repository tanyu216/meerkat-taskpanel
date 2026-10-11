/**
 * Static assertions on `.github/workflows/release.yml` and the page that documents it.
 *
 * The repository is zero-dependency and offline and ships no YAML parser, so a workflow
 * cannot be *run* here — these read the shipped files as text, the same footing as
 * `scripts/security/workflow.test.mjs` and `test/docker.test.mjs`. What they pin is the
 * release pipeline's safety contract, which was previously asserted by a host-only script
 * outside the repo (T-20261010-043300) and therefore had no in-repo guard:
 *
 *   - the workflow has **no path to a publish** — no `npm publish`, no registry token
 *     (`NPM_TOKEN` / `NODE_AUTH_TOKEN` / `secrets.*`), no `registry-url`, no marketplace
 *     upload — and stops at `gh release create --draft`;
 *   - the release step is the **only** `gh release` call in the file and its subcommand is
 *     `create` (so `gh release edit|delete|upload …`, which can change or drop a draft's
 *     state, turns red — a whitelist, not a blacklist of known-bad flags);
 *   - that `gh release create` occurs **exactly once** and *every* occurrence carries
 *     `--draft` with the closed asset list — a guard that reads only the first command
 *     cannot see a second, non-draft one appended below it;
 *   - the draft's asset list is **closed**: the npm tarball plus `sbom.spdx.json`, with no
 *     wildcard and nothing else from the workspace;
 *   - the SBOM step is **required** (not `continue-on-error`) and asserted non-empty;
 *   - the six-version check runs **before** `npm pack`.
 *
 * Drift in any of these — a stray `npm publish` line, a deleted SBOM step, a wildcard
 * asset — now turns `npm run check` red.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = ".github/workflows/release.yml";
const DOC = "docs/publishing.md";

/** Read a repository-relative file as UTF-8 text. */
function read(relPath) {
  return readFile(join(ROOT, relPath), "utf8");
}

/**
 * Drop whole-line YAML/shell comments. Prose about a thing (`no `npm publish` step`) is not
 * the thing, so every "is this token absent?" assertion reads this view, never the raw file.
 */
function code(text) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

/**
 * Every `gh release <subcommand> …` invocation in `text`, with backslash line-continuations
 * folded into one string, in file order. Returns `{ sub, command }` objects.
 *
 * Deliberately *all* occurrences, not the first: a guard that reads only the first command
 * cannot see a second, non-draft `gh release create` appended below it (Turing R68 on
 * T-20261010-204107 found exactly that hole). The callers below assert on the whole list —
 * that it holds exactly one `create`, that every element is a `create`, and that every
 * element carries `--draft` and the closed asset list.
 */
function ghReleaseCommands(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /(^|\s)gh release (\S+)/.exec(lines[i].trim());
    if (!match) continue;

    const folded = [];
    let j = i;
    for (; j < lines.length; j += 1) {
      const continues = /\\\s*$/.test(lines[j]);
      folded.push(continues ? lines[j].replace(/\\\s*$/, "") : lines[j]);
      if (!continues) break;
    }
    i = j; // this command consumed the continuation lines; don't rescan them
    out.push({ sub: match[2], command: folded.join(" ").trim() });
  }
  return out;
}

/** Quote-aware whitespace split: `"a b"` is one token, quotes are removed. */
function shellTokens(command) {
  const out = [];
  let buffer = "";
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else buffer += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (buffer) out.push(buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** Flags that carry no value; every other `-`-prefixed token consumes the token after it. */
const BOOLEAN_FLAGS = new Set([
  "--draft",
  "--prerelease",
  "--latest",
  "--generate-notes",
  "--verify-tag",
  "--fail-on-no-commits",
]);

/** Split a `gh release create` command into `{flags, positional}` (positional = tag + assets). */
function ghReleaseArgs(command) {
  const tokens = shellTokens(command.replace(/^\S*\s+\S+\s+\S+\s*/, "")); // drop `gh release create`
  const flags = [];
  const positional = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      flags.push(token);
      if (!token.includes("=") && !BOOLEAN_FLAGS.has(token)) i += 1; // skip its value
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

/** The step block (its `- name:`/`- uses:` line up to the next step) containing `needle`. */
function stepBlock(text, needle) {
  const lines = text.split("\n");
  const hit = lines.findIndex((line) => line.includes(needle));
  if (hit === -1) return null;

  let start = hit;
  while (start > 0 && !/^\s*- (name|uses): /.test(lines[start])) start -= 1;
  let end = start + 1;
  while (end < lines.length && !/^\s*- (name|uses): /.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

// ---------------------------------------------------------------------------

describe("static: .github/workflows/release.yml", () => {
  it("is a v* tag push that runs one release job holding the only write scope", async () => {
    const text = await read(WORKFLOW);

    assert.match(text, /^name: release$/m);
    assert.match(text, /^on:\n {2}push:\n {4}tags: \["v\*"\]$/m, "the trigger is a v* tag push");
    assert.deepEqual(
      [...text.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]),
      ["push", "release"],
      "exactly one job (`release`), triggered by `push`",
    );
    assert.match(text, /^permissions:\n {2}contents: write$/m);
    assert.equal((text.match(/contents: write/g) || []).length, 1, "the only write scope feeds the release step's gh call");
  });

  it("has no publish bypass once comments are stripped", async () => {
    const raw = await read(WORKFLOW);
    // The header comment names the paths it forbids; the strip below is what keeps that
    // prose from reading as code, so this guard is load-bearing rather than vacuous.
    assert.ok(raw.includes("npm publish"), "the file should still *say* it has no npm publish step");

    const body = code(raw);
    for (const forbidden of [
      /npm publish/,
      /NPM_TOKEN/,
      /NODE_AUTH_TOKEN/,
      /registry-url/,
      /secrets\./,
      /marketplace (push|publish|upload)/,
      /--draft=(false|no)/,
    ]) {
      assert.doesNotMatch(body, forbidden, `release.yml must have no publish path matching ${forbidden}`);
    }
  });

  it("never runs a `gh release` subcommand other than `create`", async () => {
    const commands = ghReleaseCommands(code(await read(WORKFLOW)));
    assert.ok(commands.length > 0, "expected a `gh release` invocation");

    // Whitelist, so a state-changing subcommand the blacklist does not name — `gh release
    // edit`, `delete`, `upload` — still turns red.
    for (const { sub } of commands) {
      assert.equal(sub, "create", `release.yml may only ever run \`gh release create\`; found \`gh release ${sub}\``);
    }
  });

  it("opens the release only as a draft, with a closed asset list", async () => {
    const creates = ghReleaseCommands(code(await read(WORKFLOW))).filter((c) => c.sub === "create");
    assert.equal(creates.length, 1, "exactly one `gh release create` — a second is an unseen release path");

    // Belt and braces with the count above: validate *every* occurrence, so a second
    // command would have to satisfy the draft + closed-asset contract to go unnoticed.
    for (const { command } of creates) {
      const { flags, positional } = ghReleaseArgs(command);
      assert.ok(flags.includes("--draft"), "the release must be created --draft");
      assert.deepEqual(
        positional,
        ["$GITHUB_REF_NAME", "${{ steps.pack.outputs.tarball }}", "sbom.spdx.json"],
        "assets are exactly the tag ref, the npm tarball and the SBOM — closed, no other workspace artifact",
      );
      assert.doesNotMatch(command, /\*/, "the asset list must not use a wildcard");
    }
  });

  it("makes the SBOM a required step, produced here and asserted non-empty", async () => {
    const body = code(await read(WORKFLOW));

    assert.match(body, /anchore\/sbom-action/, "syft, via its official action");
    assert.match(body, /format: spdx-json/);
    assert.match(body, /output-file: sbom\.spdx\.json/);
    assert.match(body, /upload-release-assets: false/, "the release step owns the asset list, not the action");
    assert.match(body, /test -s sbom\.spdx\.json/, "a non-empty assertion on the SBOM");

    const sbom = stepBlock(body, "anchore/sbom-action");
    assert.ok(sbom, "expected the SBOM step");
    assert.doesNotMatch(sbom, /continue-on-error/, "the SBOM step must be required, not best-effort");
    assert.doesNotMatch(body, /^\s*continue-on-error:/m, "no step in this workflow may be best-effort");
  });

  it("checks the six-version manifests before packing the tarball", async () => {
    const body = code(await read(WORKFLOW));
    const version = body.indexOf("node scripts/verify/version.mjs");
    const pack = body.indexOf("npm pack");

    assert.notEqual(version, -1, "the six-version check must be present");
    assert.notEqual(pack, -1, "`npm pack` must be present");
    assert.ok(version < pack, "version.mjs must run before npm pack");
  });
});

describe("static: docs/publishing.md stays consistent with release.yml", () => {
  it("states the no-token, draft-only release decision", async () => {
    const doc = await read(DOC);

    assert.match(doc, /^## 3\. Git tag \+ GitHub Release$/m, "the release section");
    assert.match(doc, /^### 2\.1 Provenance/m, "the provenance decision section");
    assert.ok(doc.includes("npm publish --provenance"), "the provenance command is documented");
    assert.ok(doc.includes("NPM_TOKEN"), "the no-token decision is stated");
    assert.ok(doc.includes(".github/workflows/release.yml"), "the page names the workflow it documents");
    assert.ok(doc.includes("sbom.spdx.json"), "the closed asset list is stated");
  });

  it("keeps the tag-from-main policy anchors", async () => {
    const doc = await read(DOC);

    assert.match(doc, /^### 3\.3 Branch protection on `main`/m);
    assert.ok(doc.includes("Require a pull request before merging"));
    assert.ok(doc.includes("Require status checks to pass before merging"));
    assert.ok(/tag ruleset|Tag protection/i.test(doc), "the tag ruleset step is documented");
    assert.ok(doc.includes("git merge-base --is-ancestor"), "the tag-from-main pre-flight command is documented");
    for (const check of ["check (22)", "check (24)", "docker", "contract"]) {
      assert.ok(doc.includes(check), `the required checks must name \`${check}\``);
    }
  });
});
