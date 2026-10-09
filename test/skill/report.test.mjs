/**
 * Unit tests for the skill's periodic-report helpers
 * (`skills/meerkat-taskpanel/scripts/report.mjs`).
 *
 * These tests exercise the **pure functions only** — the report aggregator's
 * window math, label parsing, grouping, preset metrics and markdown rendering.
 * They must never spawn a CLI, touch a database or reach the network (see the
 * card's run-discipline rule); every window is passed explicitly so nothing
 * here depends on the host time zone or on "now".
 *
 * Node builtins only (`node:test`, `node:assert/strict`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ReportError,
  resolveWindow,
  labelValue,
  parseGroupBy,
  groupOf,
  matchesAssignee,
  applyPreset,
  inWindow,
  aggregate,
  renderMarkdown,
} from "../../skills/meerkat-taskpanel/scripts/report.mjs";

const DAY_MS = 86_400_000;

/** A wire-shaped task, with per-test overrides. */
function task(overrides = {}) {
  return {
    identifier: "PROJ-0001",
    title: "a task",
    status: "done",
    kind: "task",
    project_id: "proj",
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

describe("parseGroupBy", () => {
  it("accepts the fixed dimensions and label:<namespace>", () => {
    for (const dimension of ["kind", "project", "assignee", "status"]) {
      assert.deepEqual(parseGroupBy(dimension), { dimension, namespace: null });
    }
    assert.deepEqual(parseGroupBy("label:category"), { dimension: "label", namespace: "category" });
    assert.deepEqual(parseGroupBy("Label:Area"), { dimension: "label", namespace: "Area" });
  });

  it("rejects an unknown dimension and a bare label: prefix", () => {
    for (const bad of ["nope", "label:", "label:   ", "", undefined]) {
      assert.throws(
        () => parseGroupBy(bad),
        (err) => err instanceof ReportError && err.code === "INVALID_GROUP_BY",
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });
});

describe("groupOf", () => {
  it("buckets by the requested dimension", () => {
    const t = task({ kind: "task", project_id: "proj", status: "done", labels: ["category:Req"] });
    assert.equal(groupOf(t, "kind"), "task");
    assert.equal(groupOf(t, "project"), "proj");
    assert.equal(groupOf(t, "status"), "done");
    assert.equal(groupOf(t, "assignee"), "linus");
    assert.equal(groupOf(t, "label:category"), "req");
  });

  it("is case-insensitive, so a bucket does not split on spelling", () => {
    assert.equal(groupOf(task({ kind: "TASK" }), "kind"), "task");
    assert.equal(groupOf(task({ labels: ["Category:REQ"] }), "label:category"), "req");
    assert.equal(groupOf(task({ assignee: { id: "a1", display_name: "Linus" } }), "assignee"), "linus");
  });

  it("returns null when the card carries no value for the dimension", () => {
    assert.equal(groupOf(task({ project_id: null }), "project"), null);
    assert.equal(groupOf(task({ project_id: "" }), "project"), null);
    assert.equal(groupOf(task({ assignee: null }), "assignee"), null);
    assert.equal(groupOf(task({ labels: ["area:cli"] }), "label:category"), null);
    assert.equal(groupOf(task({ labels: [] }), "label:env"), null);
    assert.equal(groupOf(task({ kind: null }), "kind"), null);
    assert.equal(groupOf(null, "kind"), null);
  });

  it("throws on an unusable grouping spec", () => {
    assert.throws(
      () => groupOf(task(), "label:"),
      (err) => err instanceof ReportError && err.code === "INVALID_GROUP_BY",
    );
  });
});

describe("matchesAssignee", () => {
  it("matches a display name or an id, case-insensitively", () => {
    assert.equal(matchesAssignee(task(), "linus"), true);
    assert.equal(matchesAssignee(task(), "LINUS"), true);
    assert.equal(matchesAssignee(task(), "a1"), true);
  });

  it("accepts a bare-string assignee and ignores everyone else", () => {
    assert.equal(matchesAssignee(task({ assignee: "elon" }), "elon"), true);
    assert.equal(matchesAssignee(task(), "elon"), false);
    assert.equal(matchesAssignee(task({ assignee: null }), "linus"), false);
    assert.equal(matchesAssignee(task(), ""), false);
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

describe("applyPreset", () => {
  it("returns the software example as a frozen spec", () => {
    const preset = applyPreset("software");
    assert.equal(preset.name, "software");
    assert.equal(preset.groupBy, "label:category");
    assert.deepEqual(preset.excludeKinds, ["epic"]);
    assert.deepEqual(
      preset.metrics.map((metric) => metric.key),
      ["requirements", "development", "bugs", "incidents"],
    );
    assert.ok(Object.isFrozen(preset));
    // Same object each time — a preset is a constant, not a per-call value.
    assert.equal(applyPreset("Software"), preset);
  });

  it("rejects an unknown preset", () => {
    for (const bad of ["nope", "", undefined]) {
      assert.throws(
        () => applyPreset(bad),
        (err) => err instanceof ReportError && err.code === "INVALID_PRESET",
      );
    }
  });
});

describe("aggregate", () => {
  const tasks = [
    task({ identifier: "PROJ-0001", kind: "task", labels: ["category:req"] }),
    task({ identifier: "PROJ-0002", kind: "task", labels: ["category:dev"], project_id: "proj" }),
    task({ identifier: "PROJ-0003", kind: "task", labels: ["category:bug"], project_id: "other" }),
    // Not counted: outside the window, not done, epic, or with no group value.
    task({ identifier: "PROJ-0004", labels: ["category:req"], status_changed_at: "2026-09-01T00:00:00.000Z" }),
    task({ identifier: "PROJ-0005", labels: ["category:req"], status: "in_progress" }),
    task({ identifier: "PROJ-0006", kind: "epic", labels: ["category:req"] }),
    task({ identifier: "PROJ-0007", labels: ["area:cli"] }),
    task({ identifier: "PROJ-0008", project_id: null, labels: ["category:dev"] }),
  ];

  it("groups by kind by default", () => {
    const summary = aggregate(tasks, window_());
    // Every in-window card with a kind counts — the epics too: a plain kind
    // breakdown describes the board, it does not judge what "work" is.
    assert.equal(summary.groupBy, "kind");
    assert.deepEqual(summary.counts, { epic: 1, task: 5 });
    assert.equal(summary.total, 6);
    assert.equal(summary.metrics, null);
    assert.equal(summary.preset, null);
  });

  it("groups by an arbitrary dimension: label:<ns>, project, assignee", () => {
    const byCategory = aggregate(tasks, window_(), { groupBy: "label:category" });
    assert.deepEqual(byCategory.counts, { req: 2, dev: 2, bug: 1 });
    assert.equal(byCategory.total, 5);

    const byProject = aggregate(tasks, window_(), { groupBy: "project" });
    assert.deepEqual(byProject.counts, { proj: 4, other: 1 });

    const byAssignee = aggregate(tasks, window_(), { groupBy: "assignee" });
    assert.deepEqual(byAssignee.counts, { linus: 6 });
  });

  it("never counts a card that has no value for the grouping dimension", () => {
    // PROJ-0008 has no project; PROJ-0007 carries no category label.
    const byProject = aggregate(tasks, window_(), { groupBy: "project" });
    assert.equal(byProject.total, 5);
    assert.equal(byProject.items.some((item) => item.identifier === "PROJ-0008"), false);

    const byCategory = aggregate(tasks, window_(), { groupBy: "label:category" });
    assert.equal(byCategory.total, 5);
    assert.equal(byCategory.items.some((item) => item.identifier === "PROJ-0007"), false);
  });

  it("applies the software preset: category grouping and the env:prod split", () => {
    const preset = applyPreset("software");
    const summary = aggregate(
      [
        ...tasks,
        task({ identifier: "PROJ-0009", labels: ["category:bug", "env:prod"] }),
        task({ identifier: "PROJ-0010", kind: "epic", labels: ["category:req"] }),
      ],
      window_(),
      { preset },
    );

    assert.equal(summary.preset, "software");
    assert.equal(summary.groupBy, "label:category"); // the preset supplies it
    // The epic is excluded by the preset; PROJ-0004/0005/0007/0008 have no bucket.
    assert.deepEqual(summary.counts, { req: 1, dev: 2, bug: 2 });
    assert.deepEqual(
      summary.metrics.map((metric) => [metric.key, metric.count]),
      [
        ["requirements", 1],
        ["development", 2],
        ["bugs", 1],
        ["incidents", 1],
      ],
    );
    assert.equal(summary.total, 5);

    const prodBug = summary.items.find((item) => item.identifier === "PROJ-0009");
    assert.equal(prodBug.metric, "incidents");
    assert.equal(prodBug.group, "bug");
  });

  it("keeps each card once and carries its window, project and items", () => {
    const summary = aggregate(tasks, window_({ project: "proj", assignee: "linus" }), { groupBy: "kind" });
    assert.equal(summary.project, "proj");
    assert.equal(summary.assignee, "linus");
    assert.equal(summary.window.startDate, "2026-10-01");
    assert.equal(summary.window.endDate, "2026-10-31");
    assert.equal(summary.total, summary.items.length);

    const ids = summary.items.map((item) => item.identifier);
    assert.deepEqual(ids, ["PROJ-0001", "PROJ-0002", "PROJ-0003", "PROJ-0006", "PROJ-0007", "PROJ-0008"]);
    for (const item of summary.items) {
      assert.equal(typeof item.title, "string");
      assert.equal(item.assignee, "linus");
      assert.ok(item.group);
    }
  });

  it("accepts an explicit window and derives its date range", () => {
    const summary = aggregate([task()], {
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    });
    assert.equal(summary.window.startDate, "2026-10-01");
    assert.equal(summary.window.endDate, "2026-10-31");
  });

  it("rejects a window that is missing or inverted, and an unusable group-by", () => {
    assert.throws(
      () => aggregate([task()], { start: "2026-10-05", end: "2026-10-01" }),
      (err) => err instanceof ReportError && err.code === "INVALID_WINDOW",
    );
    assert.throws(
      () => aggregate([task()], window_(), { groupBy: "nope" }),
      (err) => err instanceof ReportError && err.code === "INVALID_GROUP_BY",
    );
  });
});

describe("renderMarkdown", () => {
  it("renders the five sections and the configurable metric counts", () => {
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
      { preset: applyPreset("software") },
    );
    summary.generatedAt = "2026-10-09T12:00:00.000Z";
    summary.project = "proj";

    const md = renderMarkdown(summary);

    for (const heading of [
      "## Overview",
      "## Core metrics",
      "## Key decisions & milestones",
      "## Risks & blockers",
      "## Next period plan",
    ]) {
      assert.ok(md.includes(heading), `missing ${heading}`);
    }

    // A daily report names its single UTC day, with no end date of its own.
    assert.match(md, /2026-10-01 \(one UTC day\)/);
    assert.match(md, /2026-10-09T12:00:00.000Z/);
    assert.match(md, /Requirements handled: 1/);
    assert.match(md, /Production incidents: 1/);
    assert.match(md, /PROJ-0001/);
    assert.match(md, /ship the thing/);
    assert.match(md, /elon/);

    // Placeholders are resolved, never left in the output.
    assert.doesNotMatch(md, /\{\{[a-z_]+\}\}/);
  });

  it("renders the plain grouping when no preset is applied", () => {
    const summary = aggregate(
      [task({ identifier: "PROJ-0001", kind: "task" }), task({ identifier: "PROJ-0002", kind: "epic" })],
      window_({ period: "monthly" }),
      { groupBy: "kind" },
    );

    const md = renderMarkdown(summary);
    assert.match(md, /- `task`: 1/);
    assert.match(md, /- `epic`: 1/);
    assert.match(md, /Total completed: 2/);
    // A multi-day window renders the range.
    assert.match(md, /2026-10-01 → 2026-10-31/);
    assert.doesNotMatch(md, /\{\{[a-z_]+\}\}/);
  });

  it("renders an empty period without crashing", () => {
    const md = renderMarkdown(aggregate([], window_()));
    assert.match(md, /## Core metrics/);
    assert.match(md, /_None\._/);
    assert.doesNotMatch(md, /\{\{[a-z_]+\}\}/);
  });
});
