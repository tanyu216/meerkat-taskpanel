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
  parseReportBlock,
  parseSessionsBlock,
  renderAcceptanceBlock,
  renderAcceptanceList,
  renderAttachmentsBlock,
  renderCommentsBlock,
  renderReportBlock,
  renderSessionsBlock,
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
    const { sections } = splitSections("## Comments\n\n\n## Sessions\n- x\n\n");
    assert.equal(sections.get("Comments"), "");
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
      "Comments",
      "Sessions",
      "Attachments",
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

  it("renders modern string items as plain bullets, with no invented checkbox state", () => {
    assert.equal(
      renderAcceptanceList(["cli works", "gate visible", 7]),
      "- cli works\n- gate visible\n- 7",
    );
    assert.equal(renderAcceptanceList(["one line\nsecond line"]), "- one line\\nsecond line");
    assert.equal(renderAcceptanceList([]), "");
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
        "- seg:seg1 · owner:linus · owner_kind:claude · id:32306ef3-a9ad-5453-b300-5f12642ac16f · phase:plan · status:closed · pid: · 2026-10-01T00:00:00.000Z",
        "- seg:seg2 · owner:linus · owner_kind:claude · id:ff309028 · status:running · 2026-10-02T00:00:00.000Z",
      ].join("\n"),
    );
    assert.equal(sessions[0].seg, "seg1");
    assert.equal(sessions[0].pid, "");
    assert.equal(sessions[0].ts, "2026-10-01T00:00:00.000Z");
    assert.equal(sessions[1].phase, "", "a missing field becomes an empty string");
    assert.equal(sessions[1].status, "running");
    assert.equal(renderSessionsBlock([sessions[0]]).startsWith("- seg:seg1 · owner:linus"), true);
    assert.equal(renderSessionsBlock([sessions[0]]), `- seg:seg1 · owner:linus · owner_kind:claude · id:32306ef3-a9ad-5453-b300-5f12642ac16f · goal: · phase:plan · status:closed · pid: · 2026-10-01T00:00:00.000Z`);
  });

  it("round-trips a goal that carries the field separator, a newline and a backslash", () => {
    const goal = "fix a · b\nsecond line\r\\done: yes";
    const rendered = renderSessionsBlock([
      {
        seg: "seg1",
        owner: "linus",
        ownerKind: "claude",
        sessionId: "sess-1",
        goal,
        status: "running",
        pid: null,
        ts: "2026-10-01T00:00:00.000Z",
      },
    ]);
    assert.equal(rendered.includes("\n"), false, "the record stays one line");
    const [parsed] = parseSessionsBlock(rendered);
    assert.equal(parsed.goal, goal);
    assert.equal(parsed.seg, "seg1");
    assert.equal(parsed.status, "running");
  });

  it("reads a pre-0028 session line without a goal as the empty sentence", () => {
    const [parsed] = parseSessionsBlock(
      "- seg:seg1 · owner:linus · owner_kind:claude · id:sess-1 · status:running · 2026-10-01T00:00:00.000Z",
    );
    assert.equal(parsed.goal, "");
    assert.equal(parsed.status, "running");
  });

  it("tolerates the template placeholder comment and keeps the real sessions", () => {
    const notices = [];
    const sessions = parseSessionsBlock(
      [
        "<!-- 子会话关联（resume 依据）：每段一行 · 字段 seg/owner/owner_kind/id/phase/status/pid -->",
        "- seg:seg1 · owner:linus · owner_kind:claude · id:sess-1 · phase:plan · status:closed · pid: · 2026-10-01T00:00:00.000Z",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(sessions.map((session) => session.seg), ["seg1"], "only the real session is kept");
    assert.equal(notices.length, 1, "the placeholder is a notice, never an abort");
    assert.deepEqual(notices[0], {
      section: "Sessions",
      line: 1,
      text: "<!-- 子会话关联（resume 依据）：每段一行 · 字段 seg/owner/owner_kind/id/phase/status/pid -->",
    });
  });

  it("tolerates a comment-shaped line misplaced into ## Sessions", () => {
    const notices = [];
    const sessions = parseSessionsBlock(
      [
        "- 2026-10-09T15:52+08:00 · change · author=elon · a comment that is not a session record",
        "- seg:seg1 · owner:linus · owner_kind:claude · id:sess-1 · status:running · 2026-10-02T00:00:00.000Z",
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
        "- seg:seg3 · owner:linus · owner_kind:claude · id:sess-3 · status:running · 2026-10-03T00:00:00.000Z",
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
        "- seg:seg1 · owner:linus · owner_kind:claude · id:sess-1 · status:running · 2026-10-01T00:00:00.000Z",
      ].join("\n"),
      { notices },
    );
    assert.deepEqual(sessions.map((session) => session.seg), ["seg1"]);
    assert.equal(notices.length, 2);
  });
});

