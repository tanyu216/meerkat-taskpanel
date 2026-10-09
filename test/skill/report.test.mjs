/**
 * Unit tests for the skill's periodic-report helpers
 * (`skills/task-panel/scripts/report.mjs`).
 *
 * These tests exercise the **pure functions only** — the report aggregator's
 * window math, label parsing, classification and markdown rendering. They must
 * never spawn a CLI, touch a database or reach the network (see the card's
 * run-discipline rule); every window is passed explicitly so nothing here
 * depends on the host time zone or on "now".
 *
 * Node builtins only (`node:test`, `node:assert/strict`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ReportError,
  resolveWindow,
  labelValue,
  classifyTask,
  inWindow,
  aggregate,
  renderMarkdown,
} from "../../skills/task-panel/scripts/report.mjs";

const DAY_MS = 86_400_000;

/** A wire-shaped task, with per-test overrides. */
function task(overrides = {}) {
  return {
    identifier: "PROJ-0001",
    title: "a task",
    status: "done",
    kind: "task",
    labels: [],
    assignee: { id: "a1", display_name: "linus", kind: "agent" },
    status_changed_at: "2026-10-05T10:00:00.000Z",
    ...overrides,
  };
}

/** An explicit half-open window (never derived from `resolveWindow` in tests). */
function window_(overrides = {}) {
  return {
    period: "monthly",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-11-01T00:00:00.000Z",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    ...overrides,
  };
}

