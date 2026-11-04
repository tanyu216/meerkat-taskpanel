/**
 * B09 · the drawer's relation projections (TP-0075).
 *
 * The drawer used to render its relations as three read-only kind groups and a
 * multi-chip `depends_on` control. This round makes the area four explicit
 * groups — Parent / Children / Depends on / Related — with one card row per
 * relation (`identifier` + `title`), and moves the epic's *whole* descendant
 * tree onto the server (`relations.descendants`). The projections below are
 * pure (no Vue, no DOM), so grouping, the missing-title fallback and the empty
 * predicate are asserted without a browser; the rendered hooks are the browser
 * leg's job (`web/scripts/dom-smoke.mjs`, run by
 * `test/web/blocks.dom.test.mjs`).
 *
 * The descendant walk itself is the server's — `listDescendants` mirrors
 * `listAncestors`' recursive CTE — so the frontend must consume the order the
 * server answered and never re-walk the graph it cannot see.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  descendantRows,
  detailKind,
  parentRowOf,
  relatedRowsOf,
  relationsEmptyOf,
} from "../../web/src/lib/detail-relations.js";
import { EXTRA } from "../../web/src/i18n/extra.mjs";

const roster = new Map([
  ["td_TD_1", { identifier: "TD-1", title: "Draft the onboarding copy" }],
  ["td_TD_5", { identifier: "TD-5", title: "Fix the renderer" }],
  ["td_PROJ_0007", { identifier: "PROJ-0007", title: "Collect the install survey" }],
]);
const lookup = (id) => roster.get(id);

describe("web/detail-relations — the card's kind badge", () => {
  it("reads the stored kind, and an unknown or absent kind as Task", () => {
    assert.equal(detailKind("epic"), "epic");
    assert.equal(detailKind("task"), "task");
    assert.equal(detailKind("review"), "review");
    assert.equal(detailKind(undefined), "task");
    assert.equal(detailKind(null), "task");
  });
});

describe("web/detail-relations — the epic's descendants", () => {
  it("keeps the server's breadth-first order and projects id + title", () => {
    const rows = descendantRows([
      { id: "td_15", identifier: "TD-15", title: "Child one", status: "todo", kind: "task" },
      { id: "td_16", identifier: "TD-16", title: "Child two", status: "done", kind: "task" },
      { id: "td_17", identifier: "TD-17", title: "Grandchild", status: "todo", kind: "task" },
    ]);
    assert.deepEqual(
      rows.map((row) => [row.id, row.identifier, row.title]),
      [
        ["td_15", "TD-15", "Child one"],
        ["td_16", "TD-16", "Child two"],
        ["td_17", "TD-17", "Grandchild"],
      ],
    );
  });

  it("falls back to the id and an empty title for a partial row, and tolerates no rows", () => {
    const [row] = descendantRows([{ id: "td_18" }]);
    assert.deepEqual(row, { id: "td_18", identifier: "td_18", title: "" });
    assert.deepEqual(descendantRows(undefined), []);
    assert.deepEqual(descendantRows(null), []);
  });
});

describe("web/detail-relations — Parent and Related", () => {
  const relations = [
    { id: "rel-parent", type: "parent", source: "td_PROJ_0007", target: "td_TD_1" },
    // The reverse parent edge (this card is the parent) is the Children
    // direction, never the Parent row.
    { id: "rel-child", type: "parent", source: "td_TD_1", target: "td_TD_2" },
    { id: "rel-related", type: "related", source: "td_TD_1", target: "td_TD_5" },
    { id: "rel-blocks", type: "blocks", source: "td_TD_5", target: "td_TD_1" },
  ];

  it("finds the one parent edge pointing at the card, resolved from the roster", () => {
    assert.deepEqual(parentRowOf(relations, "td_TD_1", lookup), {
      id: "td_PROJ_0007",
      identifier: "PROJ-0007",
      title: "Collect the install survey",
    });
    assert.equal(parentRowOf(relations, "td_NO_PARENT", lookup), null, "a card with no parent has no row");
  });

  it("keeps the identifier when the roster does not know the card, with an empty title", () => {
    assert.deepEqual(parentRowOf([{ id: "r", type: "parent", source: "td_off_roster", target: "td_TD_1" }], "td_TD_1", lookup), {
      id: "td_off_roster",
      identifier: "td_off_roster",
      title: "",
    });
  });

  it("lists Related edges only, from either end", () => {
    assert.deepEqual(
      relatedRowsOf(relations, "td_TD_1", lookup).map((row) => [row.key, row.identifier, row.title]),
      [["rel-related", "TD-5", "Fix the renderer"]],
    );
    assert.deepEqual(relatedRowsOf(relations, "td_TD_5", lookup).map((row) => row.identifier), ["TD-1"]);
  });
});

describe("web/detail-relations — the area's empty predicate", () => {
  const empty = { parent: null, children: [], depends: [], related: [] };

  it("is empty only when all four groups are", () => {
    assert.equal(relationsEmptyOf(empty), true);
    assert.equal(relationsEmptyOf({ ...empty, parent: { id: "x" } }), false);
    assert.equal(relationsEmptyOf({ ...empty, children: [{ id: "x" }] }), false);
    assert.equal(relationsEmptyOf({ ...empty, depends: [{ relationId: 1 }] }), false);
    assert.equal(relationsEmptyOf({ ...empty, related: [{ id: "x" }] }), false);
    assert.equal(relationsEmptyOf(), true, "a missing argument reads as no relations");
  });
});

describe("web/detail-relations — the new copy", () => {
  it("names the kind badge, the children group and the depends group in both languages", () => {
    for (const key of ["kind.task", "kind.epic", "kind.review", "drawer.children", "drawer.childrenEmpty", "relations.depends"]) {
      assert.ok(EXTRA.en[key], `en is missing ${key}`);
      assert.ok(EXTRA.zh[key], `zh is missing ${key}`);
    }
  });

  it("keeps epic in English in the Chinese mirror, as GLOSSARY.md rules", () => {
    assert.equal(EXTRA.en["kind.epic"], "Epic");
    assert.equal(EXTRA.zh["kind.epic"], "epic");
  });

  it("names the review kind in both languages, following GLOSSARY.md's 审核卡", () => {
    assert.equal(EXTRA.en["kind.review"], "Review");
    assert.equal(EXTRA.zh["kind.review"], "审核");
  });
});
