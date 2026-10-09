#!/usr/bin/env node
/**
 * Periodic report generator for the Meerkat TaskPanel skill — daily / weekly / monthly
 * reports plus the statistics that back them.
 *
 * Two layers live here on purpose:
 *
 *   1. **Pure helpers** (`resolveWindow`, `labelValue`, `inWindow`, `groupOf`,
 *      `applyPreset`, `aggregate`, `renderMarkdown`) — no I/O, no clock reads
 *      except a caller-overridable default. They are the unit-tested core; the
 *      same functions are what `node --test test/skill/report.test.mjs`
 *      exercises.
 *   2. **A CLI entry** that reads the board through the skill's own wrapper —
 *      it spawns `run.mjs` (the thin `taskctl` shim) in this directory, so the
 *      script stays runnable from any working directory.
 *
 * The counting is deliberately **domain-agnostic**: cards are bucketed by a
 * grouping dimension (`kind` by default, or `project` / `assignee` / `status` /
 * `label:<namespace>`), and a *metric preset* only adds named, filtered counts.
 * The one preset shipped here — `software` — is an **example**, not the
 * capability: any team defines its own metrics by picking a grouping dimension
 * and `namespace:value` label filters. Nothing in the aggregation assumes the
 * cards describe software.
 *
 * The data source is the existing `taskctl issue list --json` query; this file
 * adds **no** new backend query. Node builtins only, zero dependencies, no
 * network beyond the local loopback board that `taskctl` itself talks to.
 *
 * The reading conventions (which cards count, where "completion time" comes
 * from, what each label namespace means, how to define a metric) are written
 * down once in `references/reports.md` §统计口径 — keep this file and that
 * document aligned.
 *
 * @see ../references/reports.md
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The periods this generator understands. */
export const PERIODS = Object.freeze(["daily", "weekly", "monthly"]);

/** The fixed grouping dimensions; `label:<namespace>` is the fifth form. */
export const GROUP_DIMENSIONS = Object.freeze(["kind", "project", "assignee", "status"]);

/** Label namespaces the board convention reserves (see references/reports.md). */
export const LABEL_NAMESPACES = Object.freeze({
  CATEGORY: "category",
  AREA: "area",
  ENV: "env",
  SEV: "sev",
});

/** Freeze a value and everything under it, so a preset cannot be mutated. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Metric presets: one named, ready-made aggregation each.
 *
 * A preset bundles a default `groupBy`, the `kind`s it refuses to count, and a
 * list of named metrics. A metric is a set of label filters — `where` clauses
 * must all hold, `without` clauses must all fail — so the whole thing is data,
 * not code: a new domain is a new entry here (or none at all, if the plain
 * `--group-by` counts are enough).
 *
 * `software` is the shipped **example**. It is not special-cased anywhere:
 * removing it would leave a fully working, purely generic generator.
 */
export const PRESETS = deepFreeze({
  software: {
    name: "software",
    title: "Software delivery",
    groupBy: "label:category",
    // An epic is a container for other cards, not a unit of delivered work.
    excludeKinds: ["epic"],
    metrics: [
      {
        key: "requirements",
        label: "Requirements handled",
        where: [{ ns: "category", value: "req" }],
      },
      {
        key: "development",
        label: "Development tasks completed",
        where: [{ ns: "category", value: "dev" }],
      },
      {
        key: "bugs",
        label: "Bugs fixed",
        where: [{ ns: "category", value: "bug" }],
        without: [{ ns: "env", value: "prod" }],
      },
      {
        key: "incidents",
        label: "Production incidents",
        where: [
          { ns: "category", value: "bug" },
          { ns: "env", value: "prod" },
        ],
      },
    ],
  },
});

/** A stable, human title per period. */
const PERIOD_TITLE = Object.freeze({
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
});

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LABEL_PREFIX = "label:";

/**
 * A report-layer failure. Every rejection carries a stable `code`; callers bind
 * to the code, never to the message prose.
 */
