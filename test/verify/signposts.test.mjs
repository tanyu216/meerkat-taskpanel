/**
 * `scripts/verify/signposts.mjs` — the gate against signposts out of this repository.
 *
 * Three halves, because the checker has three jobs:
 *
 *   * the **two rules** — what is a signpost and what deliberately is not. Tested
 *     directly, without a filesystem, because those decisions are the ones a reader is
 *     most likely to disagree with;
 *   * the **exclusions**, pinned as regression guards. The tempting version of this gate
 *     bans every framework word; the contract it backs keeps several of them on purpose.
 *     Without these assertions a later "let's also ban the other one" would land silently
 *     — and would red shipped code and a test suite when it did;
 *   * the **three allowlist assertions**, each exercised against a crafted root so it can
 *     be seen to *fail*. A gate whose failure path is untested is indistinguishable from
 *     a gate that always passes.
 *
 * The last test runs the gate against the real tree. Its sibling (`paths.test.mjs`) does
 * not do that for itself; this one must, because the whole point of the exercise is that
 * the tree is clean *now* and that the one exemption is the one it claims to be.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ALLOWLIST_FILE, ROOT, analyze, signpostsIn } from "../../scripts/verify/signposts.mjs";

const roots = [];
/** A throwaway root. `tmpdir()` is outside any git checkout, so `listFiles` walks. */
function makeRoot({ files = {}, allowlist = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "meerkat-taskpanel-signposts-"));
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
 * The terms this gate looks for, built from fragments rather than written down.
 *
 * Same reason as its sibling's `hostPath` helper, and a stronger one: this file is
 * tracked text under the very rule it tests, and the first draft of the checker was
 * flagged by itself for spelling its own subject. The rules are exercised either way —
 * what is kept apart is the *test* and the *thing tested*.
 */
const VENDOR_DIR = ".open" + "claw";
const STORE_DIR = `${VENDOR_DIR}/team`;
const STORE = { tilde: `~/${STORE_DIR}`, dollar: `$HOME/${STORE_DIR}`, braces: `\${HOME}/${STORE_DIR}`, lower: `$home/${STORE_DIR}` };
const MECHANISM = {
  cardWriter: "task-" + "ops",
  laneLauncher: "spawn-" + "lane",
  laneReaper: "lane-" + "reaper",
  sessionRegistry: "claude-sessions" + ".json",
  governance: "redlines" + ".core.md",
};

describe("verify/signposts — the store-root rule", () => {
  it("flags a home-relative path into the store, in every prefix spelling", () => {
    for (const [spelling, store] of Object.entries(STORE)) {
      assert.deepEqual(signpostsIn(`${store}/PROTOCOL.md`), ["store-root"], spelling);
      assert.deepEqual(signpostsIn(`see ${store}/skills/x\n`), ["store-root"], spelling);
      assert.deepEqual(signpostsIn(`${store}`), ["store-root"], `${spelling} bare`);
    }
  });

  it("leaves the two documented integration subpaths alone", () => {
    // The migration feature reads the team's cards and its project registry; those two
    // subpaths are the product's documented interface to the store, and they are carved
    // out inside the rule rather than parked on the allowlist.
    assert.deepEqual(signpostsIn(`${STORE.tilde}/tasks`), []);
    assert.deepEqual(signpostsIn(`${STORE.tilde}/tasks/*.md`), []);
    assert.deepEqual(signpostsIn(`${STORE.tilde}/projects.json`), []);
    assert.deepEqual(signpostsIn(`${STORE.dollar}/projects.json:/projects.json:ro`), []);
    // A frozen copy of the registry is the same integration surface, not a signpost.
    assert.deepEqual(signpostsIn(`cp ${STORE.tilde}/projects.json ${STORE.tilde}/projects.json.frozen-2026-10-17`), []);
  });

  it("carves the two subpaths out by name, not by prefix", () => {
    // A longer name is a different segment, and is a signpost again.
    assert.deepEqual(signpostsIn(`${STORE.tilde}/tasksfoo`), ["store-root"]);
    // The boundary after the name is what decides, so a further extension of a carved-out
    // *file* stays carved out: a dated freeze of the registry is the same surface.
    assert.deepEqual(signpostsIn(`${STORE.tilde}/projects.json.frozen-2026-10-17`), []);
  });

  it("leaves the vendor's own skills root alone — that is an install target", () => {
    // `~/.openclaw/skills/…` is where the board gets installed *into* the vendor's host,
    // which is a product capability, not the framework's private store.
    assert.deepEqual(signpostsIn(`cp -r skills/meerkat-taskpanel ~/${VENDOR_DIR}/skills/`), []);
    assert.deepEqual(signpostsIn("~/.claude/skills/meerkat-taskpanel"), []);
    assert.deepEqual(signpostsIn("~/.codex/skills/meerkat-taskpanel"), []);
  });

  it("leaves code that assembles the same directory from parts alone", () => {
    // Reaching an integration point is not pointing a reader at one. The rule requires a
    // home-relative literal for exactly this reason.
    assert.deepEqual(signpostsIn(`join(homedir(), ".openclaw", "team")`), []);
    assert.deepEqual(signpostsIn(`process.env.OPENCLAW_TEAM_ROOT ?? join(homedir(), ".openclaw", "team")`), []);
  });
});

