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

  it("tolerates a line that is not a checkbox — and records a notice", () => {
    const notices = [];
    const items = parseAcceptanceBlock(
      [
        "- [ ] one",
        "> 并行标注：needs a decision",
        "- [x] two",
        "  - a nested sub-bullet",
        "",
        "a plain prose line",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(items, [
      { text: "one", checked: false },
      { text: "two", checked: true },
    ]);
    assert.equal(notices.length, 3, "the quote note, the nested bullet and the prose");
    assert.deepEqual(notices[0], { section: "Acceptance", line: 2, text: "> 并行标注：needs a decision" });
    assert.equal(notices[1].line, 4);
    assert.equal(notices[2].text, "a plain prose line");
  });

  it("keeps the checkbox items even when nothing else is parseable", () => {
    assert.deepEqual(parseAcceptanceBlock("just prose\nand more"), []);
    assert.deepEqual(parseAcceptanceBlock("- ordinary bullet"), []);
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

  it("tolerates a line without the separators — and records a notice", () => {
    const notices = [];
    const comments = parseCommentsBlock(
      [
        "- 2026-10-08T00:00:00.000Z · note · linus — kept",
        "① a continuation line with no bullet and no separator",
        "- 2026-10-08T00:00:00.000Z · note · linus",
        "- ts · kind",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(comments, [
      { ts: "2026-10-08T00:00:00.000Z", kind: "note", authorId: "linus", body: "kept" },
    ]);
    assert.equal(notices.length, 3);
    assert.deepEqual(
      notices.map((notice) => notice.line),
      [2, 3, 4],
    );
    assert.equal(notices[0].section, "Comments");
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

  it("tolerates the template placeholder comment and keeps the real sessions", () => {
    const notices = [];
    const sessions = parseSessionsBlock(
      [
        "<!-- 子会话关联（resume 依据）：每段一行 · 字段 seg/owner/backend/id/phase/status/pid -->",
        "- seg:seg1 · owner:linus · backend:claude · id:sess-1 · phase:plan · status:closed · pid: · 2026-10-01T00:00:00.000Z",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(sessions.map((session) => session.seg), ["seg1"], "only the real session is kept");
    assert.equal(notices.length, 1, "the placeholder is a notice, never an abort");
    assert.deepEqual(notices[0], {
      section: "Sessions",
      line: 1,
      text: "<!-- 子会话关联（resume 依据）：每段一行 · 字段 seg/owner/backend/id/phase/status/pid -->",
    });
  });

  it("tolerates a comment-shaped line misplaced into ## Sessions", () => {
    const notices = [];
    const sessions = parseSessionsBlock(
      [
        "- 2026-10-09T15:52+08:00 · change · author=elon · a comment that is not a session record",
        "- seg:seg1 · owner:linus · backend:claude · id:sess-1 · status:running · 2026-10-02T00:00:00.000Z",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(sessions.map((session) => session.seg), ["seg1"]);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].line, 1);
  });

  it("no longer aborts a card on a malformed session line — it is skipped with a notice", () => {
    const notices = [];
    const sessions = parseSessionsBlock(
      [
        "- seg:seg1 · owner:linus", // no trailing timestamp
        "- seg:seg2 · whatever:1 · 2026-10-01T00:00:00.000Z", // unknown field
        "- notakeyvalue · 2026-10-01T00:00:00.000Z", // field without `<name>:<value>`
        "plain prose with no bullet",
        "- seg:seg3 · owner:linus · backend:claude · id:sess-3 · status:running · 2026-10-03T00:00:00.000Z",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(sessions.map((session) => session.seg), ["seg3"], "only the well-formed line survives");
    assert.equal(notices.length, 4, "every tolerated line is recorded");
    assert.deepEqual(
      notices.map((notice) => notice.line),
      [1, 2, 3, 4],
    );
    assert.equal(notices.every((notice) => notice.section === "Sessions"), true);
  });

  it("skips a multi-line HTML comment without losing the sessions around it", () => {
    const notices = [];
    const sessions = parseSessionsBlock(
      [
        "<!-- a comment block",
        "that spans several lines -->",
        "- seg:seg1 · owner:linus · backend:claude · id:sess-1 · status:running · 2026-10-01T00:00:00.000Z",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(sessions.map((session) => session.seg), ["seg1"]);
    assert.equal(notices.length, 2);
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
    assert.equal(reports[0].narrative, true, "no acceptance list and no evidence → a narrative");
    assert.deepEqual(reports[0].notices, []);
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
        narrative: false,
        notices: [],
      },
    ]);
  });

  it("tolerates a report block it cannot fully parse — and records notices", () => {
    const notices = [];
    const reports = parseReportBlock(
      [
        "### R1 · t · a",
        "",
        "summary",
        "",
        "acceptance:",
        "- [met] one",
        "| col | col |",
        "",
        "evidence:",
        "- screenshot foo.png",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(reports[0].acceptance, [{ status: "met", text: "one" }]);
    assert.deepEqual(reports[0].evidence, []);
    assert.equal(reports[0].narrative, false, "an acceptance item was still read");
    assert.equal(notices.length, 2);
    assert.equal(notices[0].section, "Report");
    assert.equal(notices[0].text, "| col | col |");
    assert.equal(notices[1].text, "- screenshot foo.png");
  });

  it("still refuses evidence it cannot render (the renderer is not relaxed)", () => {
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