export class ReportError extends Error {
  /**
   * @param {string} code stable error code
   * @param {string} message human-readable detail
   */
  constructor(code, message) {
    super(message);
    this.name = "ReportError";
    this.code = code;
  }
}

/** `YYYY-MM-DD` for a Date, in UTC. @param {Date} date */
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a `YYYY-MM-DD` string as UTC midnight. An omitted value means "today".
 *
 * UTC is deliberate: a local-time window would shift by an hour across a DST
 * boundary and silently swallow or duplicate a card's completion.
 *
 * @param {string|undefined|null} dateStr
 * @returns {Date}
 * @throws {ReportError} `INVALID_DATE`
 */
function parseDay(dateStr) {
  if (dateStr === undefined || dateStr === null || dateStr === "") {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const match = DATE_PATTERN.exec(String(dateStr).trim());
  if (!match) {
    throw new ReportError("INVALID_DATE", `expected a YYYY-MM-DD date, got ${JSON.stringify(dateStr)}`);
  }
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject dates the calendar does not have (e.g. 2026-02-30 rolls over).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new ReportError("INVALID_DATE", `${dateStr} is not a real calendar date`);
  }
  return date;
}

/**
 * The reporting window that contains `dateStr`.
 *
 * The window is **half-open**: `start` is included, `end` is excluded. `daily`
 * is one UTC day; `weekly` is the ISO week (Monday start); `monthly` is the
 * calendar month. `startDate`/`endDate` are the first and last *included* days,
 * ready for the templates' `{{period_start}}` / `{{period_end}}`.
 *
 * @param {"daily"|"weekly"|"monthly"} period
 * @param {string} [dateStr] any day inside the window; defaults to today
 * @returns {{period: string, start: Date, end: Date, startDate: string, endDate: string}}
 * @throws {ReportError} `INVALID_PERIOD` | `INVALID_DATE`
 */
export function resolveWindow(period, dateStr) {
  const kind = period === undefined || period === null || period === "" ? "daily" : period;
  if (!PERIODS.includes(kind)) {
    throw new ReportError("INVALID_PERIOD", `period must be one of ${PERIODS.join("|")}, got ${JSON.stringify(period)}`);
  }

  const day = parseDay(dateStr);
  const y = day.getUTCFullYear();
  const m = day.getUTCMonth();
  const d = day.getUTCDate();

  let start;
  let end;
  if (kind === "daily") {
    start = new Date(Date.UTC(y, m, d));
    end = new Date(Date.UTC(y, m, d + 1));
  } else if (kind === "weekly") {
    const sinceMonday = (day.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
    start = new Date(Date.UTC(y, m, d - sinceMonday));
    end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 7));
  } else {
    start = new Date(Date.UTC(y, m, 1));
    end = new Date(Date.UTC(y, m + 1, 1));
  }

  return {
    period: kind,
    start,
    end,
    startDate: isoDate(start),
    // The last day the window *includes* — one day before the exclusive end.
    endDate: isoDate(new Date(end.getTime() - DAY_MS)),
  };
}

/**
 * The value of a `<namespace>:<value>` label, if the card carries one.
 *
 * `labels` is the wire array of strings; the **namespace** is matched
 * case-insensitively and must match in full — `categoryx:req` is *not* a
 * `category:`. The value is returned as written (trimmed).
 *
 * @param {unknown} labels
 * @param {string} ns namespace without the colon, e.g. `"category"`
 * @returns {string|null} the value, or `null` when the namespace is absent
 */
export function labelValue(labels, ns) {
  if (!Array.isArray(labels) || typeof ns !== "string" || ns.trim() === "") return null;
  const wanted = ns.trim().toLowerCase();
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    const colon = text.indexOf(":");
    if (colon === -1) continue;
    // Compare the whole namespace token, so `categoryx:req` ≠ `category:req`.
    if (text.slice(0, colon).trim().toLowerCase() !== wanted) continue;
    const value = text.slice(colon + 1).trim();
    if (value === "") continue;
    return value;
  }
  return null;
}

