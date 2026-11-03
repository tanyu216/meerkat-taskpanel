/**
 * The assignee / label filter menus' pure half (`web/src/lib/filter-menu.js`).
 *
 * The two dropdowns are still B04's `<details>` controls: four pinned assignee
 * rows (`all | me | human | agent`), `all` pinned first for the label menu, and
 * the panel's rows follow from the control's own value plus an optional search
 * query. The ranking is `combo.js`'s (`prefix → contains → subsequence`, seed
 * order inside a bucket) — the same matcher the drawer's comboboxes use — so the
 * suites pin the two new row builders without a browser.
 *
 * The contract here is the acceptance list, read literally:
 *
 *   1. the four static rows are **always pinned first** and never filtered;
 *   2. an empty query shows the resting set — the static rows plus the one
 *      named row the roster press wrote — and **no** actor rows;
 *   3. a non-empty query ranks actors by name, case-insensitively;
 *   4. an actor whose name is one of the static values is not a second row;
 *   5. the named value is one row, never duplicated, even when the roster does
 *      not hold it;
 *   6. the label menu offers existing labels only — no `· new` row exists in
 *      this builder at all.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assigneeMenuRows,
  firstUnpinnedIndex,
  labelMenuRows,
  moveActive,
} from "../../web/src/lib/filter-menu.js";

const STATIC = Object.freeze(["all", "me", "human", "agent"]);

/** The catalogue's own shape, so the text assertions read like the screen. */
function t(key, ...args) {
  if (key === "filters.assigneeOption") return `Assignee: ${args[0]}`;
  if (key === "filters.labelOption") return `Label: ${args[0]}`;
  if (key === "filters.assignee.all") return "Assignee: All";
  if (key === "filters.assignee.me") return "Assignee: Me";
  if (key === "filters.assignee.human") return "Assignee: Human";
  if (key === "filters.assignee.agent") return "Assignee: Agent";
  if (key === "filters.label.all") return "Label: All";
  return key;
}

const ACTORS = Object.freeze([
  { display_name: "linus" },
  { display_name: "jobs" },
  { display_name: "assistant" },
  { display_name: "elon" },
]);

function assigneeRows(overrides = {}) {
  return assigneeMenuRows({
    staticValues: STATIC,
    actors: ACTORS,
    named: null,
    query: "",
    t,
    ...overrides,
  });
}

function values(rows) {
  return rows.map((row) => row.value);
}

describe("assigneeMenuRows — the resting set", () => {
  it("keeps the four static rows first, in their own order", () => {
    const rows = assigneeRows();
    assert.deepEqual(values(rows), ["all", "me", "human", "agent"]);
    assert.deepEqual(
      rows.map((row) => row.pinned),
      [true, true, true, true],
    );
    assert.deepEqual(
      rows.map((row) => row.text),
      ["Assignee: All", "Assignee: Me", "Assignee: Human", "Assignee: Agent"],
    );
  });

  it("shows no actor row while the query is empty", () => {
    assert.equal(assigneeRows().length, STATIC.length);
    assert.equal(
      assigneeRows().some((row) => row.value === "linus"),
      false,
    );
  });

  it("shows the named value as one more row, with the control's sentence", () => {
    const rows = assigneeRows({ named: "linus" });
    assert.deepEqual(values(rows), ["all", "me", "human", "agent", "linus"]);
    assert.equal(rows.at(-1).pinned, false);
    assert.equal(rows.at(-1).text, "Assignee: linus");
  });

  it("does not duplicate a named value the roster already holds", () => {
    const rows = assigneeRows({ named: "linus" });
    assert.equal(values(rows).filter((value) => value === "linus").length, 1);
  });

  it("still shows a named value the roster does not hold", () => {
    const rows = assigneeRows({ named: "ghost" });
    assert.deepEqual(values(rows).slice(-1), ["ghost"]);
    assert.equal(rows.at(-1).text, "Assignee: ghost");
  });
});

