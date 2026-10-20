# Periodic reports & statistics

> **Scope.** Daily / weekly / monthly reports over the board, and the numbers behind them.
> This is the *period* report — a roll-up of the cards a team finished in a window. It is
> **not** the per-task delivery report the delivery gate asks for; that one is `cli.md`
> §`report`.

The whole capability lives in this one file — report spec, counting rules, metric presets
and templates — because a periodic report is something this skill *does*, not a separate
skill.

It is deliberately **domain-agnostic**. Meerkat TaskPanel is a general task board for any
team — software, operations, marketing, business, strategy — and so is this report. Nothing
below assumes the cards describe software. The one shipped preset (`software`) is an
**example** of a configuration, not the shape of the feature: metrics are named and grouped
by *you*, through a grouping dimension plus `namespace:value` label filters; their
definitions live in §Measurement rules › Metrics and presets.

## Report spec

### Section structure

Every periodic report has the same five sections:

| Section | Written by | Content |
|---|---|---|
| **Overview** | generator | The window, and the total number of cards completed in it. |
| **Core metrics (configurable)** | generator | The breakdown: counts per grouping-dimension value, or the named metrics of the applied preset. |
| **Key decisions & milestones** | you | The generator cannot invent these; it leaves a `TODO`. |
| **Risks & blockers** | you | Same — a `TODO` the author replaces. |
| **Next period plan** | you | Same — a `TODO` the author replaces. |

**Metric names and groups are configuration, not constants.** The shipped example calls its
rows *Requirements handled*, *Development tasks completed*, *Bugs fixed* and *Production
incidents*; another team's report calls them whatever its work is called. The generator never
hard-codes a metric name: labels are the metric definitions of §Measurement rules › Metrics
and presets, and with no preset the rows are simply the grouping-dimension values.

### Placeholders

The templates in §Templates are filled from these placeholders; `scripts/report.mjs` fills
every one, so its Markdown output and a hand-filled template have the same shape.

| Placeholder | Meaning |
|---|---|
| `{{period_label}}` | `Daily` / `Weekly` / `Monthly` |
| `{{project}}` | The project, or `(all projects)` |
| `{{period_start}}` | First day *included* in the window (`YYYY-MM-DD`, UTC) |
| `{{period_end}}` | Last day *included* in the window — **weekly and monthly only**; a single-day window has no separate end day, so the daily template omits it |
| `{{group_by}}` | The grouping dimension in use (`kind`, `label:category`, …) |
| `{{preset}}` | The applied preset name, when there is one |
| `{{assignee}}` | The assignee filter, when there is one |
| `{{generated_at}}` | When the report was produced (ISO 8601, UTC) |
| `{{total}}` | Cards counted in the window |
| `{{core_metrics}}` | Core-metrics rows — one per metric label (preset) or per grouping value (no preset) |
| `{{completed_cards}}` | One bullet per counted card, labelled by its group or metric |

## Measurement rules

### Data source

Everything comes from one existing read, `taskctl issue list --json` — this capability adds
**no** new backend query. The generator calls it through the skill's own wrapper (see `cli.md`
§Starting the board), always with `--include-archived`:

```bash
node scripts/run.mjs issue list --json --limit 1000 --include-archived [--project <id>]
```

`--include-archived` matters: a card is archivable 7 days after it becomes terminal, so a
monthly report that skipped the archive would silently drop work finished earlier in the
month.

### Completion window

A card counts as **completed in the window** when **both** hold:

1. `status === "done"`, and
2. `status_changed_at` falls inside the window.

`status_changed_at` carries the moment the card last entered its current status — for a `done`
card, its completion time. It is a stored timestamp, **not** a computed one: a reopened and
re-closed card carries the *latest* close (the honest answer to "when did this finish?"), and
a `done` card with no usable timestamp never counts.

The window is **half-open**: `start` included, `end` excluded, so adjacent windows tile
without double-counting a card completed exactly at midnight.

