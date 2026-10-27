/**
 * Tests for `.githooks/pre-push`.
 *
 * The hook is a thin POSIX `sh` wrapper over `scripts/verify/contract.mjs`,
 * `scripts/verify/route-request.mjs` and `scripts/verify/changelog.mjs`, plus two
 * rules of its own: a direct push to `main` is refused, because `main` advances
 * through a pull request, and a branch push runs the container gate
 * (`npm run verify:docker`) after the static gates pass. GitHub's branch-protection
 * rule is the enforcement for the first; this is the local, early half — it fires
 * before the network, so a mistaken `git push origin main` costs nothing. The
 * container gate is the local half of the CI `docker` job, which is why a merge no
 * longer ends with a separate container run.
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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * `ALLOW_PUSH_MAIN` and `SKIP_CONTAINER_VERIFY` are stripped from the inherited
 * environment so a developer who happens to have either exported does not turn a
 * refusal (or a gate) green. Every case opts out of the container gate by default:
 * it builds the image, which is not this file's subject. The cases that *are*
 * about it put a fake `npm` first on `PATH` instead.
 */
function runHook(lines, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.ALLOW_PUSH_MAIN;
  delete childEnv.SKIP_CONTAINER_VERIFY;
  childEnv.SKIP_CONTAINER_VERIFY = "1";
  Object.assign(childEnv, env);

  const result = spawnSync("sh", [HOOK], {
    cwd: ROOT,
    encoding: "utf8",
    input: lines.map((line) => `${line}\n`).join(""),
    env: childEnv,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Put a fake `npm` first on PATH and return the directory holding it.
 *
 * The hook must reach the container gate without this file ever building an image;
 * the shim records the invocation and exits with `FAKE_NPM_EXIT` (default 0). Real
 * `node` stays on PATH, so the static gates still run for real.
 */
function fakeNpm(t, marker) {
  const dir = mkdtempSync(join(tmpdir(), "pre-push-npm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "npm"),
    `#!/bin/sh\necho "${marker}:$*"\nexit "\${FAKE_NPM_EXIT:-0}"\n`,
  );
  chmodSync(join(dir, "npm"), 0o755);
  return { dir, path: `${dir}:${process.env.PATH ?? ""}` };
}

describe("pre-push: the two API gates always run", () => {
  it("runs the contract and route-request checkers on an ordinary branch push", () => {
    const { status, stdout } = runHook([`refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`]);

    assert.equal(status, 0, "a feature-branch push must pass");
    assert.match(stdout, /^contract: OK/m);
    assert.match(stdout, /^route-request: OK/m);
    assert.match(stdout, /^version: OK/m, "the four version carriers are checked too");
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
    assert.match(stderr, /tag-version: FAILED/, "the tag must also name the tree's version");
    assert.match(stderr, /changelog: FAILED/, "and carry a filled section");
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

describe("pre-push: the container gate runs on a branch push", () => {
  it("runs verify:docker after the static gates", (t) => {
    const npm = fakeNpm(t, "container-gate");
    const { status, stdout } = runHook(
      [`refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`],
      { PATH: npm.path, SKIP_CONTAINER_VERIFY: "0" },
    );

    assert.equal(status, 0, "the fake gate exits 0, so the push passes");
    assert.match(stdout, /container-gate:run verify:docker/);
    assert.ok(
      stdout.indexOf("contract: OK") < stdout.indexOf("container-gate:"),
      "the cheap static gates must run — and pass — before the image is built",
    );
  });

  it("refuses the push when the container gate fails", (t) => {
    const npm = fakeNpm(t, "container-gate");
    const { status } = runHook([`refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`], {
      PATH: npm.path,
      SKIP_CONTAINER_VERIFY: "0",
      FAKE_NPM_EXIT: "1",
    });

    assert.notEqual(status, 0, "a red container gate must stop the push");
  });

  it("does not build the image when an earlier gate already failed", (t) => {
    // A direct push to main is refused above; spending minutes on the image build
    // to then fail anyway would punish the mistake. The marker must be absent.
    const npm = fakeNpm(t, "container-gate");
    const { status, stdout } = runHook([`refs/heads/main ${SHA} refs/heads/main ${ZERO}`], {
      PATH: npm.path,
      SKIP_CONTAINER_VERIFY: "0",
    });

    assert.notEqual(status, 0);
    assert.doesNotMatch(stdout, /container-gate:/);
  });

  it("skips it on SKIP_CONTAINER_VERIFY=1 and says so", (t) => {
    const npm = fakeNpm(t, "container-gate");
    const { status, stdout, stderr } = runHook(
      [`refs/heads/feature ${SHA} refs/heads/feature ${ZERO}`],
      { PATH: npm.path, SKIP_CONTAINER_VERIFY: "1" },
    );

    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /container-gate:/, "the escape hatch must really skip it");
    assert.match(stderr, /SKIP_CONTAINER_VERIFY/, "the skip must announce itself");
  });

  it("does not run for a branch deletion", (t) => {
    const npm = fakeNpm(t, "container-gate");
    const { status, stdout } = runHook([`(delete) ${ZERO} refs/heads/feature ${SHA}`], {
      PATH: npm.path,
      SKIP_CONTAINER_VERIFY: "0",
    });

    assert.equal(status, 0, "deleting a remote branch changes no tree");
    assert.doesNotMatch(stdout, /container-gate:/);
  });

  it("does not run for a tag-only push", (t) => {
    // The commit behind a release tag was already pushed (and gated); re-running the
    // suite for the tag alone would only repeat it. A non-version tag keeps this
    // leg independent of whichever CHANGELOG sections happen to exist.
    const npm = fakeNpm(t, "container-gate");
    const { status, stdout } = runHook(
      [`refs/tags/scratch ${SHA} refs/tags/scratch ${ZERO}`],
      { PATH: npm.path, SKIP_CONTAINER_VERIFY: "0" },
    );

    assert.equal(status, 0, "a tag-only push skips the container gate");
    assert.doesNotMatch(stdout, /container-gate:/);
  });
});
