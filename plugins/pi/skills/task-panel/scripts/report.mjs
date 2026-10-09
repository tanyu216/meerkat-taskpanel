#!/usr/bin/env node
/**
 * Periodic report generator for the Task Panel skill — daily / weekly / monthly
 * reports plus the aggregate counts that back them.
 *
 * Two layers live here on purpose:
 *
 *   1. **Pure helpers** (`resolveWindow`, `labelValue`, `classifyTask`,
 *      `inWindow`, `aggregate`, `renderMarkdown`) — no I/O, no clock reads
 *      except a caller-overridable default. They are the unit-tested core; the
 *      same functions are what `node --test test/skill/report.test.mjs`
 *      exercises.
 *   2. **A CLI entry** that reads the board through the skill's own wrapper —
 *      it spawns `run.mjs` (the thin `taskctl` shim) in this directory, so the
 *      script stays runnable from any working directory.
 *
 * The data source is the existing `taskctl issue list --json` query; this file
 * adds **no** new backend query. Node builtins only, zero dependencies, no
 * network beyond the local loopback board that `taskctl` itself talks to.
 *
 * The reading conventions (which cards count, where "completion time" comes
 * from, what each label namespace means) are written down once in
 * `references/reports.md` §统计口径 — keep this file and that document aligned.
 *
 * @see ../references/reports.md
 * @see ../references/templates/daily.md
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The periods this generator understands. */
export const PERIODS = Object.freeze(["daily", "weekly", "monthly"]);

/** The four report buckets, in reporting order. */
export const CATEGORIES = Object.freeze([
  "requirement",
  "development",
  "bug",
  "incident",
]);

/** Label namespaces the board convention reserves (see references/reports.md). */
export const LABEL_NAMESPACES = Object.freeze({
  CATEGORY: "category",
  AREA: "area",
  ENV: "env",
  SEV: "sev",
});

/** `category:` value → bucket. Anything else is uncategorized. */
const CATEGORY_TAG = Object.freeze({
  req: "requirement",
  dev: "development",
  bug: "bug",
});

/** Bucket → the plural key used in the summary's `counts`. */
const COUNT_KEY = Object.freeze({
  requirement: "requirements",
  development: "development",
  bug: "bugs",
  incident: "incidents",
});

/** A stable, human title per period. */
const PERIOD_TITLE = Object.freeze({
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
});

const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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
 * `labels` is the wire array of strings; naming is case-insensitive on both the
 * namespace and — for the caller's convenience — nothing else is normalised:
 * the value is returned as written (trimmed). The first match wins, so a card
 * that carries `category:bug` twice with different casing still resolves once.
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
 * Which of the four report buckets a card belongs to, or `null` for a card the
 * report does not count.
 *
 * Driven by the `category:` label: `req` → requirement, `dev` → development,
 * `bug` → bug (or **incident** when the card also carries `env:prod`). An
 * `epic` is a container, not a unit of delivered work, so it never counts;
 * neither does an uncategorized card.
 *
 * @param {object|null} task a wire-shaped task
 * @returns {"requirement"|"development"|"bug"|"incident"|null}
 */
export function classifyTask(task) {
  if (!task || typeof task !== "object") return null;
  if (task.kind === "epic") return null;

  const tag = (labelValue(task.labels, LABEL_NAMESPACES.CATEGORY) ?? "").toLowerCase();
  const bucket = CATEGORY_TAG[tag];
  if (!bucket) return null;

  if (bucket === "bug") {
    const env = (labelValue(task.labels, LABEL_NAMESPACES.ENV) ?? "").toLowerCase();
    if (env === "prod") return "incident";
  }
  return bucket;
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

/** The display name of a wire assignee, or `null`. */
function assigneeName(assignee) {
  if (assignee === null || assignee === undefined) return null;
  if (typeof assignee === "string") return assignee;
  return assignee.display_name ?? assignee.displayName ?? assignee.id ?? null;
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
 * Aggregate the cards completed inside one window.
 *
 * Only cards that pass `inWindow` and `classifyTask` are counted, so the four
 * counts always sum to `counts.total`, and an uncategorized card is invisible
 * to the report rather than quietly landing in a bucket.
 *
 * @param {object[]} tasks wire-shaped tasks (as returned by `issue list --json`)
 * @param {object} window a `resolveWindow(...)` result, optionally carrying
 *   `project` / `generatedAt`; an explicit `{start, end}` also works
 * @returns {object} the summary that `renderMarkdown` consumes
 * @throws {ReportError} `INVALID_WINDOW`
 */
export function aggregate(tasks, window) {
  const w = normalizeWindow(window);
  if (w === null) {
    throw new ReportError("INVALID_WINDOW", "window must carry a finite start earlier than its end");
  }

  const counts = { requirements: 0, development: 0, bugs: 0, incidents: 0, total: 0 };
  const items = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!inWindow(task, window)) continue;
    const category = classifyTask(task);
    if (category === null) continue;
    counts[COUNT_KEY[category]] += 1;
    counts.total += 1;
    items.push({
      identifier: task.identifier ?? null,
      title: String(task.title ?? ""),
      assignee: assigneeName(task.assignee),
      category,
      completedAt: task.status_changed_at ?? task.statusChangedAt ?? null,
    });
  }

  // Chronological, ties broken by identifier, so the same board always renders
  // the same report.
  items.sort(
    (a, b) =>
      String(a.completedAt).localeCompare(String(b.completedAt)) ||
      String(a.identifier).localeCompare(String(b.identifier)),
  );

  const startDate = window.startDate ?? isoDate(new Date(w.start));
  const endDate = window.endDate ?? isoDate(new Date(w.end - DAY_MS));

  return {
    period: window.period ?? null,
    project: window.project ?? null,
    generatedAt: window.generatedAt ?? new Date().toISOString(),
    window: {
      start: new Date(w.start).toISOString(),
      end: new Date(w.end).toISOString(),
      startDate,
      endDate,
    },
    counts,
    items,
  };
}

