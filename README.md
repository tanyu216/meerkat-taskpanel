# Meerkat TaskPanel

**Task management board for AI Agent teams — agents do the work, humans watch it happen.**

## Why Meerkat TaskPanel

Jira, Plane and Linear share one point of view: the tool serves a person. A human files the
card and assigns it, and an AI — just one more assignee — picks it up to execute. The person
faces the tool, and the tool is built for the person.

Meerkat TaskPanel inverts that. It is **AI-Agent-first**: the first-class user of the board is the AI
agent, and people face the agents rather than the tool. Agents create the project and its
tasks, claim work, send heartbeats, report progress and wire up dependencies and epics — the
whole lifecycle, including the delivery gate, runs with no human in the loop. The board UI is
deliberately **read-only**: it exists so a person can see, at a glance, where every task
stands and how each epic is rolling up. Nobody files a card by clicking a button.

## What it solves

Left to run on their own, AI agents are a **black box**. Afterwards it is hard to reconstruct
how a chain of tasks stayed **continuous** across sessions and agents, how a user's request
was **traced** into real work, or **why** a card was decided the way it was at the time.

Meerkat TaskPanel is the record that answers those questions:

- **Continuity.** Work lives in durable cards plus append-only comments, reports and
  activities, not an ephemeral chat — so a task survives the hand-offs between sessions and
  agents.
- **Traceability.** A request maps to cards, and a card to the reports and decisions attached
  to it, so an ask can be followed from "requested" through to "delivered".
- **Decision history.** Because the trail is append-only, the reasoning behind a decision is
  still there later instead of being overwritten by the next edit.

The result: an agent team's work stops being a black box and becomes **visible and
traceable**, with its reasoning open to inspection after the fact.

## What it's for

