/**
 * Step 14: the card body — section splitting and the five line formats.
 *
 * These formats mirror the team's existing cards, so the shapes are asserted
 * literally rather than "round-trips somehow".
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  SECTION_ORDER,
  escapeInline,
  joinSections,
  parseAcceptanceBlock,
  parseCommentsBlock,
  parseProgressBlock,
  parseReportBlock,
  parseSessionsBlock,
  renderAcceptanceBlock,
  renderCommentsBlock,
  renderProgressBlock,
  renderReportBlock,
  renderSessionsBlock,
  splitProgressLine,
  splitSections,
  unescapeInline,
} from "../../../../src/core/storage/md/sections.mjs";

describe("md/sections — splitting", () => {
  it("splits on `##` headings and keeps the order it found", () => {
    const { sections, extra } = splitSections(
      [
        "preamble text",
        "",
        "## Report",
        "r",
        "",
        "## Background",
        "b",
        "",
        "## Comments",
        "c",
      ].join("\n"),
    );
    assert.deepEqual([...sections.keys()], ["Report", "Background", "Comments"]);
    assert.equal(sections.get("Background"), "b");
    assert.equal(extra, "preamble text", "content before the first heading is preserved");
  });

  it("trims blank lines around a section and treats a heading with nothing under it as empty", () => {
    const { sections } = splitSections("## Progress\n\n\n## Sessions\n- x\n\n");
    assert.equal(sections.get("Progress"), "");
    assert.equal(sections.get("Sessions"), "- x");
  });

  it("renders in the canonical order, with one blank line between sections", () => {
    const sections = new Map([
      ["Report", ""],
      ["Background", "text"],
      ["Comments", ""],
    ]);
    const body = joinSections(sections);
    assert.equal(body, "## Background\n\ntext\n\n## Comments\n\n## Report\n");
    assert.deepEqual(SECTION_ORDER, [
      "Background",
      "Acceptance",
      "Progress",
      "Comments",
      "Sessions",
      "Report",
    ]);
    // Unknown sections are appended rather than dropped.
    assert.match(joinSections(new Map([["Extra", "x"]])), /^## Extra\n\nx\n$/);
  });
});

describe("md/sections — acceptance", () => {
  it("reads and writes the checkbox list", () => {
    const items = parseAcceptanceBlock("- [x] done thing\n- [ ] open thing\n\n");
    assert.deepEqual(items, [
      { text: "done thing", checked: true },
      { text: "open thing", checked: false },
    ]);
    assert.equal(renderAcceptanceBlock(items), "- [x] done thing\n- [ ] open thing");
    assert.deepEqual(parseAcceptanceBlock(""), []);
    assert.deepEqual(parseAcceptanceBlock("- [X] shouty"), [{ text: "shouty", checked: true }]);
  });

  it("refuses a line that is not a checkbox", () => {
    assert.throws(() => parseAcceptanceBlock("- no checkbox"), (err) => {
      assert.equal(err.code, "MD_PARSE_ERROR");
      assert.equal(err.details.section, "Acceptance");
      return true;
    });
  });
});

describe("md/sections — progress", () => {
  it("keeps one note per line and splits the timestamp off", () => {
    const lines = parseProgressBlock("- 2026-10-08T00:00:00.000Z did a thing\n\n- plain note");
    assert.deepEqual(lines, ["2026-10-08T00:00:00.000Z did a thing", "plain note"]);
    assert.deepEqual(splitProgressLine(lines[0]), { ts: "2026-10-08T00:00:00.000Z", text: "did a thing" });
    assert.deepEqual(splitProgressLine("no timestamp here"), { ts: "", text: "no timestamp here" });
    assert.deepEqual(splitProgressLine(""), { ts: "", text: "" });
    assert.equal(renderProgressBlock([{ ts: "", text: "no timestamp here" }]), "- no timestamp here");
    assert.equal(
      renderProgressBlock([{ ts: "2026-10-08T00:00:00.000Z", text: "did a thing" }]),
      "- 2026-10-08T00:00:00.000Z did a thing",
    );
  });
});

describe("md/sections — comments", () => {
  it("parses the `<ts> · <kind> · <author> — <body>` shape", () => {
    const comments = parseCommentsBlock(
      "- 2026-10-08T00:00:00.000Z · decision · elon — approved\\nsecond line\n- 2026-10-08T01:00:00.000Z · note · linus — a — dash in the body",
    );
    assert.deepEqual(comments, [
      {
        ts: "2026-10-08T00:00:00.000Z",
        kind: "decision",
        authorId: "elon",
        body: "approved\nsecond line",
      },
      {
        ts: "2026-10-08T01:00:00.000Z",
        kind: "note",
        authorId: "linus",
        body: "a — dash in the body",
      },
    ]);
    assert.deepEqual(parseCommentsBlock(""), []);
  });

  it("refuses a line without the separators", () => {
    for (const line of ["- not a comment", "- ts · kind"]) {
      assert.throws(() => parseCommentsBlock(line), (err) => {
        assert.equal(err.code, "MD_PARSE_ERROR");
        return true;
      });
    }
  });

  it("escapes bodies onto one line and back", () => {
    assert.equal(escapeInline("a\nb\\c"), "a\\nb\\\\c");
    assert.equal(unescapeInline("a\\nb\\\\c"), "a\nb\\c");
    const rendered = renderCommentsBlock([
      { ts: "t", kind: "note", authorId: "linus", body: "line one\nline two" },
    ]);
    assert.equal(rendered, "- t · note · linus — line one\\nline two");
    assert.equal(parseCommentsBlock(rendered)[0].body, "line one\nline two");
  });
});

describe("md/sections — sessions", () => {
  it("parses the team's key:value session lines, empty pid included", () => {
    const sessions = parseSessionsBlock(
      [
        "- seg:seg1 · owner:linus · backend:claude · id:32306ef3-a9ad-5453-b300-5f12642ac16f · phase:plan · status:closed · pid: · 2026-10-01T00:00:00.000Z",
        "- seg:seg2 · owner:linus · backend:claude · id:ff309028 · status:running · 2026-10-02T00:00:00.000Z",
      ].join("\n"),
    );
    assert.equal(sessions[0].seg, "seg1");
    assert.equal(sessions[0].pid, "");
    assert.equal(sessions[0].ts, "2026-10-01T00:00:00.000Z");
    assert.equal(sessions[1].phase, "", "a missing field becomes an empty string");
    assert.equal(sessions[1].status, "running");
    assert.equal(renderSessionsBlock([sessions[0]]).startsWith("- seg:seg1 · owner:linus"), true);
    assert.equal(renderSessionsBlock([sessions[0]]), `- seg:seg1 · owner:linus · backend:claude · id:32306ef3-a9ad-5453-b300-5f12642ac16f · phase:plan · status:closed · pid: · 2026-10-01T00:00:00.000Z`);
  });

  it("refuses a session line without a timestamp or with an unknown field", () => {
    assert.throws(() => parseSessionsBlock("- seg:seg1 · owner:linus"), (err) => /timestamp/.test(err.message));
    assert.throws(() => parseSessionsBlock("- seg:seg1 · whatever:1 · 2026-10-01T00:00:00.000Z"), (err) => {
      assert.match(err.message, /unknown session field/);
      assert.deepEqual(err.details.allowed, ["seg", "owner", "backend", "id", "phase", "status", "pid"]);
      return true;
    });
    assert.throws(() => parseSessionsBlock("- notakeyvalue · 2026-10-01T00:00:00.000Z"), (err) =>
      /<name>:<value>/.test(err.message),
    );
  });
});

describe("md/sections — report", () => {
  it("parses the single legacy body as round 1", () => {
    const reports = parseReportBlock("Just a conclusion.\n\nMore of it.");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].round, 1);
    assert.equal(reports[0].ts, null);
    assert.equal(reports[0].conclusion, "Just a conclusion.\n\nMore of it.");
    assert.deepEqual(reports[0].acceptance, []);
    assert.equal(reports[0].leftovers, null);
  });

  it("parses one block per round, with acceptance, evidence and leftovers", () => {
    const reports = parseReportBlock(
      [
        "### R1 · 2026-10-07T02:00:00.000Z · linus",
        "",
        "First attempt.",
        "",
        "acceptance:",
        "- [partial] criterion — needs work",
        "",
        "evidence:",
        "- commit 1111111",
        "- path src/core/index.mjs",
        "- command exit 0 · node --test",
        "- coverage 91.5 · src/core/**",
        "",
        "leftovers: the container run",
        "",
        "### R2 · 2026-10-08T02:00:00.000Z · linus",
        "",
        "Second attempt.",
      ].join("\n"),
    );
    assert.equal(reports.length, 2);
    assert.equal(reports[0].round, 1);
    assert.deepEqual(reports[0].acceptance, [
      { status: "partial", text: "criterion", note: "needs work" },
    ]);
    assert.deepEqual(reports[0].evidence, [
      { kind: "commit", sha: "1111111" },
      { kind: "path", path: "src/core/index.mjs" },
      { kind: "command", exit_code: 0, cmd: "node --test" },
      { kind: "coverage", lines: 91.5, scope: "src/core/**" },
    ]);
    assert.equal(reports[0].leftovers, "the container run");
    assert.equal(reports[1].round, 2);
    assert.equal(reports[1].conclusion, "Second attempt.");
  });

  it("round-trips through the renderer", () => {
    const reports = [
      {
        round: 1,
        ts: "2026-10-07T02:00:00.000Z",
        authorId: "linus",
        conclusion: "Done.",
        acceptance: [{ text: "a", status: "met" }, { text: "b", status: "not_met", note: "why" }],
        evidence: { items: [{ kind: "commit", sha: "abc1234" }], truncated: false },
        leftovers: "one thing",
      },
    ];
    const rendered = renderReportBlock(reports);
    assert.match(rendered, /^### R1 · 2026-10-07T02:00:00\.000Z · linus\n\nDone\./);
    const back = parseReportBlock(rendered);
    assert.deepEqual(back, [
      {
        round: 1,
        ts: "2026-10-07T02:00:00.000Z",
        authorId: "linus",
        conclusion: "Done.",
        acceptance: [
          { status: "met", text: "a" },
          { status: "not_met", text: "b", note: "why" },
        ],
        evidence: [{ kind: "commit", sha: "abc1234" }],
        leftovers: "one thing",
      },
    ]);
  });

  it("refuses evidence it cannot render or parse", () => {
    assert.throws(
      () => parseReportBlock("### R1 · t · a\n\nevidence:\n- screenshot x.png"),
      (err) => {
        assert.equal(err.code, "MD_PARSE_ERROR");
        assert.match(err.message, /unknown evidence anchor/);
        return true;
      },
    );
    assert.throws(
      () => parseReportBlock("### R1 · t · a\n\nevidence:\n- command node --test"),
      (err) => /command anchors look like/.test(err.message),
    );
    assert.throws(
      () => parseReportBlock("### R1 · t · a\n\nacceptance:\n- no brackets"),
      (err) => /look like '- \[met\] text'/.test(err.message),
    );
    assert.throws(
      () => renderReportBlock([{ round: 1, ts: "t", authorId: "a", conclusion: "x", acceptance: [], evidence: { items: [{ kind: "screenshot" }] }, leftovers: null }]),
      (err) => err.code === "REPORT_INVALID",
    );
  });

  it("treats an empty report section as no rounds at all", () => {
    assert.deepEqual(parseReportBlock(""), []);
    assert.deepEqual(parseReportBlock("\n\n"), []);
  });
});