**Time zone.** All window arithmetic is in **UTC**: a UTC day, a UTC ISO week (Monday 00:00 →
next Monday 00:00) or a UTC calendar month. Local-time windows would shift by an hour across
a DST boundary and could swallow or duplicate a card; UTC keeps a report reproducible
wherever it is read. A card completed at `2026-10-31T23:30:00Z` belongs to **October**, and
one at `2026-11-01T00:30:00Z` to **November** — the reader's time zone does not move the
boundary.

`resolveWindow(period, date)` takes any day inside the window and returns the window
containing it, so `--date` may be any day of the week or month.

### Grouping dimension

A card's bucket comes from exactly one **grouping dimension**, chosen with `--group-by`:

| `--group-by` | Bucket key | Missing value |
|---|---|---|
| `kind` *(default)* | the card's `kind` (`task`, `epic`, `deploy`) | not counted |
| `project` | `project_id` | not counted |
| `assignee` | the assignee's `display_name` (falling back to its `id`) | not counted |
| `status` | the card's `status` | not counted |
| `label:<namespace>` | the value of the first `<namespace>:` label | not counted |

`label:<namespace>` is general, not limited to the reserved namespaces — `label:category`,
`label:area`, `label:env`, `label:sev` all work, as does any namespace a team invents. The
reserved set is:

| Namespace | Meaning | Example |
|---|---|---|
| `category:` | What kind of work the card is | `category:req` |
| `area:` | The part of the product it touches | `area:cli` |
| `env:` | Where it happened (`prod` marks production) | `env:prod` |
| `sev:` | Severity, for incidents and bugs | `sev:P1` |

Namespaces are matched **case-insensitively** and in full — `categoryx:req` does *not* match
`category:`. Buckets are lower-cased, so `Category:Req` and `category:req` are one bucket; a
report never splits on spelling. A card with no value for the chosen dimension is
**uncategorized**: not counted, rather than quietly folded into a bucket. The per-card list
still prints the assignee's own spelling.

### Metrics and presets

A **metric** is a named count built from two things:

1. a **grouping dimension** (which value the card is bucketed under), and
2. a set of **`namespace:value` filters** — clauses that must hold (`where`) and clauses
   that must not (`without`).

That is the whole vocabulary; nothing in it mentions software, so any team defines its own
metrics without touching code (§Measurement rules › Custom metrics).

A **preset** bundles a default grouping dimension, a set of excluded `kind`s, and a list of
named metrics into one name passed as `--preset <name>`. This keeps the shipped example from
being a special case: a preset is *data*, and the generator treats every preset identically.

#### Example preset: `software` (development)

The **one example preset** that ships today — a software team's reading of a generic board,
useful as a worked example, not privileged:

| Metric | Filter |
|---|---|
| Requirements handled | `category:req` |
| Development tasks completed | `category:dev` |
| Bugs fixed | `category:bug` **and not** `env:prod` |
| Production incidents | `category:bug` **and** `env:prod` |

- **Grouping:** `label:category`.
- **`env:prod` splits the bugs:** the same label means "a bug we fixed" in dev and "a
  production incident" in prod, so `category:bug` alone would conflate two different things.
- **Epics are excluded.** An epic is a container, not delivered work, so it never counts even
  with a `category:` label; its children show up in the report.
- The four metrics are mutually exclusive — the `env:prod` split keeps *bugs* and *incidents*
  apart — and together cover every counted card whose `category:` is `req`, `dev` or `bug`.
  A card with another `category:` value is counted in `counts` under that value but matches
  none of the four metrics.

```bash
node scripts/report.mjs --period monthly --preset software
```

`--preset software` implies `--group-by label:category`; pass `--group-by` explicitly to
override the dimension while keeping the metrics.

#### Custom metrics (operations / marketing / business / …)

**The statistics are not only for developers.** A report over marketing campaigns, operations
tickets or business requests is the same computation with different words. Two ways there:

