/**
 * Static assertions on `.github/workflows/release-tag.yml`.
 *
 * Text-level, like the rest of `test/release/` — the repository ships no YAML
 * parser. The contract: a human dispatches it, it tags the release commit on
 * `main` after the tag gates pass, it never moves an existing tag, and its only
 * outward action is dispatching `release.yml`. It holds no publish credential.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = ".github/workflows/release-tag.yml";

const read = () => readFile(join(ROOT, WORKFLOW), "utf8");

function code(text) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

describe("release-tag: the trigger", () => {
  it("is dispatch-only and defaults to a dry run", async () => {
    const text = code(await read());
    assert.match(text, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(text, /^\s{2}(push|pull_request|schedule):/m);
    assert.match(text, /dry_run:\n(?:.*\n)*?\s+default: true/, "a real tag must be asked for");
    assert.match(text, /permissions:\n  contents: write[^\n]*\n  actions: write[^\n]*/);
  });

  it("tags main only", async () => {
    const text = code(await read());
    assert.match(text, /ref: main/);
    assert.match(text, /merge-base --is-ancestor/, "the release commit must be on main");
  });
});

describe("release-tag: the gates", () => {
  it("runs the tag gate before creating anything", async () => {
    const text = code(await read());
    for (const script of [
      "scripts/verify/tag-version.mjs",
      "scripts/verify/version.mjs",
      "scripts/verify/changelog.mjs",
      "scripts/verify/contract.mjs",
      "scripts/verify/route-request.mjs",
      "scripts/verify/paths.mjs",
      "scripts/verify/signposts.mjs",
    ]) {
      assert.ok(text.includes(script), `the tag gate must run ${script}`);
    }
    assert.match(text, /changelog\.mjs "v\$\{VERSION\}" --strict/);
    assert.ok(
      text.indexOf("node scripts/verify/tag-version.mjs") < text.indexOf("git tag -a"),
      "the gates must precede the tag",
    );
  });

  it("creates an annotated tag and refuses to move an existing one", async () => {
    const text = code(await read());
    assert.match(text, /git tag -a "v\$\{VERSION\}" "\$COMMIT"/);
    assert.match(text, /already points at/, "a tag is immutable");
    assert.match(text, /exit 1/);
  });
});

describe("release-tag: the handoff", () => {
  it("dispatches release.yml because a GITHUB_TOKEN tag push is silent", async () => {
    const text = code(await read());
    assert.match(text, /gh workflow run release\.yml --ref main -f "tag=v\$\{VERSION\}"/);
    assert.match(text, /if: \$\{\{ !inputs\.dry_run \}\}/);
  });

  it("holds no publish path of its own", async () => {
    const text = code(await read());
    assert.doesNotMatch(text, /\bnpm publish\b/);
    assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
    assert.doesNotMatch(text, /id-token: write/, "provenance belongs to the publish job in release.yml");
  });
});
