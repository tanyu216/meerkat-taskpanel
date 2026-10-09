# Periodic reports & statistics

> **What this covers.** Daily / weekly / monthly reports over the board, and the
> numbers that back them. This is the *period* report — a roll-up of the cards a
> team finished in a window. It is **not** the per-task delivery report the
> delivery gate asks for; that one is 《cli.md》§`report`.

The whole capability is two pieces:

| Piece | Path | Role |
|---|---|---|
| Templates | [`templates/daily.md`](templates/daily.md), [`templates/weekly.md`](templates/weekly.md), [`templates/monthly.md`](templates/monthly.md) | The shape of the report, with `{{placeholder}}`s to fill. |
| Generator | [`../scripts/report.mjs`](../scripts/report.mjs) | Reads the board, aggregates, and prints the filled report. |

## 统计口径

### 数据源

Everything comes from one existing read, `taskctl issue list --json` — this
capability adds **no** new backend query. The generator calls it through the
skill's own wrapper (see 《cli.md》§Starting the board), always with
`--include-archived`:

```bash
node scripts/run.mjs issue list --json --limit 1000 --include-archived [--project <id>]
```

`--include-archived` matters: a card is archivable 7 days after it becomes
terminal, so a monthly report that skipped the archive would silently drop work
the team finished earlier in the month.

### 完成时间窗

A card counts as **completed in the window** when **both** hold:

1. `status === "done"`, and
2. `status_changed_at` falls inside the window.

`status_changed_at` is the wire field carrying the moment the card last entered
its current status — for a `done` card, its completion time. It is a stored
timestamp, **not** a computed one: a card that was reopened and re-closed
carries the *latest* close, which is the honest answer to "when did this
finish?", and a card that is `done` but carries no usable timestamp never counts.

The window is **half-open**: `start` is included, `end` is excluded. That is
what lets adjacent windows tile without double-counting a card completed exactly
at midnight.

**Time zone.** All window arithmetic is in **UTC**. A window is a UTC day, a UTC
ISO week (Monday 00:00 → next Monday 00:00) or a UTC calendar month. Local-time
windows would shift by an hour across a DST boundary and could swallow or
duplicate a card; UTC keeps a report reproducible no matter which machine reads
the board. Concretely, a card completed at `2026-10-31T23:30:00Z` belongs to
**October**, and one at `2026-11-01T00:30:00Z` belongs to **November** — the
reader's own time zone does not move the boundary.

`resolveWindow(period, date)` takes any day inside the window and returns the
window that contains it, so `--date` may be any day of the week or month.

### 分类口径

A card's bucket comes from its **labels**, using the reserved namespaces below;
`kind` participates only to **exclude** an epic.

| Namespace | Meaning | Example |
|---|---|---|
| `category:` | What kind of work the card is (`req` / `dev` / `bug`) | `category:req` |
| `area:` | The part of the product it touches | `area:cli` |
| `env:` | Where it happened (`prod` marks production) | `env:prod` |
| `sev:` | Severity, for incidents and bugs | `sev:P1` |

Names are matched case-insensitively on both the namespace and `category` value,
so `Category:Req` and `category:req` are the same card. A label that merely
shares a prefix with a namespace — `categoryx:req` — does **not** match. A card
with no `category:` label is **uncategorized**: it is counted in no bucket, not
silently folded into one.

An **epic** is a container for other cards, not a unit of delivered work, so it
is never counted even when it carries a `category:` label; its children are what
show up in the report.

### 统计维度 → 映射

The `Overview` counts map onto labels like this:

| Report metric | Rule |
|---|---|
| Requirements handled (`count_requirements`) | `category:req` |
| Development tasks completed (`count_dev`) | `category:dev` |
| Bugs fixed (`count_bugs`) | `category:bug` **and not** `env:prod` |
| Production incidents (`count_incidents`) | `category:bug` **and** `env:prod` |
| Total completed (`count_total`) | The four above, summed |

The four buckets are mutually exclusive and exhaustive over *counted* cards, so
`count_total` is exactly their sum. `category:bug` splits on `env:prod`: the same
label means "a bug we fixed" in a dev environment and "a production incident"
when it happened in prod.

## 与 taskctl 查询的对应

| Need | Command |
|---|---|
| Raw cards (the data source) | `taskctl issue list --json [--project <id>] [--limit <n>] [--include-archived]` — 《cli.md》§`issue` |
| One card's **delivery** report | `taskctl report template <id>` — 《cli.md》§`report` |
| The period report | `node scripts/report.mjs …` (below) |

Do not confuse the last two. `report template` prints the acceptance/evidence
report a single card needs to pass the delivery gate (《cli.md》§The delivery
gate); the periodic report is a read-only aggregate of many cards and involves
no gate.

### 可复现命令

Run from this skill's directory:

```bash
# Today's daily report, as Markdown
node scripts/report.mjs --period daily

# A specific week, machine-readable
node scripts/report.mjs --period weekly --date 2026-10-07 --json

# One project's month
node scripts/report.mjs --period monthly --date 2026-10-09 --project demo
```

Options: `--period daily|weekly|monthly` (default `daily`), `--date YYYY-MM-DD`
(any day inside the window; default today, UTC), `--project <id>`, `--limit <n>`
(default `1000`), `--json`, `-h`.

Markdown is the default output and matches the templates' structure with every
placeholder filled. `--json` prints `{"ok":true,"data":{"summary":…}}`, whose
`summary` carries `counts`, the resolved `window`, and the completed-card list
(`identifier`, `title`, `assignee`, `category`, `completedAt`).

**Failures.** The process writes a clear message to stderr and exits non-zero —
`2` for a usage problem, `1` for a runtime one. Bind to the **`error.code`**,
never the prose: `INVALID_PERIOD`, `INVALID_DATE`, `INVALID_LIMIT`,
`DATA_SOURCE_FAILED`, and the board's own codes passed through unchanged. With
`--json`, the same failure is printed as
`{"ok":false,"error":{"code":…,"message":…}}`.

## Templates

Three templates ship under [`templates/`](templates/): `daily.md` (one UTC day),
`weekly.md` (one ISO week), `monthly.md` (one calendar month). They share the
same eight sections — Overview, Requirements handled, Development tasks
completed, Bugs fixed, Production incidents, Key decisions & milestones, Risks &
blockers, Next period plan — and differ only in window wording and granularity
(the day, the week, the month). Each ships with the `{{placeholder}}`s the
generator knows how to fill; an agent filling one by hand only has to replace
the `TODO:` lines in the last three sections.
