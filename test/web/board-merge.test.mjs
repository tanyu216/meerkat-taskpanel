/**
 * `lib/board-merge.js` — the board's supplementary active read merges into the
 * main page without reordering it.
 *
 * The board reads `board=1&limit=500`, whose first page is the non-terminal
 * cards in the weight order. When the project holds more active cards than that
 * page, a second read (`status=<non-terminal>`) fetches them; every card the
 * first read already carries must stay where it was, and only the new ones are
 * appended. Deduplication is by `id` because that is the wire's identity — an
 * identifier is only unique within a project.
 *
 * Pure and browser-free, so it runs in the container as an ordinary unit test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeById } from "../../web/src/lib/board-merge.js";

const card = (id) => ({ id, identifier: id.toUpperCase() });

describe("web/board-merge — mergeById", () => {
  it("preserves the primary page's order and appends only the new cards", () => {
    const page = [card("a"), card("b")];
    const supplement = [card("c"), card("a"), card("d"), card("b")];
    assert.deepEqual(
      mergeById(page, supplement).map((item) => item.id),
      ["a", "b", "c", "d"],
      "existing rows keep their seats; new rows follow in supplement order",
    );
  });

  it("deduplicates within the page as well, keeping the first occurrence", () => {
    const page = [card("a"), card("a"), card("b")];
    assert.deepEqual(
      mergeById(page, [card("b"), card("b")]).map((item) => item.id),
      ["a", "b"],
    );
  });

  it("returns the page unchanged when the supplement is absent or empty", () => {
    const page = [card("a")];
    assert.deepEqual(mergeById(page, []), page);
    assert.deepEqual(mergeById(page, undefined), page);
    assert.deepEqual(mergeById(undefined, [card("b")]).map((item) => item.id), ["b"]);
  });

  it("does not mutate either input", () => {
    const page = [card("a")];
    const supplement = [card("b")];
    const merged = mergeById(page, supplement);
    merged.push(card("c"));
    assert.deepEqual(page.map((item) => item.id), ["a"]);
    assert.deepEqual(supplement.map((item) => item.id), ["b"]);
  });

  it("skips a null row rather than inventing an identity for it", () => {
    assert.deepEqual(mergeById([card("a")], [null, card("b"), undefined]).map((item) => item.id), ["a", "b"]);
  });
});