/**
 * The display name of a wire assignee, or `null`.
 *
 * @param {unknown} assignee an actor ref (`{id, display_name}`), a bare string, or nothing
 * @returns {string|null}
 */
function assigneeName(assignee) {
  if (assignee === null || assignee === undefined) return null;
  if (typeof assignee === "string") return assignee.trim() === "" ? null : assignee;
  if (typeof assignee !== "object") return null;
  const name = assignee.display_name ?? assignee.displayName ?? assignee.id ?? null;
  return name === null || name === undefined ? null : String(name);
}

/**
 * Does this card belong to `name`?
 *
 * The report filters assignees **locally**, by display name *or* id, because
 * the board's own `issue list` filter takes an opaque `--assignee-id` — a
 * report reader should not have to look one up first. Matching is
 * case-insensitive; a card with no assignee never matches.
 *
 * @param {object|null} task a wire-shaped task
 * @param {string} name an assignee display name or id
 * @returns {boolean}
 */
export function matchesAssignee(task, name) {
  const wanted = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (wanted === "" || !task || typeof task !== "object") return false;
  const candidates = [];
  const who = task.assignee;
  if (typeof who === "string") candidates.push(who);
  else if (who && typeof who === "object") candidates.push(who.display_name ?? who.displayName, who.id);
  candidates.push(task.assignee_id ?? task.assigneeId);
  return candidates.some(
    (candidate) => candidate !== undefined && candidate !== null && String(candidate).trim().toLowerCase() === wanted,
  );
}

/** Milliseconds for a Date / ISO string / epoch number, or `null` if unusable. */
function toTime(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** `{start, end}` as milliseconds, or `null` when the window is unusable. */
function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const start = toTime(window.start);
  const end = toTime(window.end);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

/**
 * Is this card part of the window's completed work?
 *
 * Both conditions are necessary: the card is `done`, and its
 * `status_changed_at` — the moment it last entered `done` — falls inside the
 * half-open window. A card with no usable completion time never counts.
 *
 * @param {object|null} task a wire-shaped task
 * @param {{start: unknown, end: unknown}} window half-open window
 * @returns {boolean}
 */
export function inWindow(task, window) {
  if (!task || typeof task !== "object") return false;
  if (task.status !== "done") return false;
  const at = toTime(task.status_changed_at ?? task.statusChangedAt);
  if (at === null) return false;
  const w = normalizeWindow(window);
  if (w === null) return false;
  return at >= w.start && at < w.end;
}

/**
 * Parse a grouping spec.
 *
 * Accepts one of `kind` / `project` / `assignee` / `status`, or
 * `label:<namespace>` for any label namespace the team uses (`category`,
 * `area`, `env`, `sev`, or one of its own).
 *
 * @param {string} spec
 * @returns {{dimension: string, namespace: string|null}}
 * @throws {ReportError} `INVALID_GROUP_BY`
 */
export function parseGroupBy(spec) {
  const text = typeof spec === "string" ? spec.trim() : "";
  if (text === "") {
    throw new ReportError(
      "INVALID_GROUP_BY",
      `group-by must be one of ${GROUP_DIMENSIONS.join("|")} or label:<namespace>, got ${JSON.stringify(spec)}`,
    );
  }
  const lower = text.toLowerCase();
  if (lower.startsWith(LABEL_PREFIX)) {
    const namespace = text.slice(LABEL_PREFIX.length).trim();
    if (namespace === "") {
      throw new ReportError("INVALID_GROUP_BY", "group-by label: needs a namespace, e.g. label:category");
    }
    return { dimension: "label", namespace };
  }
  if (!GROUP_DIMENSIONS.includes(lower)) {
    throw new ReportError(
      "INVALID_GROUP_BY",
      `group-by must be one of ${GROUP_DIMENSIONS.join("|")} or label:<namespace>, got ${JSON.stringify(spec)}`,
    );
  }
  return { dimension: lower, namespace: null };
}

/**
 * A value as a grouping key: trimmed, lower-cased, empty → `null`.
 *
 * Buckets are case-insensitive on purpose — `Category:Req` and `category:req`
 * are one bucket — so a report does not split on a label's spelling. The
 * per-card list still shows the assignee's own display name.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function groupKey(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text.toLowerCase();
}

/** `groupOf` against an already-parsed spec (the hot path inside `aggregate`). */
function groupFor(task, spec) {
  if (!task || typeof task !== "object") return null;
  switch (spec.dimension) {
    case "kind":
      return groupKey(task.kind);
    case "project":
      return groupKey(task.project_id ?? task.project ?? null);
    case "assignee":
      return groupKey(assigneeName(task.assignee));
    case "status":
      return groupKey(task.status);
    case "label":
      return groupKey(labelValue(task.labels, spec.namespace));
    default:
      return null;
  }
}

/**
 * The bucket a card falls into under one grouping dimension, or `null` when the
 * card carries no value for it (an uncategorized card is not counted).
 *
 * @param {object|null} task a wire-shaped task
 * @param {string} groupBy `kind` | `project` | `assignee` | `status` | `label:<ns>`
 * @returns {string|null} the lower-cased bucket key, or `null`
 * @throws {ReportError} `INVALID_GROUP_BY`
 */
export function groupOf(task, groupBy) {
  return groupFor(task, parseGroupBy(groupBy));
}

/**
 * Look up a metric preset by name.
 *
 * @param {string} name a preset name; `software` is the shipped example
 * @returns {object} the frozen preset spec
 * @throws {ReportError} `INVALID_PRESET`
 */
export function applyPreset(name) {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!Object.prototype.hasOwnProperty.call(PRESETS, key)) {
    throw new ReportError(
      "INVALID_PRESET",
      `unknown preset ${JSON.stringify(name)}; available: ${Object.keys(PRESETS).join(", ") || "(none)"}`,
    );
  }
  return PRESETS[key];
}