1. **No preset — just choose a dimension.** `--group-by kind` counts by card kind and is the
   domain-free default; `--group-by label:area` counts by whatever `area:` values the team
   uses; `--group-by assignee` counts throughput per person. For many teams this is the whole
   requirement, with no configuration.
2. **A preset of your own — name the metrics.** Write a preset with the grouping dimension
   and label filters that describe your work, e.g. for operations: `label:category` grouped,
   with `category:incident` → *Incidents handled*, `category:request` → *Requests fulfilled*,
   `category:change` → *Changes deployed*. Nothing about that list is software-shaped, and
   adding it is a data change, not a code change.

To add a preset, add an entry to `PRESETS` in `skills/meerkat-taskpanel/scripts/report.mjs` —
the same shape as `software`: `name`, `title`, `groupBy`, `excludeKinds`, and `metrics`
(each with `key`, `label`, `where`, and optionally `without`). Until then, `--group-by` plus
the reserved or team-defined namespaces cover the configurable cases.

### Counting rules

- A card must be `done` **and** completed inside the window (§Completion window).
- It must carry a value for the grouping dimension; uncategorized cards are not counted.
- If a preset is applied, its `excludeKinds` are dropped (for `software`, epics).
- **A card is counted once** — `total` is the number of counted cards. Metric counts come
  from filters, which *may* overlap, so they need not sum to `total`; `counts` (the
  grouping-dimension map) always does, since buckets are disjoint.
- Ordering is stable: completion time, then identifier.

## Mapping to taskctl queries

| Need | Command |
|---|---|
| Raw cards (the data source) | `taskctl issue list --json [--project <id>] [--limit <n>] [--include-archived]` — `cli.md` §`issue` |
| One card's **delivery** report | `taskctl report template <id>` — `cli.md` §`report` |
| The period report | `node scripts/report.mjs …` (below) |

Do not confuse the last two. `report template` prints the acceptance/evidence report a single
card needs to pass the delivery gate (`cli.md` §The delivery gate); the periodic report is a
read-only aggregate of many cards and involves no gate.

### Reproducible commands

Run from this skill's directory:

```bash
# Today's daily report, grouped by card kind — the domain-free default.
node scripts/report.mjs --period daily

# A specific week, grouped by an arbitrary label namespace, machine-readable.
node scripts/report.mjs --period weekly --date 2026-10-07 --group-by label:area --json

# One project's month, with the software example preset applied.
node scripts/report.mjs --period monthly --date 2026-10-09 --project demo --preset software

# One assignee's week, grouped by project.
node scripts/report.mjs --period weekly --assignee linus --group-by project
```

Options: `--period daily|weekly|monthly` (default `daily`), `--date YYYY-MM-DD` (any day
inside the window; default today, UTC), `--project <id>` (board-side filter),
`--assignee <name>` (local filter, by display name or id),
`--group-by kind|project|assignee|status|label:<ns>`, `--preset <name>`, `--limit <n>`
(default `1000`), `--json`, `-h`.

Markdown is the default output and matches the templates' structure (§Templates) with every
placeholder filled. `--json` prints `{"ok":true,"data":{"summary":…}}`, whose `summary`
carries `counts`, `metrics` (or `null`), `total`, the resolved `window`, and the
completed-card list (`identifier`, `title`, `assignee`, `group`, `metric`, `completedAt`).

**Failures.** The process writes a clear message to stderr and exits non-zero — `2` for a
usage problem, `1` for a runtime one. Bind to **`error.code`**, never the prose:
`INVALID_PERIOD`, `INVALID_DATE`, `INVALID_LIMIT`, `INVALID_GROUP_BY`, `INVALID_PRESET`,
`DATA_SOURCE_FAILED`, and the board's own codes passed through unchanged. With `--json`, the
same failure is printed as `{"ok":false,"error":{"code":…,"message":…}}`.

## Templates