describe("md/sections — attachments", () => {
  it("renders one escaped field list per row, including comment_id when present", () => {
    assert.equal(
      renderAttachmentsBlock([
        {
          id: "att-1",
          filename: "notes.txt",
          contentType: "text/plain",
          size: 12,
          kind: "attachment",
          commentId: null,
          createdAt: "2026-10-08T00:00:00.000Z",
        },
        {
          id: "att-2",
          filename: "a · b\nc.txt",
          contentType: "application/pdf",
          size: 99,
          kind: "attachment",
          commentId: "c-1",
          createdAt: "2026-10-09T00:00:00.000Z",
        },
      ]),
      [
        "- id:att-1 · filename:notes.txt · type:text/plain · size:12 · created_at:2026-10-08T00:00:00.000Z",
        "- id:att-2 · filename:a \\u00b7 b\\nc.txt · type:application/pdf · size:99 · created_at:2026-10-09T00:00:00.000Z · comment_id:c-1",
      ].join("\n"),
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

  it("round-trips a rollup: marker and child refs", () => {
    const reports = [
      {
        round: 2,
        ts: "2026-10-08T02:00:00.000Z",
        authorId: "taskd",
        isRollup: true,
        conclusion: "Rollup.",
        acceptance: [
          { text: "PROJ-0001 One (done)", status: "met", ref: "PROJ-0001" },
          { text: "PROJ-0002 Two (canceled)", status: "not_applicable", note: "scope dropped", ref: "PROJ-0002" },
        ],
        evidence: { items: [{ kind: "path", path: "x" }], truncated: false },
        leftovers: null,
      },
    ];
    const rendered = renderReportBlock(reports);
    assert.match(rendered, /^### R2 · .*\n\nrollup: yes\n\nRollup\./);
    assert.doesNotMatch(rendered, /^origin: /m, "0035 removed the provenance marker");
    assert.match(rendered, /- \[met\] PROJ-0001 One \(done\) · ref: PROJ-0001/);
    assert.match(rendered, /- \[not_applicable\] PROJ-0002 Two \(canceled\) · ref: PROJ-0002 — scope dropped/);

    const [back] = parseReportBlock(rendered);
    assert.equal(back.isRollup, true);
    assert.equal(back.origin, undefined);
    assert.deepEqual(back.acceptance, reports[0].acceptance);
  });

  it("swallows a legacy `origin: import` line instead of reading it as prose", () => {
    // Cards exported before 0035 still carry the line. It is not reproduced, and
    // it must not leak into the conclusion on the way in.
    const [back] = parseReportBlock("### R1 · 2026-10-08T00:00:00.000Z · taskd\n\norigin: import\n\nHistory.\n");
    assert.equal(back.conclusion, "History.");
    assert.equal(back.origin, undefined);
  });

  it("keeps the marker absent when the block carries none", () => {
    const [plain] = parseReportBlock(
      ["### R1 · t · a", "", "Done.", "", "acceptance:", "- [met] a · ref: not-a-marker"].join("\n"),
    );
    assert.equal("isRollup" in plain, false);
    assert.equal("origin" in plain, false);
    assert.equal(plain.acceptance[0].ref, "not-a-marker", "a ref is still read mid-line");
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
