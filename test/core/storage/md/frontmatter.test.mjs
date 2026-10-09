/**
 * Step 14: the frontmatter subset.
 *
 * The property that matters is idempotency: `parse → serialize → parse` must
 * land on the same data, and repeated rewrites must not grow the file. Anything
 * the parser cannot read is a hard error *with a line number* — a migrator that
 * guesses is worse than one that stops.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import {
  FENCE,
  parseFrontmatter,
  parseScalar,
  renderScalar,
  serializeFrontmatter,
} from "../../../../src/core/storage/md/frontmatter.mjs";

/** @param {string} body */
const card = (body) => `---\n${body}\n---\n## Background\n\ntext\n`;

describe("md/frontmatter — parsing", () => {
  it("reads plain scalars, arrays, quoted strings and blocks", () => {
    const { data, order, body } = parseFrontmatter(
      card(
        [
          "id: PROJ-0001",
          "title: A plain title",
          "labels: [a, b, \"c, with comma\"]",
          'quoted: "say \\"hi\\""',
          "empty: \"\"",
          "git_rules: |",
          "  line one",
          "  line two",
          "folded: >",
          "  one two",
          "  three",
        ].join("\n"),
      ),
    );
    assert.equal(data.id, "PROJ-0001");
    assert.equal(data.title, "A plain title");
    assert.deepEqual(data.labels, ["a", "b", "c, with comma"]);
    assert.equal(data.quoted, 'say "hi"');
    assert.equal(data.empty, "");
    assert.equal(data.git_rules, "line one\nline two\n", "a literal block keeps newlines");
    assert.equal(data.folded, "one two three\n", "a folded block joins with spaces");
    assert.deepEqual(order, ["id", "title", "labels", "quoted", "empty", "git_rules", "folded"]);
    assert.match(body, /^## Background/);
  });

  it("keeps single quotes literal and colons intact", () => {
    const { data } = parseFrontmatter(card(["a: 'it''s fine'", "b: 12:30:00", "c: key: value"].join("\n")));
    assert.equal(data.a, "it''s fine");
    // A double-quoted value goes through JSON, so "true" stays the *string*.
    assert.equal(parseFrontmatter(card('x: "true"')).data.x, "true");
    assert.equal(data.b, "12:30:00");
    assert.equal(data.c, "key: value");
  });

  it("refuses what it cannot read, naming the line", () => {
    const cases = [
      ["no fence", "id: x\n---\n", /start with '---'/, 1],
      ["unterminated", `---\nid: x\n`, /unterminated/, 3],
      ["bad key", `---\n: x\n---\n`, /expected 'key: value'/, 2],
      ["indented", `---\nid: x\n  nested: y\n---\n`, /indentation/, 3],
      ["orphan block", `---\nid: x\ngit_rules:\n  indented\n---\n`, /block marker/, 3],
      ["unclosed array", `---\nlabels: [a, b\n---\n`, /closed on the same line/, 2],
      ["bad json", `---\nx: "unterminated\n---\n`, /valid JSON|unterminated/, 2],
      ["anchor", `---\nx: &anchor\n---\n`, /not supported/, 2],
      ["nested array", `---\nx: [[a]]\n---\n`, /nested arrays/, 2],
      ["empty block", `---\nx: |\n---\n`, /empty block scalar/, 2],
      ["tab indent", `---\nx: |\n\tbad\n---\n`, /tab indentation/, 3],
      ["brace value", `---\nx: {a: 1}\n---\n`, /not supported/, 2],
    ];
    for (const [label, text, pattern, line] of cases) {
      assert.throws(
        () => parseFrontmatter(text, { file: "card.md" }),
        (err) => {
          assert.equal(err.code, "MD_PARSE_ERROR", label);
          assert.match(err.message, pattern, label);
          assert.equal(err.details.line, line, label);
          return true;
        },
      );
    }
  });

  it("tolerates a missing value and blank lines", () => {
    const { data } = parseFrontmatter(`---\n\na: 1\nb:\n\n---\nbody\n`);
    assert.equal(data.a, "1");
    assert.equal(data.b, "");
  });

  it("parseScalar can be used on its own", () => {
    const fail = (message) => {
      throw new Error(message);
    };
    assert.deepEqual(parseScalar("[a,b]", fail), ["a", "b"]);
    assert.deepEqual(parseScalar("[]", fail), []);
    assert.equal(parseScalar("plain", fail), "plain");
    assert.throws(() => parseScalar("{a: 1}", fail), /not supported/);
  });

  it("keeps a value that merely *starts* with '*' or '&', refusing only a bare token", () => {
    const fail = (message) => {
      throw new Error(message);
    };
    // Prose: markdown bold, an emphasis marker, an ampersand — all verbatim.
    assert.equal(parseScalar("**只读**审计 与 迁移", fail), "**只读**审计 与 迁移");
    assert.equal(parseScalar("*emphasis* and text", fail), "*emphasis* and text");
    assert.equal(parseScalar("& more prose", fail), "& more prose");
    // A bare alias/anchor token is still YAML syntax this subset refuses.
    assert.throws(() => parseScalar("*alias", fail), /not supported/);
    assert.throws(() => parseScalar("&anchor", fail), /not supported/);
    assert.throws(() => parseScalar("{a: 1}", fail), /not supported/);

    // And end to end: a real `git_rules` value that begins with `**` parses.
    const { data } = parseFrontmatter(card("git_rules: **只读**审计 ~/.openclaw/team/**；禁破坏性 git"));
    assert.equal(data.git_rules, "**只读**审计 ~/.openclaw/team/**；禁破坏性 git");
  });
});

describe("md/frontmatter — serialisation", () => {
  it("is idempotent across the whole value matrix", () => {
    const data = {
      id: "PROJ-0001",
      title: "A title with: a colon",
      plain: "no quotes needed",
      empty: "",
      numeric: "42",
      trailing: " space ",
      array: ["a", "b, with comma", '"quoted"'],
      multiline: "line one\nline two\n",
      chinese: "「棋盘」 and an em dash — okay",
      special: 'has "quotes" and |pipe',
      url: "https://example.com/x?y=1",
      timestamp: "2026-10-08T00:00:00.000Z",
    };
    const once = serializeFrontmatter(data, { order: ["id", "title"] });
    const twice = serializeFrontmatter(parseFrontmatter(`${once}\nbody\n`).data, { order: ["id", "title"] });
    assert.equal(twice, once, "a second pass must be byte-identical");
    assert.deepEqual(parseFrontmatter(`${once}\nbody\n`).data, data, "and must read back the same values");

    // Twelve rewrites, same size: the growth loop is what this guards.
    let text = once;
    for (let i = 0; i < 12; i += 1) text = serializeFrontmatter(parseFrontmatter(`${text}\nbody\n`).data, { order: ["id", "title"] });
    assert.equal(text.length, once.length);
  });

  it("quotes only what needs quoting", () => {
    assert.equal(renderScalar("plain"), "plain");
    assert.equal(renderScalar("2026-10-08T00:00:00.000Z"), "2026-10-08T00:00:00.000Z");
    assert.equal(renderScalar("with: colon space"), JSON.stringify("with: colon space"));
    assert.equal(renderScalar(""), '""');
    assert.equal(renderScalar(null), '""');
    assert.equal(renderScalar(["a", "b"]), "[a, b]");
    assert.equal(renderScalar(["a,b"]), '["a,b"]');
    assert.equal(renderScalar("multi\nline"), "|", "blocks are signalled, not inlined");
    assert.equal(renderScalar(42), '"42"', "numbers are strings here — quote to be safe");
  });

  it("writes multi-line values as block scalars and keeps the key order", () => {
    const text = serializeFrontmatter({ b: 1, a: "x\ny", c: 3 }, { order: ["a", "c"] });
    // Numbers are quoted: every value in this subset is a string, and quoting
    // keeps `88` from being re-read as a number by some other tool.
    assert.equal(text, `${FENCE}\na: |\n  x\n  y\nc: "3"\nb: "1"\n${FENCE}\n`);
    const back = parseFrontmatter(`${text}b`).data;
    assert.deepEqual(Object.keys(back), ["a", "c", "b"]);
    assert.equal(back.c, "3");
    // A `|` block is a *block of lines*: it ends with a newline, the way YAML's
    // clip style does. Serialisation strips it again, so files stay stable.
    assert.equal(back.a, "x\ny\n");
    assert.equal(serializeFrontmatter(back, { order: ["a", "c"] }), text);
  });

  it("handles a block whose continuation lines are empty", () => {
    const text = serializeFrontmatter({ rules: "first\n\nsecond\n" });
    const back = parseFrontmatter(`${text}body\n`).data;
    assert.equal(back.rules, "first\n\nsecond\n");
  });
});
