/**
 * `scripts/verify/paths.mjs` — the host-path gate.
 *
 * Two halves, because the checker has two halves:
 *
 *   * the **pure rule** — which path names are findings and which are placeholders or
 *     fixtures. Tested directly, without a filesystem, because that decision is the one
 *     a reader is most likely to disagree with;
 *   * the **three allowlist assertions**, each exercised against a crafted root so it
 *     can be seen to *fail*. A gate whose failure path is untested is indistinguishable
 *     from a gate that always passes — and this one exists precisely because the defect
 *     it looks for had been sitting in the tree unnoticed for several rounds.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ALLOWLIST_FILE, analyze, hostNamesIn, offendingNamesIn } from "../../scripts/verify/paths.mjs";

const roots = [];
/** A throwaway root. `tmpdir()` is outside any git checkout, so `listFiles` walks. */
function makeRoot({ files = {}, allowlist = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-paths-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  }
  if (allowlist !== null) {
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    writeFileSync(join(root, ALLOWLIST_FILE), typeof allowlist === "string" ? allowlist : JSON.stringify({ entries: allowlist }));
  }
  return root;
}
after(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing a suite over */
    }
  }
});

/**
 * A name no one reserved, and the root segment, both built as values rather than
 * written as a path.
 *
 * This is not the test dodging the rule it tests. The fixture this suite needs is a
 * *name* and a *root*, and a file that spelled them out as `/Users/…` would be the very
 * thing the checker forbids — so the checker would flag its own test, which is exactly
 * what happened the first time this file was committed. Values keep the two apart: the
 * rule is exercised, and no path is written down.
 */
const ROOT_SEGMENT = "Users";
const UNRESERVED = "zaphod";
const hostPath = (name, rest = "x", root = ROOT_SEGMENT) => `/${root}/${name}/${rest}`;

const REAL = `${hostPath(UNRESERVED, ".openclaw/team/workspace/T-1/verify")}\n`;
const INSTRUCTION = `Run \`node ${hostPath(UNRESERVED, "probe.mjs")}\` to reproduce.\n`;

describe("verify/paths — which names are findings", () => {
  it("reads every /Users and /home name in a text", () => {
    assert.deepEqual(
      hostNamesIn(`a ${hostPath("alice")} and ${hostPath("bob", "y", "home")} and ${hostPath("alice", "z")}`),
      ["alice", "bob", "alice"],
    );
    assert.deepEqual(hostNamesIn("nothing here"), []);
    assert.deepEqual(hostNamesIn(""), []);
  });

  it("treats the reserved placeholder and fixture names as naming no machine", () => {
    // The two kinds this gate must not flag: `/Users/you` is the thing a reader
    // substitutes into (skill references, docs/scheduling.md), and the fixture cast is
    // an argument to a pure path function under test, in the same spirit as `/tmp/…`.
    for (const name of ["you", "op", "alice", "tester", "team"]) {
      assert.deepEqual(offendingNamesIn(`/Users/${name}/x`), [], `/Users/${name} is a placeholder`);
      assert.deepEqual(offendingNamesIn(`/home/${name}/x`), [], `/home/${name} is a fixture`);
    }
  });

  it("flags a name that is not on the reserved list", () => {
    assert.deepEqual(offendingNamesIn(REAL), [UNRESERVED]);
    assert.deepEqual(offendingNamesIn(INSTRUCTION), [UNRESERVED]);
    // A reserved name beside an unreserved one: only the second is a finding.
    assert.deepEqual(offendingNamesIn(`${hostPath(UNRESERVED)} and /home/you`), [UNRESERVED]);
  });

  it("does not mistake a deeper segment for a name", () => {
    // `/Users/you/code` is a placeholder; the rule keys on the segment right after the
    // root, so nothing here may report `code` or `.openclaw`.
    assert.deepEqual(hostNamesIn("/Users/you/code/meerkat-taskpanel"), ["you"]);
    assert.deepEqual(hostNamesIn("/home/you/.nvm/versions/node/v24"), ["you"]);
  });
});

describe("verify/paths — the allowlist, in both directions", () => {
  it("passes a tree with no host path at all", () => {
    const root = makeRoot({ files: { "src/a.mjs": "const x = 1;\n" }, allowlist: [] });
    const result = analyze(root);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  it("fails a file that carries a host path and is not on the list", () => {
    const root = makeRoot({ files: { "docs/notes.md": INSTRUCTION }, allowlist: [] });
    const result = analyze(root);
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /docs\/notes\.md/);
    assert.match(result.problems[0], new RegExp(`carries a host path \\("${UNRESERVED}"\\)`));
  });

  it("passes a listed file whose path is still there", () => {
    const root = makeRoot({ files: { "docs/verify/T-1/report.md": REAL }, allowlist: ["docs/verify/T-1/report.md"] });
    const result = analyze(root);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings.map((f) => f.file), ["docs/verify/T-1/report.md"]);
  });

  it("fails an entry whose file is gone — the list cannot keep dead weight", () => {
    const root = makeRoot({ files: { "src/a.mjs": "x\n" }, allowlist: ["docs/verify/T-1/report.md"] });
    const problems = analyze(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no longer exists/);
  });

  it("fails an entry whose file has been cleaned up but left its entry behind", () => {
    // The interesting half: without this, someone could clean a file up and the list
    // would quietly stop meaning "still to be cleaned".
    const root = makeRoot({ files: { "docs/verify/T-1/report.md": "no paths here\n" }, allowlist: ["docs/verify/T-1/report.md"] });
    const problems = analyze(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no longer carries a host path/);
  });

  it("fails a malformed allowlist rather than treating it as empty", () => {
    const root = makeRoot({ files: { "docs/n.md": INSTRUCTION }, allowlist: "{ not json" });
    const problems = analyze(root).problems;
    assert.equal(problems.some((p) => p.includes(ALLOWLIST_FILE)), true, "an unreadable list must be a problem");
    assert.equal(problems.some((p) => p.includes("does not exist")), false, "…and must not be read as `no entries`");
    assert.equal(problems.some((p) => p.includes("carries a host path")), true);
  });

  it("reports both directions at once when a tree is wrong in both", () => {
    const root = makeRoot({
      files: { "docs/new.md": INSTRUCTION, "docs/verify/T-9/report.md": "clean now\n" },
      allowlist: ["docs/verify/T-9/report.md", "docs/verify/T-8/report.md"],
    });
    const problems = analyze(root).problems;
    assert.equal(problems.length, 3, "one unlisted offender, one cleaned entry, one missing entry");
  });
});
