/**
 * The identifier contract, as the installed skill states it.
 *
 * `references/card-schema.md` is the page an agent kind actually receives. Its
 * identifier section has to agree with the code in three places, or a team
 * parsing board references silently drifts from the board:
 *
 *   1. the **storable** pattern (`IDENTIFIER_PATTERN` / `isValidIdentifier`) —
 *      deliberately permissive, because legacy imported cards must keep working;
 *   2. the **generated** shape (`identifierFor` / `formatIdentifier`) — prefix,
 *      zero-padding, and the wider-than-four-digit serials;
 *   3. the **prefix fold** (`identifierPrefix`) — trim, uppercase, collapse.
 *
 * The marked blocks in the page are the fixture. They are parsed, not trusted:
 * every example is re-derived here.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { IDENTIFIER_PATTERN } from "../../src/foundation/constants.mjs";
import {
  formatIdentifier,
  identifierPrefix,
  isValidIdentifier as foundationValid,
} from "../../src/foundation/ids.mjs";
import { identifierFor, isValidIdentifier as domainValid } from "../../src/core/domain/task.mjs";
import { CARD_KEY_ORDER } from "../../src/core/storage/md/export.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC_PATH = join(ROOT, "skills/meerkat-taskpanel/references/card-schema.md");
const DOC = readFileSync(DOC_PATH, "utf8");

/** The lines between `<!-- identifier-<name>:begin -->` and its `:end` marker. */
function marked(name) {
  const begin = `<!-- identifier-${name}:begin -->`;
  const end = `<!-- identifier-${name}:end -->`;
  const start = DOC.indexOf(begin);
  assert.notEqual(start, -1, `card-schema.md is missing ${begin}`);
  const bodyStart = start + begin.length;
  const stop = DOC.indexOf(end, bodyStart);
  assert.notEqual(stop, -1, `card-schema.md is missing ${end}`);
  return DOC.slice(bodyStart, stop)
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("card-schema.md — identifier syntax", () => {
  it("states the storable pattern verbatim", () => {
    assert.ok(
      DOC.includes(IDENTIFIER_PATTERN.source),
      `the page must carry the executable pattern ${IDENTIFIER_PATTERN.source}`,
    );
    assert.ok(DOC.includes("128"), "the page must state the 128-character ceiling");
  });

  it("classifies every example the same way both validators do", () => {
    const rows = marked("examples");
    assert.ok(rows.length > 0, "the examples block must not be empty");

    for (const row of rows) {
      const match = /^(valid|invalid) (.+)$/.exec(row);
      assert.ok(match, `unparseable example row: ${JSON.stringify(row)}`);
      const expected = match[1] === "valid";
      const value = match[2];

      assert.equal(foundationValid(value), expected, `src/foundation/ids.mjs#isValidIdentifier(${JSON.stringify(value)})`);
      assert.equal(domainValid(value), expected, `src/core/domain/task.mjs#isValidIdentifier(${JSON.stringify(value)})`);
      assert.equal(
        domainValid(value),
        foundationValid(value),
        `the two validators disagree about ${JSON.stringify(value)}`,
      );
    }
  });

  it("mints every generated example with identifierFor and formatIdentifier", () => {
    const rows = marked("generated");
    assert.ok(rows.length > 0, "the generated block must not be empty");

    for (const row of rows) {
      const parts = row.split("=>").map((part) => part.trim());
      assert.equal(parts.length, 3, `unparseable generated row: ${JSON.stringify(row)}`);
      const [projectId, serialText, expected] = parts;
      const serial = Number(serialText);
      assert.ok(Number.isInteger(serial), `serial must be an integer in ${JSON.stringify(row)}`);

      assert.equal(identifierFor(projectId, serial), expected);
      assert.equal(formatIdentifier(projectId, serial), expected);
    }
  });

  it("folds every prefix example with identifierPrefix", () => {
    const rows = marked("prefix");
    assert.ok(rows.length > 0, "the prefix block must not be empty");

    for (const row of rows) {
      const parts = row.split("=>").map((part) => part.trim());
      assert.equal(parts.length, 2, `unparseable prefix row: ${JSON.stringify(row)}`);
      assert.equal(identifierPrefix(parts[0]), parts[1]);
    }
  });

  it("gives parsers a generated-form regex that classifies the examples", () => {
    const rows = marked("generated-regex");
    assert.equal(rows.length, 1, "the generated-regex block must hold exactly one pattern");
    const pattern = new RegExp(rows[0]);

    for (const row of marked("generated")) {
      const expected = row.split("=>").map((part) => part.trim())[2];
      assert.ok(pattern.test(expected), `${expected} should match the published generated-form regex`);
    }
    assert.equal(
      pattern.test("T-20261008-230500-meerkat-taskpanel-m1"),
      false,
      "a legacy imported identifier is storable but is not a generated form",
    );
  });

  it("keeps the field-reference table intact while adding the identifier section", () => {
    // The same window the page's own conformance snippet reads.
    const table = DOC.split("## Field reference")[1].split("\n## ")[0];
    const keys = [...table.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((match) => match[1]);

    // `target` has a reserved slot in CARD_KEY_ORDER so a legacy key keeps its
    // historical position, but it is not one of the documented card keys (the
    // page says so under "Unknown keys are preserved"). 0037/0038 added
    // `acceptance_mode`, taking the count from 41 to 42.
    const documented = CARD_KEY_ORDER.filter((key) => key !== "target");
    assert.equal(documented.length, 42, "CARD_KEY_ORDER minus target must be the 42 documented keys");
    assert.equal(keys.length, documented.length, "the table must still document 42 keys");
    assert.deepEqual([...keys].sort(), [...documented].sort());
    assert.deepEqual([keys[0], keys.at(-1)], ["id", "notify_leader"]);

    // The new section must sit outside the window the page's conformance
    // snippet reads — an inserted `##` before the table would cut it short.
    const windowEnd = DOC.indexOf("\n## ", DOC.indexOf("## Field reference"));
    assert.ok(
      DOC.indexOf("## Identifier syntax") > windowEnd,
      "## Identifier syntax must follow the field-reference window",
    );
  });
});
