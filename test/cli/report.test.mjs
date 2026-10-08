/**
 * Step 13: `report template` (A4, V6).
 *
 * The template has to be *usable*: its acceptance list comes off the card, its
 * evidence anchors are real, and what it prints is accepted by `deliver` without
 * editing. Two behaviours get explicit cover because they are the ones a
 * careless implementation gets wrong:
 *
 *   * it never claims `met` — an untouched template must not be a passing report;
 *   * it never fails because git is missing (a container has no `.git`).
 */

import assert from "node:assert/strict";
import test, { after, describe, it } from "node:test";

import { acceptanceFrom, evidenceFor, parseReport, runSync } from "../../src/cli/commands/report.mjs";
import { cleanupTempDirs, dataOf, withCli } from "./helpers/cli-harness.mjs";

after(cleanupTempDirs);

async function boardWithIssue(fn, extra = []) {
  return withCli(async (ctx) => {
    ctx.run(["project", "create", "--id", "demo", "--name", "Demo", "--workspace-path", ctx.dataDir, "--json"]);
    ctx.run(["issue", "create", "--project", "demo", "--title", "Ship M2", ...extra, "--json"]);
    return fn(ctx);
  });
}

describe("cli/report template", () => {
  it("lists the card's acceptance criteria one by one, all not_met", async () => {
    await boardWithIssue(
      async ({ run }) => {
        const data = dataOf(run(["report", "template", "DEMO-0001", "--commit", "dcd7d15", "--json"]));
        assert.equal(data.acceptance_source, "meta.acceptance");
        assert.deepEqual(
          data.report.acceptance.map((item) => [item.text, item.status]),
          [["cli works", "not_met"], ["gate visible", "not_met"]],
        );
        assert.match(data.report.leftovers, /TODO/);
        assert.match(data.report.conclusion, /^TODO/);
      },
      ["--acceptance", "cli works", "--acceptance", "gate visible"],
    );
  });

  it("falls back to the imported card's acceptance checkboxes, and says so", () => {
    // The legacy list is what the md migrator writes, so it is asserted against
    // the real shape rather than round-tripped through `--meta` (whose values
    // are strings).
    const legacy = acceptanceFrom({
      meta: {
        acceptance_legacy: [
          { text: "box one", checked: true },
          { text: "box two", checked: false },
        ],
      },
    });
    assert.equal(legacy.source, "meta.acceptance_legacy");
    // `checked: true` must NOT become `met`: a tick on an imported card is the
    // author's intent, not this delivery's evidence.
    assert.deepEqual(legacy.items.map((item) => [item.text, item.status]), [
      ["box one", "not_met"],
      ["box two", "not_met"],
    ]);
    assert.match(legacy.warning, /not evidence/);

    // Modern `meta.acceptance` wins over the legacy list.
    const modern = acceptanceFrom({ meta: { acceptance: ["a"], acceptance_legacy: [{ text: "b" }] } });
    assert.equal(modern.source, "meta.acceptance");
    assert.deepEqual(modern.items.map((i) => i.text), ["a"]);

    for (const task of [{ meta: {} }, { meta: { acceptance: [] } }, { meta: { acceptance_legacy: [] } }]) {
      const empty = acceptanceFrom(task);
      assert.equal(empty.source, "none");
      assert.deepEqual(empty.items, []);
      assert.match(empty.warning, /no acceptance items/);
    }
  });

  it("guesses evidence from git, and degrades without it", () => {
    const task = { identifier: "DEMO-0001", source_path: null };
    const fromGit = evidenceFor({ task, run: () => "0123abc\n" });
    assert.equal(fromGit.source, "git");
    assert.deepEqual(fromGit.anchors, [{ kind: "commit", sha: "0123abc" }]);

    // No git at all (a container has none): fall through to the task's source
    // path, then to a placeholder — never an empty list.
    const fromSource = evidenceFor({ task: { ...task, source_path: "cards/demo.md" }, run: () => null });
    assert.equal(fromSource.source, "source_path");
    assert.deepEqual(fromSource.anchors, [{ kind: "path", path: "cards/demo.md" }]);

    const placeholder = evidenceFor({ task, run: () => null });
    assert.equal(placeholder.source, "placeholder");
    assert.equal(placeholder.anchors.length, 1);

    // A nonsense git answer is not a commit.
    assert.equal(evidenceFor({ task, run: () => "not a sha" }).source, "placeholder");

    const explicit = evidenceFor({ task, commit: "abcdef1", run: () => "should-not-run" });
    assert.equal(explicit.source, "flags");
    assert.deepEqual(explicit.anchors, [{ kind: "commit", sha: "abcdef1" }]);
  });

  it("warns when the card carries no acceptance at all, and still produces a valid report", async () => {
    await boardWithIssue(async ({ run }) => {
      const result = run(["report", "template", "DEMO-0001", "--commit", "dcd7d15", "--json"]);
      assert.equal(result.status, 0);
      assert.match(result.stderr, /no acceptance items on this task/);
      const data = dataOf(result);
      assert.equal(data.acceptance_source, "none");
      assert.equal(data.report.acceptance.length, 1, "the title stands in, so the shape stays valid");
      assert.equal(data.report.acceptance[0].status, "not_met");
    });
  });

  it("turns explicit flags into anchors, verbatim", async () => {
    await boardWithIssue(async ({ run }) => {
      const data = dataOf(
        run([
          "report", "template", "DEMO-0001",
          "--commit", "abcdef1",
          "--path", "src/cli/index.mjs",
          "--path", "src/server/index.mjs",
          "--command", "node --test:0",
          "--command", "npm run check:1",
          "--coverage", "91.5@src/cli",
          "--json",
        ]),
      );
      assert.equal(data.evidence_source, "flags");
      assert.deepEqual(data.report.evidence, [
        { kind: "commit", sha: "abcdef1" },
        { kind: "path", path: "src/cli/index.mjs" },
        { kind: "path", path: "src/server/index.mjs" },
        { kind: "command", cmd: "node --test", exit_code: 0 },
        { kind: "command", cmd: "npm run check", exit_code: 1 },
        { kind: "coverage", lines: 91.5, scope: "src/cli" },
      ]);
    });
  });

  it("degrades without git instead of failing, and says the anchor is a placeholder", async () => {
    await boardWithIssue(async ({ run }) => {
      // No --commit and no --path: the command asks git. Whether git answers
      // depends on where the suite runs (a container has no .git), so assert the
      // *contract* — an exit of 0 and at least one anchor either way.
      const result = run(["report", "template", "DEMO-0001", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const data = dataOf(result);
      assert.ok(data.report.evidence.length >= 1, "a report with no evidence would be refused by deliver");
      assert.ok(["git", "source_path", "placeholder"].includes(data.evidence_source));
      if (data.evidence_source === "placeholder") {
        assert.match(result.stderr, /placeholder you must replace/);
      }
    });
  });

  it("prints something a human can edit, and what it prints delivers", async () => {
    await boardWithIssue(
      async ({ run }) => {
        run(["issue", "move", "DEMO-0001", "in_progress", "--json"]);
        const human = run(["report", "template", "DEMO-0001", "--commit", "dcd7d15"]);
        assert.equal(human.status, 0);
        assert.match(human.stdout, /"status": "not_met"/);
        assert.match(human.stderr, /replace every TODO line before delivering \(DEMO-0001\)/);
        // Redirecting stdout gives a file `deliver` accepts, with no editing of
        // the command line — the guidance went to stderr for exactly this.
        const redirected = JSON.parse(human.stdout);
        assert.equal(redirected.acceptance[0].status, "not_met");

        const delivered = run(["issue", "deliver", "DEMO-0001", "--report-file", "-", "--json"], {
          input: human.stdout,
        });
        assert.equal(delivered.status, 0, delivered.stderr);
        assert.equal(dataOf(delivered).status, "in_review");
      },
      ["--acceptance", "cli works"],
    );
  });
});

describe("cli/report — the parse and probe edges", () => {
  it("refuses a report that is not a JSON object", () => {
    assert.throws(() => parseReport("{oops"), (err) => err.code === "CLI_IO" && /not valid JSON/.test(err.message));
    assert.throws(() => parseReport("[1,2]"), (err) => err.code === "CLI_IO" && /must be a JSON object/.test(err.message));
    assert.throws(() => parseReport("null"), (err) => err.code === "CLI_IO");
    assert.deepEqual(parseReport('{"a":1}'), { a: 1 });
  });

  it("turns a --command without an exit code, and a --coverage without a scope, into valid anchors", () => {
    const anchors = evidenceFor({ task: { identifier: "X" }, commands: ["npm test"], coverage: ["91.5"] }).anchors;
    assert.deepEqual(anchors, [
      { kind: "command", cmd: "npm test", exit_code: 0 },
      { kind: "coverage", lines: 91.5 },
    ]);
  });

  it("probes a command and treats every kind of failure as 'no answer'", () => {
    // Node itself is the one binary that is certainly present here — the
    // verification image is slim and has no git, which is precisely the case the
    // probe is built to survive.
    assert.equal(typeof runSync(process.execPath, ["--version"]), "string", "a working binary answers");
    assert.equal(runSync(process.execPath, ["-e", "process.exit(3)"]), null, "a non-zero exit is no answer");
    assert.equal(runSync("taskpanel-not-a-real-binary-xyz", ["--version"]), null, "a missing binary is no answer");
  });

  it("falls back to the placeholder when git is missing entirely (the image case)", () => {
    const task = { identifier: "X", source_path: null };
    // What the container sees: no `.git` anywhere, so the probe answers nothing.
    const evidence = evidenceFor({ task, run: () => null });
    assert.equal(evidence.source, "placeholder");
    assert.equal(evidence.anchors[0].path, "<the files you changed>");
  });
});