describe("verify/signposts — the mechanism-word rule", () => {
  it("flags every internal mechanism name", () => {
    for (const [what, word] of Object.entries(MECHANISM)) {
      assert.deepEqual(signpostsIn(`the ${word} step`), ["mechanism-word"], what);
    }
  });

  it("reports both rules when a file carries both", () => {
    assert.deepEqual(signpostsIn(`${MECHANISM.cardWriter} lives at ${STORE.tilde}/skills/${MECHANISM.cardWriter}/lib`), [
      "mechanism-word",
      "store-root",
    ]);
  });
});

describe("verify/signposts — what the gate deliberately does not ban", () => {
  // These pin the judgement calls the naming-boundary contract makes. Each one is a
  // shipped surface or a pinned test assertion; a later change that bans them would red
  // code or a suite, and these assertions are the tripwire that says so *here* instead.
  it("keeps the framework's published protocol anchors", () => {
    assert.deepEqual(signpostsIn("the PROTOCOL §⑮ timeout table"), []);
    assert.deepEqual(signpostsIn('assert.match(row.ref, /^PROTOCOL §⑮/)'), []);
  });

  it("keeps the framework's project name and interface codename", () => {
    assert.deepEqual(signpostsIn("the openclaw-team framework ships its own supervisor"), []);
    assert.deepEqual(signpostsIn("boardInterface: `task-interface v1`"), []);
    assert.deepEqual(signpostsIn("see guides/task-interface.md §14 for the reading"), []);
  });

  it("keeps the loop's compatibility declaration", () => {
    assert.deepEqual(signpostsIn("required board interface generation: task-interface v1"), []);
  });
});

describe("verify/signposts — the allowlist, in both directions", () => {
  const cleaner = { file: "src/a.mjs", rule: "mechanism-word", reason: "a test entry" };

  it("passes a tree with no signpost at all", () => {
    const root = makeRoot({ files: { "src/a.mjs": "const x = 1;\n" }, allowlist: [] });
    const result = analyze(root);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
  });

  it("fails a file that carries a signpost and is not on the list", () => {
    const root = makeRoot({ files: { "docs/notes.md": `the ${MECHANISM.cardWriter} step\n` }, allowlist: [] });
    const result = analyze(root);
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /docs\/notes\.md/);
    assert.match(result.problems[0], /carries a mechanism-word signpost/);
  });

  it("passes a listed (file, rule) pair whose file is still there", () => {
    const allowed = { file: "docs/a.md", rule: "mechanism-word", reason: "a test entry" };
    const root = makeRoot({ files: { "docs/a.md": `the ${MECHANISM.cardWriter} step\n` }, allowlist: [allowed] });
    const result = analyze(root);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.findings, [{ file: "docs/a.md", rules: ["mechanism-word"] }]);
  });

  it("does NOT let a mechanism-word entry hide a store path in the same file", () => {
    // The reason entries are {file, rule} pairs and not bare paths. The contract has to
    // name the mechanism words; it must never spell the store root — and a file-level
    // exemption would have granted exactly that.
    const root = makeRoot({
      files: { "docs/a.md": `${MECHANISM.cardWriter} and ${STORE.tilde}/skills/x\n` },
      allowlist: [{ file: "docs/a.md", rule: "mechanism-word", reason: "a test entry" }],
    });
    const problems = analyze(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /carries a store-root signpost/);
  });

  it("fails an entry whose file is gone — the list cannot keep dead weight", () => {
    const root = makeRoot({ files: { "src/other.mjs": "x\n" }, allowlist: [cleaner] });
    const problems = analyze(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no longer exists/);
  });

  it("fails an entry whose file has been cleaned up but left its entry behind", () => {
    const root = makeRoot({ files: { "src/a.mjs": "nothing here\n" }, allowlist: [cleaner] });
    const problems = analyze(root).problems;
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no longer offends it/);
  });

  it("fails an entry naming a rule that does not exist", () => {
    const root = makeRoot({ files: { "src/a.mjs": `the ${MECHANISM.cardWriter} step\n` }, allowlist: [{ ...cleaner, rule: "no-such-rule" }] });
    const problems = analyze(root).problems;
    assert.equal(problems.some((p) => p.includes("is not one of")), true);
  });

  it("fails a malformed allowlist rather than treating it as empty", () => {
    const root = makeRoot({ files: { "docs/n.md": `the ${MECHANISM.cardWriter} step\n` }, allowlist: "{ not json" });
    const problems = analyze(root).problems;
    assert.equal(problems.some((p) => p.includes(ALLOWLIST_FILE)), true, "an unreadable list must be a problem");
    assert.equal(problems.some((p) => p.includes("no longer exists")), false, "…and must not be read as `no entries`");
    assert.equal(problems.some((p) => p.includes("carries a mechanism-word signpost")), true);
  });

  it("reports both directions at once when a tree is wrong in both", () => {
    const root = makeRoot({
      files: { "docs/new.md": `${STORE.tilde}/x\n`, "src/a.mjs": "clean now\n" },
      allowlist: [cleaner, { ...cleaner, file: "src/gone.mjs" }],
    });
    assert.equal(analyze(root).problems.length, 3, "one unlisted offender, one cleaned entry, one missing entry");
  });
});

describe("verify/signposts — the real tree", () => {
  it("is clean, with exactly the one exemption the contract needs", () => {
    const result = analyze(ROOT);
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.findings,
      [{ file: "design/contracts/naming-boundary.md", rules: ["mechanism-word"] }],
      "only the contract that bans the terms may name them — a second finding means a new signpost",
    );
  });
});
