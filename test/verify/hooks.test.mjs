/**
 * Tests for `.githooks/pre-push`.
 *
 * The hook is a thin POSIX `sh` wrapper over `scripts/verify/contract.mjs`,
 * `scripts/verify/route-request.mjs` and `scripts/verify/changelog.mjs`, plus one
 * rule of its own: a direct push to `main` is refused, because `main` advances
 * through a pull request. GitHub's branch-protection rule is the enforcement;
 * this is the local, early half — it fires before the network, so a mistaken
 * `git push origin main` costs nothing.
 *
 * The hook reads its refs from stdin, one `<local ref> <local sha> <remote ref>
 * <remote sha>` line per ref. That is the property most easily broken here: a
 * second `while read` loop added for one rule silently starves every later one,
 * because the first loop already consumed stdin. The tag cases below exist to
 * pin that — they fail if the loop stops seeing the lines.
 *
 * The cases run the real hook as a subprocess; nothing is mocked.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = join(ROOT, ".githooks", "pre-push");
const ZERO = "0000000000000000000000000000000000000000";
const SHA = "1111111111111111111111111111111111111111";

/**
 * Run the hook with `lines` on stdin.
 *
 * `ALLOW_PUSH_MAIN` is stripped from the inherited environment so a developer who
 * happens to have it exported does not turn the refusal cases green.
 */
function runHook(lines, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.ALLOW_PUSH_MAIN;
  Object.assign(childEnv, env);

  const result = spawnSync("sh", [HOOK], {
    cwd: ROOT,
    encoding: "utf8",
    input: lines.map((line) => `${line}\n`).join(""),
    env: childEnv,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("pre-push: the two API gates always run", () => {
  it("runs the contract and route-request checkers on an ordinary branch push", () => {
    const { status, stdout } = runHook([`refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`]);

    assert.equal(status, 0, "a feature-branch push must pass");
    assert.match(stdout, /^contract: OK/m);
    assert.match(stdout, /^route-request: OK/m);
  });

  it("still runs them when the push is refused", () => {
    const { stdout } = runHook([`refs/heads/main ${SHA} refs/heads/main ${ZERO}`]);

    assert.match(stdout, /^contract: OK/m, "the guard must be additive, not a replacement");
    assert.match(stdout, /^route-request: OK/m);
  });
});

describe("pre-push: main advances only through a pull request", () => {
  it("refuses a direct push to main", () => {
    const { status, stderr } = runHook([`refs/heads/main ${SHA} refs/heads/main ${ZERO}`]);

    assert.notEqual(status, 0, "pushing main directly must be refused");
    assert.match(stderr, /refus/i);
    assert.match(stderr, /pull request/i, "the message must say what to do instead");
  });

  it("refuses a branch pushed onto main under another local name", () => {
    const { status } = runHook([`refs/heads/dev ${SHA} refs/heads/main ${ZERO}`]);

    assert.notEqual(status, 0, "`git push origin dev:main` is still a direct push to main");
  });

  it("refuses deleting main", () => {
    const { status } = runHook([`(delete) ${ZERO} refs/heads/main ${SHA}`]);

    assert.notEqual(status, 0, "a deletion is not a pull request either");
  });

  it("allows the push when ALLOW_PUSH_MAIN=1 says it is deliberate", () => {
    const { status, stderr } = runHook([`refs/heads/main ${SHA} refs/heads/main ${ZERO}`], {
      ALLOW_PUSH_MAIN: "1",
    });

    assert.equal(status, 0, "the documented override must work");
    assert.match(stderr, /ALLOW_PUSH_MAIN/, "the override must announce itself");
  });

  it("leaves tag pushes alone", () => {
    const { status, stderr } = runHook([`refs/tags/v9.9.9 ${SHA} refs/tags/v9.9.9 ${ZERO}`]);

    assert.notEqual(status, 0, "v9.9.9 has no CHANGELOG section, so the tag gate must still fire");
    assert.doesNotMatch(stderr, /pull request/i, "a tag is not a push to main");
  });
});

describe("pre-push: stdin is consumed once", () => {
  it("sees every ref line, not only the first", () => {
    // A second `while read` loop would swallow the trailing tag line and let it
    // through. Both refs must be judged.
    const { status } = runHook([
      `refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`,
      `refs/tags/v9.9.9 ${SHA} refs/tags/v9.9.9 ${ZERO}`,
    ]);

    assert.notEqual(status, 0, "the tag on the second stdin line must still be checked");
  });
});