/** Does `task` carry `ns:value`, case-insensitively? */
function hasLabel(task, clause) {
  const value = labelValue(task.labels, clause.ns);
  return value !== null && value.trim().toLowerCase() === String(clause.value).trim().toLowerCase();
}

/** Every `where` clause holds and no `without` clause does. */
function matchesMetric(task, metric) {
  for (const clause of metric.where ?? []) {
    if (!hasLabel(task, clause)) return false;
  }
  for (const clause of metric.without ?? []) {
    if (hasLabel(task, clause)) return false;
  }
  return true;
}

/**
 * Aggregate the cards completed inside one window.
 *
 * Only cards that pass `inWindow` **and** carry a value for the grouping
 * dimension are counted, so an uncategorized card is invisible to the report
 * rather than quietly landing in a bucket. `counts` is a `bucket → count` map
 * and `total` is the number of counted cards.
 *
 * A `preset` adds `metrics`: named counts from the preset's label filters,
 * computed over the same in-window cards (after its `excludeKinds`). Filters
 * may overlap — a card can fit two metrics — so metric counts need not sum to
 * `total`; `total` counts every card once.
 *
 * @param {object[]} tasks wire-shaped tasks (as returned by `issue list --json`)
 * @param {object} window a `resolveWindow(...)` result, optionally carrying
 *   `project` / `assignee` / `generatedAt`; an explicit `{start, end}` works too
 * @param {{groupBy?: string, preset?: object|null}} [options]
 * @returns {object} the summary that `renderMarkdown` consumes
 * @throws {ReportError} `INVALID_WINDOW` | `INVALID_GROUP_BY`
 */
