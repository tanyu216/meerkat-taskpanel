/**
 * The drawer's two chronological lists — comments and the activity trail — read
 * newest-first. The API *can* answer in that order, but the UI must not depend
 * on it: a board that predates the `order` parameter, or a fixture that ignores
 * it, would otherwise render the oldest line at the top. `newestFirst` is the
 * one ordering rule both lists share, so it is asserted here rather than left
 * implicit in the component's `v-for`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newestFirst } from "../../web/src/lib/time.js";

const row = (id, created_at) => ({ id, created_at });

describe("web/time — newest first", () => {
  it("puts the most recent stamp first", () => {
    const rows = [
      row("oldest", "2026-10-08T09:00:00Z"),
      row("newest", "2026-10-08T11:00:00Z"),
      row("middle", "2026-10-08T10:00:00Z"),
    ];
    assert.deepEqual(newestFirst(rows).map((entry) => entry.id), ["newest", "middle", "oldest"]);
  });

  it("does not reorder the caller's own array", () => {
    const rows = [row("a", "2026-10-08T09:00:00Z"), row("b", "2026-10-08T11:00:00Z")];
    newestFirst(rows);
    assert.deepEqual(rows.map((entry) => entry.id), ["a", "b"]);
  });

  it("keeps an unreadable stamp last, and a missing one after the dated rows", () => {
    const rows = [
      row("unreadable", "not a date"),
      row("dated", "2026-10-08T11:00:00Z"),
      { id: "missing" },
    ];
    assert.deepEqual(newestFirst(rows).map((entry) => entry.id), ["dated", "unreadable", "missing"]);
  });

  it("sorts on the key it is given, so a session trail can use `ts`", () => {
    const rows = [
      { id: "a", ts: "2026-10-08T09:00:00Z" },
      { id: "b", ts: "2026-10-08T11:00:00Z" },
    ];
    assert.deepEqual(newestFirst(rows, "ts").map((entry) => entry.id), ["b", "a"]);
  });
});