describe("resolveWindow", () => {
  it("daily: is one UTC day, start inclusive / end exclusive", () => {
    const w = resolveWindow("daily", "2026-10-09");
    assert.equal(w.period, "daily");
    assert.equal(w.start.toISOString(), "2026-10-09T00:00:00.000Z");
    assert.equal(w.end.toISOString(), "2026-10-10T00:00:00.000Z");
    assert.equal(w.end.getTime() - w.start.getTime(), DAY_MS);
    assert.equal(w.startDate, "2026-10-09");
    assert.equal(w.endDate, "2026-10-09");
  });

  it("weekly: is seven UTC days starting on a Monday", () => {
    const w = resolveWindow("weekly", "2026-10-09"); // a Friday
    assert.equal(w.period, "weekly");
    assert.equal(w.end.getTime() - w.start.getTime(), 7 * DAY_MS);
    assert.equal(w.start.getUTCDay(), 1, "the week starts on Monday");
    assert.ok(w.start.getTime() <= Date.parse("2026-10-09T12:00:00.000Z"));
    assert.ok(Date.parse("2026-10-09T12:00:00.000Z") < w.end.getTime());
    assert.equal(w.startDate, "2026-10-05");
    assert.equal(w.endDate, "2026-10-11");
  });

  it("monthly: spans one calendar month, ending on its last day", () => {
    const oct = resolveWindow("monthly", "2026-10-09");
    assert.equal(oct.period, "monthly");
    assert.equal(oct.start.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(oct.end.toISOString(), "2026-11-01T00:00:00.000Z");
    assert.equal(oct.startDate, "2026-10-01");
    assert.equal(oct.endDate, "2026-10-31");

    // A 30-day month and February both stay inside [28, 31] days.
    const nov = resolveWindow("monthly", "2026-11-15");
    const feb = resolveWindow("monthly", "2026-02-10");
    for (const w of [oct, nov, feb]) {
      const days = (w.end.getTime() - w.start.getTime()) / DAY_MS;
      assert.ok(days >= 28 && days <= 31, `month length ${days} out of range`);
    }
    assert.equal((nov.end.getTime() - nov.start.getTime()) / DAY_MS, 30);
    assert.equal((feb.end.getTime() - feb.start.getTime()) / DAY_MS, 28);
  });

  it("rejects an unknown period and a malformed date", () => {
    assert.throws(
      () => resolveWindow("yearly", "2026-10-09"),
      (err) => err instanceof ReportError && err.code === "INVALID_PERIOD",
    );
    assert.throws(
      () => resolveWindow("daily", "2026/10/09"),
      (err) => err instanceof ReportError && err.code === "INVALID_DATE",
    );
    assert.throws(
      () => resolveWindow("daily", "2026-02-30"),
      (err) => err instanceof ReportError && err.code === "INVALID_DATE",
    );
  });
});

describe("labelValue", () => {
  it("returns the value of the first matching namespace", () => {
    assert.equal(labelValue(["category:req", "area:cli"], "category"), "req");
    assert.equal(labelValue(["area:cli", "env:prod"], "env"), "prod");
    assert.equal(labelValue(["sev:P1"], "sev"), "P1");
  });

  it("matches the namespace case-insensitively and trims the value", () => {
    assert.equal(labelValue(["Category: Req"], "category"), "Req");
    assert.equal(labelValue(["ENV:PROD"], "env"), "PROD");
  });

  it("does not match a longer namespace that merely shares a prefix", () => {
    assert.equal(labelValue(["categoryx:req"], "category"), null);
  });

  it("defaults to null when absent, empty or not an array", () => {
    assert.equal(labelValue(["area:cli"], "category"), null);
    assert.equal(labelValue([], "category"), null);
    assert.equal(labelValue(undefined, "category"), null);
    assert.equal(labelValue(["category:"], "category"), null);
    assert.equal(labelValue(["category:req"], ""), null);
  });
});

describe("classifyTask", () => {
  it("maps the category label onto the four buckets", () => {
    assert.equal(classifyTask(task({ labels: ["category:req"] })), "requirement");
    assert.equal(classifyTask(task({ labels: ["category:dev"] })), "development");
    assert.equal(classifyTask(task({ labels: ["category:bug"] })), "bug");
  });

  it("treats a bug in production as an incident", () => {
    assert.equal(
      classifyTask(task({ labels: ["category:bug", "env:prod"] })),
      "incident",
    );
    // env:prod only matters together with category:bug.
    assert.equal(classifyTask(task({ labels: ["category:dev", "env:prod"] })), "development");
  });

  it("returns null for uncategorized cards and for epics", () => {
    assert.equal(classifyTask(task({ labels: ["area:cli"] })), null);
    assert.equal(classifyTask(task({ labels: [] })), null);
    assert.equal(classifyTask(task({ labels: ["category:dev"], kind: "epic" })), null);
    assert.equal(classifyTask(null), null);
  });

  it("is case-insensitive on both namespace and value", () => {
    assert.equal(classifyTask(task({ labels: ["Category:BUG", "Env:Prod"] })), "incident");
  });
});

describe("inWindow", () => {
  it("keeps only done cards whose status_changed_at is in [start, end)", () => {
    assert.equal(inWindow(task(), window_()), true);
    // The bound is inclusive at the start …
    assert.equal(
      inWindow(task({ status_changed_at: "2026-10-01T00:00:00.000Z" }), window_()),
      true,
    );
    // … and exclusive at the end.
    assert.equal(
      inWindow(task({ status_changed_at: "2026-11-01T00:00:00.000Z" }), window_()),
      false,
    );
    assert.equal(
      inWindow(task({ status_changed_at: "2026-09-30T23:59:59.999Z" }), window_()),
      false,
    );
  });

  it("rejects non-done cards and cards with no completion time", () => {
    assert.equal(inWindow(task({ status: "in_progress" }), window_()), false);
    assert.equal(inWindow(task({ status_changed_at: null }), window_()), false);
    assert.equal(inWindow(task({ status_changed_at: "not-a-date" }), window_()), false);
  });
});

describe("aggregate", () => {
  const tasks = [
    task({ identifier: "PROJ-0001", labels: ["category:req"] }),
    task({ identifier: "PROJ-0002", labels: ["category:dev"] }),
    task({ identifier: "PROJ-0003", labels: ["category:bug"] }),
    task({ identifier: "PROJ-0004", labels: ["category:bug", "env:prod"] }),
    // Not counted: outside the window, not done, epic, or uncategorized.
    task({ identifier: "PROJ-0005", labels: ["category:req"], status_changed_at: "2026-09-01T00:00:00.000Z" }),
    task({ identifier: "PROJ-0006", labels: ["category:req"], status: "in_progress" }),
    task({ identifier: "PROJ-0007", labels: ["category:dev"], kind: "epic" }),
    task({ identifier: "PROJ-0008", labels: ["area:cli"] }),
  ];

  it("counts the four dimensions, the total and the completed list", () => {
    const summary = aggregate(tasks, window_());

    assert.deepEqual(summary.counts, {
      requirements: 1,
      development: 1,
      bugs: 1,
      incidents: 1,
      total: 4,
    });
    assert.equal(summary.window.startDate, "2026-10-01");
    assert.equal(summary.window.endDate, "2026-10-31");

    const ids = summary.items.map((item) => item.identifier);
    assert.deepEqual(ids, ["PROJ-0001", "PROJ-0002", "PROJ-0003", "PROJ-0004"]);
    for (const item of summary.items) {
      assert.equal(typeof item.title, "string");
      assert.equal(item.assignee, "linus");
      assert.ok(item.category);
    }
    assert.equal(summary.items[3].category, "incident");
  });

  it("never counts uncategorized cards as a bucket, but keeps the window honest", () => {
    const lonely = aggregate([task({ identifier: "PROJ-0009", labels: [] })], window_());
    assert.equal(lonely.counts.total, 0);
    assert.deepEqual(lonely.items, []);
  });

  it("accepts an explicit window and derives its date range", () => {
    const summary = aggregate([task()], {
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
    assert.equal(summary.window.startDate, "2026-10-01");
    assert.equal(summary.window.endDate, "2026-10-31");
  });

  it("rejects a window that is missing or inverted", () => {
    assert.throws(
      () => aggregate([task()], { start: "2026-10-05", end: "2026-10-01" }),
      (err) => err instanceof ReportError && err.code === "INVALID_WINDOW",
    );
  });
});

describe("renderMarkdown", () => {
  it("fills the placeholders with counts, dates and the completed cards", () => {
    const summary = aggregate(
      [
        task({ identifier: "PROJ-0001", title: "ship the thing", labels: ["category:req"] }),
        task({
          identifier: "PROJ-0002",
          title: "fix the thing",
          labels: ["category:bug", "env:prod"],
          assignee: { id: "a2", display_name: "elon", kind: "human" },
        }),
      ],
      window_({ period: "daily" }),
    );
    summary.generatedAt = "2026-10-09T12:00:00.000Z";
    summary.project = "proj";

    const md = renderMarkdown(summary);

    assert.match(md, /Overview/);
    assert.match(md, /Requirements handled/);
    assert.match(md, /Development tasks completed/);
    assert.match(md, /Bugs fixed/);
    assert.match(md, /Production incidents/);
    assert.match(md, /Key decisions & milestones/);
    assert.match(md, /Risks & blockers/);
    assert.match(md, /Next period plan/);

    assert.match(md, /2026-10-01/);
    assert.match(md, /2026-10-31/);
    assert.match(md, /2026-10-09T12:00:00.000Z/);
    assert.match(md, /PROJ-0001/);
    assert.match(md, /ship the thing/);
    assert.match(md, /PROJ-0002/);
    assert.match(md, /elon/);
    assert.match(md, /Requirements handled[\s\S]*?\b1\b/);

    // Placeholders are resolved, never left in the output.
    assert.doesNotMatch(md, /\{\{[a-z_]+\}\}/);
  });

  it("renders an empty period without crashing", () => {
    const md = renderMarkdown(aggregate([], window_()));
    assert.match(md, /Requirements handled/);
    assert.doesNotMatch(md, /\{\{[a-z_]+\}\}/);
  });
});