export function aggregate(tasks, window, options = {}) {
  const w = normalizeWindow(window);
  if (w === null) {
    throw new ReportError("INVALID_WINDOW", "window must carry a finite start earlier than its end");
  }

  const preset = options?.preset ?? null;
  const groupBy = String((options?.groupBy ?? preset?.groupBy ?? "kind")).trim();
  const spec = parseGroupBy(groupBy);
  const excluded = new Set((preset?.excludeKinds ?? []).map((kind) => String(kind).toLowerCase()));

  const counts = new Map();
  const metricCounts = new Map((preset?.metrics ?? []).map((metric) => [metric.key, 0]));
  const items = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!inWindow(task, window)) continue;
    if (excluded.has(String(task.kind ?? "").toLowerCase())) continue;
    const group = groupFor(task, spec);
    if (group === null) continue; // uncategorized: outside every bucket
    counts.set(group, (counts.get(group) ?? 0) + 1);

    let metric = null;
    for (const candidate of preset?.metrics ?? []) {
      if (!matchesMetric(task, candidate)) continue;
      metric = metric ?? candidate.key;
      metricCounts.set(candidate.key, metricCounts.get(candidate.key) + 1);
    }

    items.push({
      identifier: task.identifier ?? null,
      title: String(task.title ?? ""),
      assignee: assigneeName(task.assignee),
      group,
      metric,
      completedAt: task.status_changed_at ?? task.statusChangedAt ?? null,
    });
  }

  // Chronological, ties broken by identifier, so the same board always renders
  // the same report.
  items.sort(
    (a, b) =>
      String(a.completedAt).localeCompare(String(b.completedAt)) ||
      String(a.identifier).localeCompare(String(b.identifier)) ||
      String(a.group).localeCompare(String(b.group)),
  );

  const orderedCounts = {};
  for (const key of [...counts.keys()].sort()) orderedCounts[key] = counts.get(key);

  const startDate = window.startDate ?? isoDate(new Date(w.start));
  const endDate = window.endDate ?? isoDate(new Date(w.end - DAY_MS));

  return {
    period: window.period ?? null,
    project: window.project ?? null,
    assignee: window.assignee ?? null,
    groupBy,
    preset: preset?.name ?? null,
    presetTitle: preset?.title ?? null,
    generatedAt: window.generatedAt ?? new Date().toISOString(),
    window: {
      start: new Date(w.start).toISOString(),
      end: new Date(w.end).toISOString(),
      startDate,
      endDate,
    },
    counts: orderedCounts,
    metrics: preset ? preset.metrics.map((m) => ({ key: m.key, label: m.label, count: metricCounts.get(m.key) })) : null,
    total: items.length,
    items,
  };
}

/** One markdown bullet per card, or a `_None._` placeholder. */
function cardList(items, labelOf) {
  if (items.length === 0) return "_None._";
  return items
    .map((item) => {
      const who = item.assignee ? ` (@${item.assignee})` : "";
      const when = item.completedAt ? ` — ${String(item.completedAt).slice(0, 10)}` : "";
      return `- ${labelOf(item)} · ${item.identifier ?? "(no id)"} — ${item.title}${who}${when}`;
    })
    .join("\n");
}

/**
 * Render a summary as the Markdown report the templates describe.
 *
 * The section order and headings mirror the templates embedded in
 * `references/reports.md` — Overview, Core metrics, Key decisions &
 * milestones, Risks & blockers, Next period plan — and every `{{placeholder}}`
 * is filled here, so the output is paste-ready. The three human-authored
 * sections are left as a `> TODO:` the author fills in; the generator cannot
 * invent them.
 *
 * @param {object} summary an `aggregate(...)` result
 * @returns {string}
 */