describe("assigneeMenuRows — the query", () => {
  it("ranks a prefix before a contains, and drops everything else", () => {
    const rows = assigneeRows({ query: "li" });
    assert.deepEqual(values(rows), ["all", "me", "human", "agent", "linus"]);
  });

  it("keeps seed order inside a bucket", () => {
    const rows = assigneeRows({ query: "o" });
    // contains: jobs, elon (seed order), then the rest of the roster by subsequence.
    assert.deepEqual(values(rows).slice(STATIC.length), ["jobs", "elon"]);
  });

  it("matches a subsequence, case-insensitively", () => {
    assert.deepEqual(values(assigneeRows({ query: "LNS" })).slice(STATIC.length), ["linus"]);
    assert.deepEqual(values(assigneeRows({ query: "ASS" })).slice(STATIC.length), ["assistant"]);
  });

  it("never filters the four pinned rows", () => {
    const rows = assigneeRows({ query: "zzz" });
    assert.deepEqual(values(rows), ["all", "me", "human", "agent"]);
  });

  it("keeps a matching named row once, even when the roster holds it", () => {
    const rows = assigneeRows({ named: "linus", query: "lin" });
    assert.equal(values(rows).filter((value) => value === "linus").length, 1);
    assert.equal(rows.filter((row) => row.value === "linus").length, 1);
  });

  it("drops a named row the query does not match", () => {
    const rows = assigneeRows({ named: "ghost", query: "lin" });
    assert.deepEqual(values(rows), ["all", "me", "human", "agent", "linus"]);
  });
});

describe("assigneeMenuRows — exclusions and text", () => {
  it("does not offer an actor whose name is a static value", () => {
    const rows = assigneeMenuRows({
      staticValues: STATIC,
      actors: [{ display_name: "all" }, { display_name: "Human" }, { display_name: "linus" }],
      named: null,
      query: "l",
      t,
    });
    assert.equal(values(rows).filter((value) => ["all", "me", "human", "agent"].includes(value)).length, 4);
    assert.equal(values(rows).filter((value) => value === "linus").length, 1);
  });

  it("gives every matched actor the control's sentence", () => {
    const rows = assigneeRows({ query: "lin" });
    assert.equal(rows.at(-1).text, "Assignee: linus");
  });
});

describe("labelMenuRows", () => {
  const LABELS = Object.freeze(["bug", "ui", "design", "perf", "security"]);

  const labels = (query) => labelMenuRows({ labels: LABELS, query, t });

  it("pins All first and offers every label while the query is empty", () => {
    const rows = labels("");
    assert.deepEqual(values(rows), ["all", "bug", "ui", "design", "perf", "security"]);
    assert.equal(rows[0].pinned, true);
    assert.equal(rows[0].text, "Label: All");
    assert.deepEqual(
      rows.slice(1).map((row) => row.text),
      ["Label: bug", "Label: ui", "Label: design", "Label: perf", "Label: security"],
    );
  });

  it("keeps All pinned and ranks the matching labels", () => {
    const rows = labels("u");
    assert.deepEqual(values(rows), ["all", "ui", "bug", "security"]);
  });

  it("matches a subsequence", () => {
    assert.deepEqual(values(labels("dsg")), ["all", "design"]);
  });

  it("offers existing labels only — there is no new-row value", () => {
    const rows = labels("zzz");
    assert.deepEqual(values(rows), ["all"]);
    assert.equal(rows.some((row) => row.value === "__new" || row.new === true), false);
  });
});

describe("keyboard helpers", () => {
  const rows = [
    { value: "all", pinned: true },
    { value: "me", pinned: true },
    { value: "linus", pinned: false },
    { value: "jobs", pinned: false },
  ];

  it("lands on the first non-pinned row", () => {
    assert.equal(firstUnpinnedIndex(rows), 2);
    assert.equal(firstUnpinnedIndex([{ value: "all", pinned: true }]), -1);
    assert.equal(firstUnpinnedIndex([]), -1);
  });

  it("moves with wraparound and starts at the first row from nowhere", () => {
    assert.equal(moveActive(-1, 1, 4), 0);
    assert.equal(moveActive(-1, -1, 4), 3);
    assert.equal(moveActive(3, 1, 4), 0);
    assert.equal(moveActive(0, -1, 4), 3);
    assert.equal(moveActive(0, 1, 0), -1);
  });
});