Three templates sharing the five sections of §Report spec › Section structure, differing only
in window wording: **daily** is one UTC day, **weekly** one ISO week (Monday–Sunday),
**monthly** one calendar month. The generator prints the same shape; these are the
hand-fillable equivalents, and a hand-filling author replaces only the `TODO:` lines in the
last three sections.

### Daily report — daily (one UTC day)

````markdown
# {{period_label}} report — {{project}}

> One **day**. Every number below covers a single UTC day, {{period_start}}
> (00:00–24:00 UTC), and every listed card was completed *within that day* —
> cards completed yesterday are yesterday's news, not today's.

- Period: {{period_start}} (one UTC day)
- Project: {{project}}
- Grouped by: {{group_by}}
- Output language: chosen to follow the current user's language habit.
- Generated at: {{generated_at}}

## Overview

- Total completed: {{total}}

_Write one or two sentences on how the day went: was the throughput normal, and
was anything started or finished that the counts above do not capture?_

## Core metrics

{{core_metrics}}

### Completed cards

{{completed_cards}}

## Key decisions & milestones

- TODO: the decisions taken today, and the milestones reached.

## Risks & blockers

- TODO: what is slowing the team down right now.

## Next period plan

- TODO: what tomorrow's report should be able to claim as done.
````

### Weekly report — weekly (one ISO week, starting Monday)

````markdown
# {{period_label}} report — {{project}}

> One **week**. Every number below covers the ISO week {{period_start}} →
> {{period_end}} (Monday through Sunday, UTC), aggregated from the daily
> picture — the window is the week, not any single day inside it.

- Period: {{period_start}} → {{period_end}} (one ISO week, Monday–Sunday)
- Project: {{project}}
- Grouped by: {{group_by}}
- Output language: chosen to follow the current user's language habit.
- Generated at: {{generated_at}}

## Overview

- Total completed: {{total}}

_Write one or two sentences on the week's shape: was the throughput front-loaded
or back-loaded, and does the total match what the team expected on Monday?_

## Core metrics

{{core_metrics}}

### Completed cards

{{completed_cards}}

## Key decisions & milestones

- TODO: the decisions taken this week, and the milestones reached.

## Risks & blockers

- TODO: the risks carried into next week, and who owns each.

## Next period plan

- TODO: the outcomes next week's report should be able to claim as done.
````

### Monthly report — monthly (one calendar month)

````markdown
# {{period_label}} report — {{project}}

> One **calendar month**. Every number below covers {{period_start}} →
> {{period_end}} (the whole month, UTC), rolled up from the weekly reports —
> the window is the month, and it includes work that was archived after
> completion.

- Period: {{period_start}} → {{period_end}} (one calendar month)
- Project: {{project}}
- Grouped by: {{group_by}}
- Output language: chosen to follow the current user's language habit.
- Generated at: {{generated_at}}

## Overview

- Total completed: {{total}}

_Write one or two sentences on the month: the trend against the previous month,
and whether the mix of work is the one the team planned._

## Core metrics

{{core_metrics}}

### Completed cards

{{completed_cards}}

## Key decisions & milestones

- TODO: the decisions taken this month, and the milestones reached.

## Risks & blockers

- TODO: the risks carried into next month, and the plan for each.

## Next period plan

- TODO: the outcomes next month's report should be able to claim as done.
````

When a preset is applied, `{{core_metrics}}` is one row per metric label
(`- Requirements handled: 3`); with no preset it is one row per grouping value
(`` - `task`: 9 ``), so the section follows the configuration rather than a fixed list.

When a preset or an assignee filter is in force, the generator adds a matching
`- Preset: …` / `- Assignee: …` line to the header block; the templates above show the
common unfiltered case, so they stay template-shaped.

The `- Output language:` line is the exception: it stands in **every** header block, filtered
or not, and states the rule the author follows — **the report output language is chosen to
follow the current user's language habit.** The generator emits this English skeleton
verbatim and translates nothing: the line tells the author to write *their* prose, and the
`TODO:` sections, in the language the reader habitually uses.