export function renderMarkdown(summary) {
  const s = summary ?? {};
  const window = s.window ?? {};
  const period = PERIODS.includes(s.period) ? s.period : "daily";
  const project = s.project ?? "(all projects)";
  const groupBy = s.groupBy ?? "kind";
  const items = Array.isArray(s.items) ? s.items : [];
  const metrics = Array.isArray(s.metrics) ? s.metrics : null;
  const metricLabels = new Map((metrics ?? []).map((metric) => [metric.key, metric.label]));
  const labelOf = (item) => (item.metric ? metricLabels.get(item.metric) ?? item.metric : `\`${item.group}\``);

  const periodLine =
    period === "daily"
      ? `${window.startDate ?? "?"} (one UTC day)`
      : `${window.startDate ?? "?"} → ${window.endDate ?? "?"}`;

  const lines = [
    `# ${PERIOD_TITLE[period]} report — ${project}`,
    "",
    `- Period: ${periodLine}`,
    `- Project: ${project}`,
    `- Grouped by: ${groupBy}`,
  ];
  if (s.preset) lines.push(`- Preset: ${s.preset}`);
  if (s.assignee) lines.push(`- Assignee: ${s.assignee}`);
  lines.push(`- Generated at: ${s.generatedAt ?? "?"}`, "", "## Overview", "", `- Total completed: ${s.total ?? 0}`, "");
  lines.push("> TODO: one or two sentences on how the period went.", "", "## Core metrics", "");

  if (metrics) {
    lines.push(`Preset \`${s.preset}\` · grouped by \`${groupBy}\`:`);
    lines.push("");
    for (const metric of metrics) lines.push(`- ${metric.label}: ${metric.count}`);
  } else {
    const keys = Object.keys(s.counts ?? {});
    if (keys.length === 0) {
      lines.push("_None._");
    } else {
      lines.push(`Grouped by \`${groupBy}\`:`);
      lines.push("");
      for (const key of keys) lines.push(`- \`${key}\`: ${s.counts[key]}`);
    }
  }

  lines.push("", "### Completed cards", "", cardList(items, labelOf), "");
  lines.push(
    "## Key decisions & milestones",
    "",
    "> TODO: summarise the decisions and milestones from this period.",
    "",
    "## Risks & blockers",
    "",
    "> TODO: list the risks and blockers the team is carrying.",
    "",
    "## Next period plan",
    "",
    "> TODO: outline the plan for the next period.",
    "",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/report.mjs [options]

Build a periodic report from the board's completed cards.

Options:
  --period daily|weekly|monthly   Reporting window (default: daily).
  --date YYYY-MM-DD               Any day inside the window (default: today, UTC).
  --project <id>                  Restrict to one project (board-side filter).
  --assignee <name>               Restrict to one assignee (display name or id).
  --group-by <spec>               kind | project | assignee | status | label:<ns>
                                  (default: kind, or the preset's own grouping).
  --preset <name>                 Metric preset to apply (available: software).
  --limit <n>                     Max cards to read from the board (default: 1000).
  --json                          Print {ok,data:{summary}} instead of Markdown.
  -h, --help                      Show this help.

Exit codes: 0 ok · 1 runtime failure · 2 usage error.`;

const USAGE_ERROR_CODES = new Set([
  "INVALID_PERIOD",
  "INVALID_DATE",
  "INVALID_LIMIT",
  "INVALID_GROUP_BY",
  "INVALID_PRESET",
  "UNKNOWN_ARGUMENT",
]);

/**
 * Parse the CLI flags. Supports `--k v` and `--k=v`. Value-free flags
 * (`--json`) never consume the next token.
 *
 * @param {string[]} argv
 * @returns {{period: string, date: string|undefined, project: string|undefined,
 *   assignee: string|undefined, groupBy: string|undefined, preset: string|undefined,
 *   limit: number, json: boolean, help: boolean}}
 * @throws {ReportError} `INVALID_LIMIT`
 */
function parseArgs(argv) {
  const opts = {
    period: "daily",
    date: undefined,
    project: undefined,
    assignee: undefined,
    groupBy: undefined,
    preset: undefined,
    limit: 1000,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let flag = arg;
    let inline;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq !== -1) {
      flag = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new ReportError("INVALID_LIMIT", `${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--period":
        opts.period = value();
        break;
      case "--date":
        opts.date = value();
        break;
      case "--project":
        opts.project = value();
        break;
      case "--assignee":
        opts.assignee = value();
        break;
      case "--group-by":
        opts.groupBy = value();
        break;
      case "--preset":
        opts.preset = value();
        break;
      case "--limit": {
        const n = Number(value());
        if (!Number.isInteger(n) || n <= 0) {
          throw new ReportError("INVALID_LIMIT", `--limit must be a positive integer, got ${JSON.stringify(inline ?? argv[i])}`);
        }
        opts.limit = n;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new ReportError("UNKNOWN_ARGUMENT", `unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** The `error.code` carried by a taskctl JSON error payload, if any. */
function errorCodeOf(stdout) {
  try {
    const payload = JSON.parse(stdout);
    return payload?.error?.code ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the board through this directory's `run.mjs` (the `taskctl` shim).
 *
 * `--include-archived` is always passed: a card archived after the 7-day
 * retention window is still part of the period it was completed in, and a
 * monthly report that dropped it would undercount.
 *
 * @param {{project?: string, limit: number}} opts
 * @returns {object[]} wire-shaped tasks
 * @throws {ReportError} `DATA_SOURCE_FAILED`, or the board's own `error.code`
 */
function fetchTasks(opts) {
  const runner = join(here, "run.mjs");
  const args = [runner, "issue", "list", "--json", "--limit", String(opts.limit), "--include-archived"];
  if (opts.project) args.push("--project", opts.project);

  const result = spawnSync(process.execPath, args, { encoding: "utf8" });

  if (result.error) {
    throw new ReportError("DATA_SOURCE_FAILED", `failed to run ${runner}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const code = errorCodeOf(result.stdout) ?? "DATA_SOURCE_FAILED";
    const detail = (result.stderr || result.stdout || "").trim().split("\n")[0];
    throw new ReportError(code, `taskctl issue list failed (exit ${result.status})${detail ? `: ${detail}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new ReportError("DATA_SOURCE_FAILED", "taskctl did not return JSON on stdout");
  }
  if (payload?.ok !== true || !Array.isArray(payload?.data?.tasks)) {
    throw new ReportError(
      payload?.error?.code ?? "DATA_SOURCE_FAILED",
      payload?.error?.message ?? "unexpected taskctl payload: expected {ok:true,data:{tasks}}",
    );
  }
  return payload.data.tasks;
}

/** Resolve the preset and grouping *before* reading the board, so a typo fails fast. */
function resolveConfig(opts) {
  const preset = opts.preset === undefined ? null : applyPreset(opts.preset);
  const groupBy = String(opts.groupBy ?? preset?.groupBy ?? "kind").trim();
  parseGroupBy(groupBy); // validate now, not after a board read
  return { preset, groupBy };
}

/** Write a failure to the agreed stream, then return the process exit code. */
function reportFailure(err, json) {
  const isReportError = err instanceof ReportError;
  const code = isReportError ? err.code : "INTERNAL_ERROR";
  const message = err?.message ?? String(err);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  } else {
    process.stderr.write(`report: ${code}: ${message}\n`);
  }
  // Usage problems exit 2 (the CLI's own convention); everything else is a
  // runtime failure.
  return USAGE_ERROR_CODES.has(code) ? 2 : 1;
}

/**
 * The CLI entry point.
 *
 * @param {string[]} argv
 * @returns {number} process exit code
 */
async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return reportFailure(err, argv.includes("--json"));
  }

  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const { preset, groupBy } = resolveConfig(opts);
    const window = {
      ...resolveWindow(opts.period, opts.date),
      project: opts.project ?? null,
      assignee: opts.assignee ?? null,
    };
    let tasks = fetchTasks(opts);
    if (opts.assignee) tasks = tasks.filter((task) => matchesAssignee(task, opts.assignee));
    const summary = aggregate(tasks, window, { groupBy, preset });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { summary } }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderMarkdown(summary)}\n`);
    }
    return 0;
  } catch (err) {
    return reportFailure(err, opts.json);
  }
}

// Only run when executed directly, so the tests can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}

export { main as run };
