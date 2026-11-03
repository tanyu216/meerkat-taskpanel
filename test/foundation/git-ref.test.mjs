/**
 * The shared git ref probes (`src/foundation/git-ref.mjs`).
 *
 * The exit code carries the distinction the callers depend on: 1 means "the ref
 * is absent" (a caller may fall back), anything else non-zero means "git could
 * not answer" (a caller must not treat it as absent). The runner is injected,
 * so these tests never shell out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  probeGitRef,
  probeLocalBranch,
  readCurrentBranch,
} from "../../src/foundation/git-ref.mjs";

/** A runner that answers a fixed result and records the argv it was handed. */
function runner(result) {
  const calls = [];
  const run = (cmd, argv) => {
    calls.push([cmd, ...argv]);
    return result;
  };
  return { run, calls };
}

describe("probeGitRef", () => {
  it("reports an existing ref and probes the commit-ish form", () => {
    const { run, calls } = runner({ status: 0, stdout: "", stderr: "" });
    assert.deepEqual(probeGitRef({ projectDir: "/p", ref: " dev ", run }), {
      ok: true,
      exists: true,
    });
    assert.deepEqual(calls[0], [
      "git",
      "-C",
      "/p",
      "rev-parse",
      "--verify",
      "--quiet",
      "dev^{commit}",
    ]);
  });

  it("reports an absent ref as a usable answer (exit 1)", () => {
    const { run } = runner({ status: 1, stdout: "", stderr: "" });
    assert.deepEqual(probeGitRef({ projectDir: "/p", ref: "nope", run }), {
      ok: true,
      exists: false,
    });
  });

  it("distinguishes an unprobeable ref from an absent one (exit 128)", () => {
    const { run } = runner({ status: 128, stdout: "", stderr: "fatal: not a repository" });
    const result = probeGitRef({ projectDir: "/p", ref: "dev", run });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unresolvable");
    assert.match(result.stderr, /not a repository/);
  });

  it("reports a git that did not start as unavailable, never as absent", () => {
    const { run } = runner(null);
    assert.deepEqual(probeGitRef({ projectDir: "/p", ref: "dev", run }), {
      ok: false,
      reason: "unavailable",
    });
  });

  it("rejects an empty ref without running git", () => {
    const { run, calls } = runner({ status: 0, stdout: "", stderr: "" });
    assert.deepEqual(probeGitRef({ projectDir: "/p", ref: "  ", run }), {
      ok: false,
      reason: "empty",
    });
    assert.equal(calls.length, 0);
  });
});

describe("probeLocalBranch", () => {
  it("probes refs/heads/<ref>, so a tag is not a branch", () => {
    const { run, calls } = runner({ status: 1, stdout: "", stderr: "" });
    assert.deepEqual(probeLocalBranch({ projectDir: "/p", ref: "dev", run }), {
      ok: true,
      exists: false,
    });
    assert.deepEqual(calls[0], [
      "git",
      "-C",
      "/p",
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/dev",
    ]);
  });

  it("accepts an existing local branch", () => {
    const { run } = runner({ status: 0, stdout: "", stderr: "" });
    assert.deepEqual(probeLocalBranch({ projectDir: "/p", ref: "dev", run }), {
      ok: true,
      exists: true,
    });
  });
});

describe("readCurrentBranch", () => {
  it("returns the checked-out branch", () => {
    const { run } = runner({ status: 0, stdout: "dev\n", stderr: "" });
    assert.deepEqual(readCurrentBranch({ projectDir: "/p", run }), { ok: true, ref: "dev" });
  });

  it("refuses a detached HEAD", () => {
    const { run } = runner({ status: 0, stdout: "HEAD\n", stderr: "" });
    assert.deepEqual(readCurrentBranch({ projectDir: "/p", run }), {
      ok: false,
      reason: "detached",
    });
  });

  it("reports an unreadable checkout", () => {
    const { run } = runner({ status: 128, stdout: "", stderr: "fatal" });
    assert.deepEqual(readCurrentBranch({ projectDir: "/p", run }), {
      ok: false,
      reason: "unreadable",
    });
    assert.deepEqual(readCurrentBranch({ projectDir: "/p", run: () => null }), {
      ok: false,
      reason: "unreadable",
    });
  });
});