/** One markdown bullet per card, or a `_None._` placeholder. */
function sectionList(items) {
  if (items.length === 0) return "_None._";
  return items
    .map((item) => {
      const who = item.assignee ? ` (@${item.assignee})` : "";
      const when = item.completedAt ? ` — ${String(item.completedAt).slice(0, 10)}` : "";
      return `- ${item.identifier ?? "(no id)"} — ${item.title}${who}${when}`;
    })
    .join("\n");
}

/**
 * Render a summary as the Markdown report the templates describe.
 *
 * The section order and headings mirror `references/templates/*.md`; every
 * `{{placeholder}}` is filled here, so the output is paste-ready. The three
 * human-authored sections (decisions, risks, plan) are left as a `> TODO:` the
 * author fills in — the generator cannot invent them.
 *
 * @param {object} summary an `aggregate(...)` result
 * @returns {string}
 */
export function renderMarkdown(summary) {
  const s = summary ?? {};
  const counts = s.counts ?? {};
  const window = s.window ?? {};
  const period = PERIOD_TITLE[s.period] ? s.period : "daily";
  const title = PERIOD_TITLE[period];
  const project = s.project ?? "(all projects)";
  const items = Array.isArray(s.items) ? s.items : [];
  const of = (category) => items.filter((item) => item.category === category);

  const lines = [
    `# ${title} report — ${project}`,
    "",
    `- Period: ${window.startDate ?? "?"} → ${window.endDate ?? "?"}`,
    `- Project: ${project}`,
    `- Generated at: ${s.generatedAt ?? "?"}`,
    "",
    "## Overview",
    "",
    `- Total completed (categorized): ${counts.total ?? 0}`,
    `- Requirements handled: ${counts.requirements ?? 0}`,
    `- Development tasks completed: ${counts.development ?? 0}`,
    `- Bugs fixed: ${counts.bugs ?? 0}`,
    `- Production incidents: ${counts.incidents ?? 0}`,
    "",
    "## Requirements handled",
    "",
    sectionList(of("requirement")),
    "",
    "## Development tasks completed",
    "",
    sectionList(of("development")),
    "",
    "## Bugs fixed",
    "",
    sectionList(of("bug")),
    "",
    "## Production incidents",
    "",
    sectionList(of("incident")),
    "",
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
  ];

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
  --project <id>                  Restrict to one project.
  --limit <n>                     Max cards to read from the board (default: 1000).
  --json                          Print {ok,data:{summary}} instead of Markdown.
  -h, --help                      Show this help.

Exit codes: 0 ok · 1 runtime failure · 2 usage error.`;

/**
 * Parse the CLI flags. Supports `--k v` and `--k=v`.
 *
 * @param {string[]} argv
 * @returns {{period: string, date: string|undefined, project: string|undefined,
 *   limit: number, json: boolean, help: boolean}}
 * @throws {ReportError} `INVALID_LIMIT`
 */
function parseArgs(argv) {
  const opts = { period: "daily", date: undefined, project: undefined, limit: 1000, json: false, help: false };
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
  return code === "INVALID_PERIOD" || code === "INVALID_DATE" || code === "INVALID_LIMIT" || code === "UNKNOWN_ARGUMENT"
    ? 2
    : 1;
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
    const window = { ...resolveWindow(opts.period, opts.date), project: opts.project ?? null };
    const summary = aggregate(fetchTasks(opts), window);
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