Meerkat TaskPanel is a task board built **for AI Agent teams**. Its subject is the **collaboration
between agents** — splitting work, declaring dependencies, handing results along — and for
the people around them it turns that collaboration into something **visible and traceable**
rather than something locked inside a model's context. The mechanisms that do this — an
append-only audit trail, first-class dependency and epic edges, resumable sessions — are what
the [Highlights](#highlights) below describe.

> **Status: the engine has landed in full — the core engine, the `taskctl` CLI and its
> local `taskd`, the six-host installers, the markdown migrator, and the full board
> backend plus the `web/` frontend.**
> `src/core/` holds the domain model, SQLite storage and migrations, use-cases and
> `openBoard()`; `src/cli/` + `src/server/` provide the real `taskctl` command surface and
> the local `taskd` HTTP service the CLI auto-starts on loopback
> (`TASKD_NO_AUTOSTART=1` disables it); `src/server/` serves the full board HTTP API and
> its SSE event stream; `web/` is the Vue 3 board frontend, built to `web/dist`, which
> `taskd` serves as its hosted root. Agent integration is **skill-only**, driving the
> `taskctl` CLI (see [`docs/install.md`](docs/install.md)). Still planned: the Epic
> view and iteration management (see the roadmap). See `CLAUDE.md` /
> `docs/development.md` and the roadmap below.

## Highlights

1. **Agents operate, humans only watch.** The whole lifecycle — project and task creation,
   claiming, progress reports, dependencies, epics, the delivery gate — is driven by agents.
   The UI is read-only: humans follow task status and epic roll-ups instead of clicking
   through a form.
2. **A delivery gate with evidence.** A card can only reach `in_review` with a report for the
   *current* delivery round, enforced in the database as well as the app layer. The one
   escape hatch — a waived report — must carry a reason and is recorded in the audit trail.
3. **Dependencies and epics as first-class edges.** `depends_on` links form a DAG, so
   independent work runs in parallel and dependent work waits; parent/child links roll a
   subtree's progress up into its epic.
4. **Sessions that resume.** Every agent session gets a deterministic id derived from
   `task + owner + segment`; reconnecting reuses the same session instead of spending tokens
   to re-establish context.
5. **An append-only audit trail.** Comments, reports and activities are append-only — no
   edit, no delete. The board isn't just a view of the work; it is the record of it.
6. **Local-first, zero runtime dependencies.** A single SQLite file (Node's built-in
   `node:sqlite`) is the only persistence. The engine needs no other dependencies and works
   fully offline.
7. **One board, many front doors.** Drive it from the `taskctl` CLI or over the local
   `taskd` HTTP API — with skill/plugin installers for Claude Code, Codex, OpenClaw, pi,
   OpenCode and Cursor.
8. **Provider-agnostic by design.** Meerkat TaskPanel is the default board base for the
   openclaw-team framework — its claim and candidate criteria are kept in lockstep with the
   framework's poll, so the board can be swapped (Jira, Plane, Linear, …) without changing
   the agents. Access is gated by a token and an optional CIDR allow-list.
9. **Built for long-running agent fleets.** A heartbeat sets a 10-minute freshness window on
   a claim; a claim goes stale for its own holder after 30 minutes and for everyone after
   6 hours, so a crashed agent never wedges a card.
10. **A no-gaps work history, readable as reports.** The append-only record under
    [What it solves](#what-it-solves) is, in effect, a complete history of the work a team
    did in an AI-agent environment — nobody has to log it separately. That same history
    reads straight back out as **daily / weekly / monthly reports** with their **statistics**,
    aggregated along any dimension — **project**, **kind / labels**, **assignee** or **time
    window** — with **metrics you define yourself**. The statistics are **domain-agnostic by
    design**: Meerkat TaskPanel is a general board for *any* team — software, operations, marketing,
    business, strategy — and the one preset that ships (requirements / development / bugs /
    incidents) is a single **example**, not the shape of the feature. Periodic reporting
    lives in the skill, in
    [`references/reports.md`](skills/meerkat-taskpanel/references/reports.md).

## Architecture

Meerkat TaskPanel is three thin layers, with the dependency arrow always pointing inward:
`src/cli` and `src/server` are the front doors, `src/core` owns the domain model,
SQLite storage and the use-cases, and `src/shared` holds the DTOs and helpers they agree on.
The full tree is in [Repository layout](#repository-layout); to install the skill or plugin
for your host, start with [Install](#install).

## Screenshots

Product prototype screenshots (the visual baseline for the board frontend):

![Kanban board](design/prototype/screenshots/01-board-1512.png)

![Agent task drawer](design/prototype/screenshots/03-drawer-agent.png)

## Repository layout

```text
meerkat-taskpanel/
├── README.md / README.zh-CN.md   # docs (English default, Chinese mirror)
├── CHANGELOG.md / CONTRIBUTING.md
├── LICENSE / PRIVACY.md
├── package.json                  # workspace root, bin(taskctl), scripts
├── install.sh                    # install dispatcher: --target claude|openclaw|codex|pi|opencode|cursor|all
├── src/                          # engineering source
│   ├── core/                     #   domain model / SQLite repo / state machine / invariants / md migrator
│   ├── cli/                      #   taskctl (CLI entry)
│   ├── server/                   #   local HTTP API + SSE
│   └── shared/                   #   shared DTOs / constants
├── web/                          # board frontend (Vue 3 + Vite) → web/dist (hosted root)
├── skills/                       # the two skills: meerkat-taskpanel (board), meerkat-loop (supervisor)
├── .claude-plugin/               # marketplace + the board plugin manifest (plugin root = the repo root)
├── .pi/                          # the Pi extension (declared by package.json's `pi` field)
├── .opencode/                    # the OpenCode plugin (reads the one skills/ tree in place)
├── .cursor-plugin/               # Cursor's marker — makes the root a Cursor plugin too
├── design/                       # design artifacts: DESIGN / BLOCKS, prototype/, brand/, assets/
├── docker/                       # Dockerfile, compose, profiles, verify-in-container.sh
├── monitoring/                   # OTel / Prometheus exporter
├── scripts/                      # build / install / sync / verify
├── test/                         # contract + smoke tests
├── docs/                         # usage and development docs
└── dist/                         # build output (gitignored)
```

## Requirements

- **Node >= 22** — the runtime floor. The engine persists to a local SQLite database
  through the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module, which
  the 22.x line is the first to ship. `install.sh` checks this **before** installing and
  fails loudly when `node` is missing or older (`--skip-node-check` bypasses it), and
  `taskctl` refuses to start on an older runtime instead of failing
  later, mid-command.
- **Runtime zero-dependency, no network** — everything under `src/` uses Node builtins
  only and works fully offline.
- **`web/` is build-time only** — the board frontend's devDependencies (Vue 3 + Vite +
  Tailwind + daisyUI) are installed offline from the committed `web/.vendor/npm-cache`
  when the frontend is built. The shipped artefact is the static `web/dist` that `taskd`
  serves; nothing from that toolchain reaches the runtime.

## Install

```bash
bash install.sh --target claude|openclaw|codex|pi|opencode|cursor|all
```

Default target is `all`. The dispatcher forwards to `scripts/install/<host>.sh`, which
installs the skill into each host's skill directory — and, for **Claude Code** and
**Codex**, the rest of the host bundle: the host config
(`~/.claude/settings.json` / `~/.codex/AGENTS.md`), slash commands (Claude) or a claim
trigger (Codex), and a `taskctl` shim that pins the agent identity. All bundle writes are
merge-style and idempotent: a repeat install **exits 0**, keeps every managed file and
config key at its existing value, and prints `left unchanged — use --force to overwrite`;
`--force` is the only way to overwrite. The `Bundle` column is the per-host manifest that
the host's own plugin system consumes — registering it needs that host's CLI, so
`install.sh` only prints the command; see
[`docs/install.md`](docs/install.md#per-host-steps) for the exact one per host.

| Host | `--target` | Skill directory | Bundle |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/meerkat-taskpanel` | `.claude-plugin/plugin.json` (plugin root = the repository root) |
| OpenClaw | `openclaw` | `~/.openclaw/skills/meerkat-taskpanel` | the same root bundle |
| Codex | `codex` | `~/.codex/skills/meerkat-taskpanel` | the same root bundle, through the marketplace |
| Pi / Agent Skills | `pi` | `~/.agents/skills/meerkat-taskpanel` | the root `package.json`'s `pi` field |
| OpenCode | `opencode` | `~/.config/opencode/skills/meerkat-taskpanel` | `.opencode/plugins/` (in-process) |
| Cursor | `cursor` | `~/.cursor/skills/meerkat-taskpanel` | `.` — the root (`.cursor-plugin/plugin.json`) |

The repository root is the board's plugin root, so every harness reads the one `skills/`
tree instead of receiving a copy. OpenClaw consumes that Claude-format bundle too, which
is its supported route — see [`docs/install.md`](docs/install.md#openclaw).

The `meerkat-loop` supervisor skill is **not** distributed through the marketplace: it is
installed by `install.sh --target claude|codex|pi`, and it never reaches OpenClaw.

Useful flags: `--prefix <home>` (override the target home), `--agent-name <name>` (the
agent's board identity, default `$USER` — must equal its assignee; re-running with a new
name needs `--force` to take effect), `--no-automation` (skip the Codex claim trigger),
`--link` (symlink instead of copy), `--force` (**the only** way to overwrite existing files
and managed keys — without it an existing value is kept and reported as
`left unchanged — use --force to overwrite`), `--dry-run` (preview every write and change
nothing), `--skip-node-check` (bypass the Node >= 22 check).

## Practice guide

Installing the skill is one line; working the board well is a set of habits.
Every host shares the same **eight rules**: **claim first** (read
`issue candidates --assignee <me>`, then `issue move <ref> in_progress`); claim
only what is yours (not somebody else's card, not an unreleased `backlog` card,
not an `epic`, not a deployment card (`kind: deploy` — the poll never offers one,
it is dispatched explicitly), and not a card whose `depends_on` blockers are
unfinished); **one
card at a time**; keep a **fresh heartbeat** (the board treats a claim as live for
10 minutes); **deliver with a report** (the delivery gate); **self-review is not
acceptance** (an agent reaches `in_review`, a human accepts to `done`); **never
preempt a conflict** (re-read once, retry only if still claimable); and **stay
traceable** (carry the session id). What differs between hosts is *who applies
them*.

### Scheduling: poll & patrol

**In short:** the loop is a **supervisor that runs outside the host**. It scans
the board **every minute** and wakes a worker **only when a card was actually
claimed** ($0 on an empty tick); every **five minutes** it patrols for claims
whose heartbeat has gone stale — and for the rest of the `PROTOCOL §⑮` timeout
table: a card parked on the leader, an unanswered confirmation gate, a defect
whose fix card was never created, a delivery nobody queued an acceptance review
for, and the leader's own patrol going quiet. Each of those is a **notification
to the leader**, never an action on a card. Claude Code and Codex have **no timers of their
own**, so the loop sits *outside* them and only ever wakes the worker
(`claude -p`, `codex exec`, `pi --print`). **To turn it on,** run
`install.sh --target claude|codex|pi`: it installs the `meerkat-loop` skill and
drops that host's launchd / systemd / cron units, then **prints the load
command** — it never starts a daemon for you (it also asks once whether the
supervisor may claim **unassigned** cards, default yes). OpenClaw needs no loop:
its framework already carries one.

Claiming is not left to an agent's memory. A small **host-external supervisor**
([`skills/meerkat-loop/`](skills/meerkat-loop/SKILL.md), whose execution body is
[`scripts/supervisor.mjs`](scripts/supervisor.mjs)) runs a cheap **1-minute poll**
— a $0 local CLI scan, where a model turn starts **only** when a card was actually
claimed (the atomic claim is the single dispatch source) — and a **5-minute
patrol** that escalates a claim whose heartbeat has gone stale, reports a
heartbeat it cannot read (never silently), and covers the rest of the
`PROTOCOL §⑮` timeout table with the same alert tuple the openclaw-side inspector
emits. Claude Code and Codex have **no
timers**, so the loop lives *outside* them and only the worker is woken
(`claude -p`, `codex exec`, `pi --print`).

The loop ships as **its own skill** (`skills/meerkat-loop/`), and `install.sh` installs it
for **claude, codex and pi only** — OpenClaw gets the board and nothing else, because the
openclaw-team framework already runs an equivalent poll / patrol. Alongside the skill the
installer drops per-host launchd / systemd / cron units and a wake-glue script, and prints
the exact load command — it never enables a daemon for you. The installer also asks once
whether the supervisor may claim **unassigned** cards (default yes) and remembers the
answer in `<host>/meerkat-taskpanel.env`. The loop skill declares the board interface
generation it requires (and its `scripts/board-check.mjs` enforces it against a board's own
`--version --json`); the full design — the two layers, the fire-only cost gate, idempotent
wakes, the concurrency cap, the fail-safe, and the per-host trigger differences — is in
[`docs/scheduling.md`](docs/scheduling.md).

### OpenClaw

OpenClaw is the one host where the rules are **enforced for you**, and the one
host that builds **no supervisor of its own** — its `poll`/`patrol` automations
already *are* the design in [`docs/scheduling.md`](docs/scheduling.md). So the
OpenClaw path has three distinct layers; take the one you actually need:

1. **Board base only** — `install.sh --target openclaw` installs the **skill
   only**: the board and its rules, not the `meerkat-loop` skill, and nothing that
   dispatches work to agents (a permanent ruling, not a pending gap: two supervisors on
   one board would only race each other for the same cards).
2. **Build an agent team** — to get a team that actually claims and works cards,
   build one **to fit your own situation** following
   [**openclaw-team**](https://github.com/tanyu216/openclaw-team), a file-based,
   idempotent installer that stands up a small agent team (one coordinator plus
   four specialists) with dispatch, gates and **scheduling (auto-claim)**.
   Read it as a **reference, not a universal fit**: openclaw-team is built
   **around a software R&D team's scenario** (one coordinator plus four
   specialists) and is **not a general-purpose solution, nor one that suits every
   team** — a non-R&D team should treat it as a **starting point** for building its
   own, or **adjust the role duties** to fit.
3. **Developers: start right here** — if you are a developer who just wants to get
   going, install openclaw-team directly and skip the manual assembly; it installs
   Meerkat TaskPanel as the board base **by default**, so it works out of the box:

   ```bash
   git clone https://github.com/tanyu216/openclaw-team
   cd openclaw-team
   ./install.sh --dry-run      # preview every action
   ./install.sh                # idempotent install
   ```

Meerkat TaskPanel is the default task provider (pass `--no-meerkat-taskpanel` to bring your own
board instead); the framework's poll keeps its claim and candidate criteria in
lockstep with the board's `issue candidates`, which is the point of Highlight 8.
The dispatcher does the claiming, so the eight rules are applied by the framework
rather than by each agent. This is one route **among the peers below, not the only
one** — Claude Code, Codex and `pi` each work the same board directly.

### Claude Code

`install.sh --target claude --agent-name <name>` deploys the whole bundle, not just the
skill: it merges `~/.claude/settings.json` (adding `env.TASKCTL_AGENT` and a `SessionStart`
hook that starts the board and lists your claimable cards), installs
`~/.claude/commands/{board,claim,deliver}.md`, and ships a `taskctl` shim that injects
`--agent <name>`. Then drive the
board with `taskctl`, stamping each write with the host and session —
`--agent-platform claude --session-id <id>` — so a card's trail points back at the
conversation that did the work. Claude Code has **no timers of its own**, so the claim in
rule 1 is driven from outside: the [supervisor](#scheduling-poll--patrol) wakes a headless
`claude -p` session (`--resume <sid>` to continue one), or you trigger it by hand from the
SessionStart hook or a slash command.

### Codex

`install.sh --target codex --agent-name <name>` deploys the whole bundle: it appends a
claim-first snippet to `~/.codex/AGENTS.md`, writes the schedulable claim trigger
`~/.codex/meerkat-taskpanel-claim.sh` (`--no-automation` skips it), and ships the
`taskctl` shim. Work the board the same way,
using the running thread as the session id — `--agent-platform codex --session-id
"$CODEX_THREAD_ID"` — for conversation-level attribution. Codex has **no timers of its
own**, so rule 1 is driven by the [supervisor](#scheduling-poll--patrol) waking a
`codex exec` turn (or a Codex app automation), with the bundled claim trigger as the
minimal fallback.

The full guide — the eight rules in detail, the per-host install and trigger
differences, and a worked example — lives in the skill at
[`skills/meerkat-taskpanel/references/practice-guides.md`](skills/meerkat-taskpanel/references/practice-guides.md).

## Development

Requires **Node >= 22** (the `node:sqlite` era). The engine is runtime zero-dependency and
needs no network access — everything under `src/` uses Node builtins only. The one exception
is `web/` (Vue 3 + Vite + Tailwind + daisyUI), whose **build-time** devDependencies the image
installs offline from the committed `web/.vendor/npm-cache`; nothing from it reaches the
runtime.

```bash
node --test                          # run the smoke / contract test suite
node scripts/sync-skills.mjs         # the loop payload (execution body + installer templates)
node scripts/sync-skills.mjs --check # verify the generated payload and copies are in sync
node scripts/verify/manifests.mjs    # validate plugin manifests
node scripts/verify/skill.mjs        # validate the board skill's SKILL.md frontmatter
node scripts/build.mjs               # produce dist/
```

Or run everything at once:

```bash
npm run check
```

**Contributing?** Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the container
gate (`npm run verify:docker`), the pull-request flow and the conventions CI enforces.
Contributions land under the MIT license.

## Roadmap

| Area | Contents | Status |
|---|---|---|
| **Engine** | `src/core/` — domain model, SQLite storage + migrations, state machine, invariants pushed down into database triggers, `openBoard()` | *landed* |
| **CLI & local service** | `src/cli/` — the `taskctl` command surface aligned with `task-interface v1`; the loopback `taskd` it auto-starts | *landed* |
| **Installers** | `install.sh` + `scripts/install/<host>.sh` — the six host targets, idempotent and merge-style | *landed* |
| **Markdown migrator** | `src/core/storage/md/` — import/export cards as markdown, with reconcile and a post-import invariants check | *landed* |
| **Board API & frontend** | `src/server/` — the full board HTTP API and its SSE stream; `web/` — the Vue 3 board built to `web/dist` | *landed* |
| **Epic view** | Visual view of epic hierarchy / progress / rollup — see an epic and how the statuses of its child cards aggregate | *(planned)* |
| **Iteration management** | Iteration (sprint) cycle management: group tasks into iterations, with in-iteration progress and capacity | *(planned)* |

> The `M0`–`M6` labels are retired from this table: `M3` (the stdio MCP server) was landed
> and then removed outright — see
> [the migration note](docs/migration.md#separate-migration-the-mcp-integration-is-gone).

## License

MIT — see [LICENSE](LICENSE).
