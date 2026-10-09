# Task Panel

**Task management board for AI Agent teams — agents do the work, humans watch it happen.**

## Why Task Panel

Jira, Plane and Linear share one point of view: the tool serves a person. A human files the
card and assigns it, and an AI — just one more assignee — picks it up to execute. The person
faces the tool, and the tool is built for the person.

Task Panel inverts that. It is **AI-Agent-first**: the first-class user of the board is the AI
agent, and people face the agents rather than the tool. Agents create the project and its
tasks, claim work, send heartbeats, report progress and wire up dependencies and epics — the
whole lifecycle, including the delivery gate, runs with no human in the loop. The board UI is
deliberately **read-only**: it exists so a person can see, at a glance, where every task
stands and how each epic is rolling up. Nobody files a card by clicking a button.

## What it solves

Left to run on their own, AI agents are a **black box**. Afterwards it is hard to reconstruct
how a chain of tasks stayed **continuous** across sessions and agents, how a user's request
was **traced** into real work, or **why** a card was decided the way it was at the time.

Task Panel is the record that answers those questions:

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

Task Panel is a task board built **for AI Agent teams**. Its subject is the **collaboration
between agents** — splitting work, declaring dependencies, handing results along — and for
the people around them it turns that collaboration into something **visible and traceable**
rather than something locked inside a model's context. The mechanisms that do this — an
append-only audit trail, first-class dependency and epic edges, resumable sessions — are what
the [Highlights](#highlights) below describe.

> **Status: the engine has landed through M6 — core (M1), CLI (M2), the stdio MCP server
> (M3), and the full board backend plus the `web/` frontend (M6).**
> `src/core/` holds the domain model, SQLite storage and migrations, use-cases and
> `openBoard()`; `src/cli/` + `src/server/` provide the real `taskctl` command surface and
> the local `taskd` HTTP service the CLI auto-starts on loopback
> (`TASKD_NO_AUTOSTART=1` disables it); `src/mcp/` is a stdio MCP server exposing 18 tools as
> a thin, gate-equivalent proxy to `taskd`; `src/server/` serves the full board HTTP API and
> its SSE event stream; `web/` is the Vue 3 board frontend, built to `web/dist`, which
> `taskd` serves as its hosted root. Still planned: the Epic view and iteration management
> (see the roadmap). See `CLAUDE.md` / `docs/development.md`, `src/mcp/README.md`, and the
> roadmap below.

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
7. **One board, many front doors.** Drive it from the `taskctl` CLI, from a stdio MCP server
   (18 tools) for MCP-speaking hosts, or over the local `taskd` HTTP API — with skill/plugin
   installers for Claude Code, Codex, OpenClaw and pi. The MCP surface is gate-equivalent:
   `task_deliver` is the only tool that can reach `in_review`.
8. **Provider-agnostic by design.** Task Panel is the default board base for the
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
    design**: Task Panel is a general board for *any* team — software, operations, marketing,
    business, strategy — and the one preset that ships (requirements / development / bugs /
    incidents) is a single **example**, not the shape of the feature. Periodic reporting
    lives in the skill, in
    [`references/reports.md`](skills/task-panel/references/reports.md).

## Architecture

Task Panel is three thin layers, with the dependency arrow always pointing inward:
`src/cli`, `src/mcp` and `src/server` are the front doors, `src/core` owns the domain model,
SQLite storage and the use-cases, and `src/shared` holds the DTOs and helpers they agree on.
The full tree is in [Repository layout](#repository-layout); to install the skill or plugin
for your host, start with [Install](#install).

## Screenshots

Product prototype screenshots (the visual baseline for the board frontend):

![Kanban board](prototype/screenshots/01-board-1512.png)

![Agent task drawer](prototype/screenshots/03-drawer-agent.png)

## Repository layout

```text
task-panel/
├── README.md / README.zh-CN.md   # docs (English default, Chinese mirror)
├── LICENSE / PRIVACY.md
├── package.json                  # workspace root, bin(taskctl), scripts
├── install.sh                    # install dispatcher: --target claude|openclaw|codex|pi|all
├── .claude-plugin/               # Claude marketplace manifest
├── src/                          # engineering source
│   ├── core/                     #   domain model / SQLite repo / state machine / invariants
│   ├── cli/                      #   taskctl (CLI entry)
│   ├── mcp/                      #   MCP server (stdio)
│   ├── server/                   #   local HTTP API + SSE
│   └── shared/                   #   shared DTOs / constants
├── web/                          # board frontend (Vue 3 + Vite) → web/dist (hosted root)
├── skills/task-panel/        # skill — single source of truth
├── plugins/                      # one dispatch unit per host (claude/codex/openclaw/pi)
├── design/                       # brand assets (+ assets/ and prototype/ placeholders; migration pending)
├── scripts/                      # build / install / sync / verify
├── test/                         # contract + smoke tests
├── docs/                         # usage and development docs
└── dist/                         # build output (gitignored)
```

## Requirements

- **Node >= 22** — the runtime floor. The engine persists to a local SQLite database
  through the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module, which
  the 22.x line is the first to ship. `install.sh` checks this **before** installing and
  fails loudly when `node` is missing or older (`--skip-node-check` bypasses it), and the
  `taskctl` / MCP entry points refuse to start on an older runtime instead of failing
  later, mid-command.
- **Runtime zero-dependency, no network** — everything under `src/` uses Node builtins
  only and works fully offline.
- **`web/` is build-time only** — the board frontend's devDependencies (Vue 3 + Vite +
  Tailwind + daisyUI) are installed offline from the committed `web/.vendor/npm-cache`
  when the frontend is built. The shipped artefact is the static `web/dist` that `taskd`
  serves; nothing from that toolchain reaches the runtime.

## Install

```bash
bash install.sh --target claude|openclaw|codex|pi|all
```

Default target is `all`. The dispatcher forwards to `scripts/install/<host>.sh`, which
installs the skill into each host's skill directory — and, for **Claude Code** and
**Codex**, the rest of the host bundle: MCP registration, the host config
(`~/.claude/settings.json` / `~/.codex/AGENTS.md`), slash commands (Claude) or a claim
trigger (Codex), and a `taskctl` shim that pins the agent identity. All bundle writes are
merge-style and idempotent. The `Bundle` column is the per-host manifest that the host's
own plugin system consumes — registering it needs that host's CLI, so `install.sh` only
prints the command; see [`docs/install.md`](docs/install.md#per-host-steps) for the exact
one per host.

| Host | `--target` | Skill directory | Bundle |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/skills/task-panel` | `plugins/claude/.claude-plugin/plugin.json` |
| OpenClaw | `openclaw` | `~/.openclaw/skills/task-panel` | `plugins/openclaw/openclaw.plugin.json` (native) |
| Codex | `codex` | `~/.codex/skills/task-panel` | `plugins/codex/.codex-plugin/plugin.json` |
| Pi / Agent Skills | `pi` | `~/.agents/skills/task-panel` | `plugins/pi/package.json` |

OpenClaw also consumes the Claude-format bundle (`plugins/claude`), which is the supported
skill-only route; `plugins/openclaw/openclaw.plugin.json` is a *native* manifest — see
[`docs/install.md`](docs/install.md#openclaw) for the distinction.

Useful flags: `--prefix <home>` (override the target home), `--agent-name <name>` (the
agent's board identity, default `$USER` — must equal its assignee), `--no-automation`
(skip the Codex claim trigger), `--link` (symlink instead of copy), `--force` (overwrite
existing files and managed keys), `--dry-run` (preview every write and change nothing),
`--skip-node-check` (bypass the Node >= 22 check).

## Practice guide

Installing the skill is one line; working the board well is a set of habits.
Every host shares the same **eight rules**: **claim first** (read
`issue candidates --assignee <me>`, then `issue move <ref> in_progress`); claim
only what is yours (not somebody else's card, not an unreleased `backlog` card,
not an `epic`, and not a card whose `depends_on` blockers are unfinished); **one
card at a time**; keep a **fresh heartbeat** (the board treats a claim as live for
10 minutes); **deliver with a report** (the delivery gate); **self-review is not
acceptance** (an agent reaches `in_review`, a human accepts to `done`); **never
preempt a conflict** (re-read once, retry only if still claimable); and **stay
traceable** (carry the session id). What differs between hosts is *who applies
them*.

### OpenClaw

OpenClaw is the one host where the rules are **enforced for you**. Install the
[**openclaw-team**](https://github.com/tanyu216/openclaw-team) framework — a
file-based, idempotent installer that stands up a small agent team (one
coordinator plus four specialists) with dispatch, gates and **scheduling
(auto-claim)** — and Task Panel becomes their board, installed by default:

```bash
git clone https://github.com/tanyu216/openclaw-team
cd openclaw-team
./install.sh --dry-run      # preview every action
./install.sh                # idempotent install
```

Task Panel is the default task provider (pass `--no-task-panel` to bring your own
board instead); the framework's poll keeps its claim and candidate criteria in
lockstep with the board's `issue candidates`, which is the point of Highlight 8.
The dispatcher does the claiming, so the eight rules are applied by the framework
rather than by each agent.

### Claude Code

`install.sh --target claude --agent-name <name>` deploys the whole bundle, not just the
skill: it merges `~/.claude/settings.json` (adding `env.TASKCTL_AGENT` and a `SessionStart`
hook that starts the board and lists your claimable cards), installs
`~/.claude/commands/{board,claim,deliver}.md`, registers the MCP server when the `claude`
CLI is on `PATH`, and ships a `taskctl` shim that injects `--agent <name>`. Then drive the
board with `taskctl`, stamping each write with the host and session —
`--agent-platform claude --session-id <id>` — so a card's trail points back at the
conversation that did the work. Claude Code has **no auto-claim**: the claim in rule 1 has
to be triggered by the SessionStart hook, a slash command, or an external scheduler.

### Codex

`install.sh --target codex --agent-name <name>` deploys the whole bundle: it appends a
claim-first snippet to `~/.codex/AGENTS.md`, writes the schedulable claim trigger
`~/.codex/task-panel-claim.sh` (`--no-automation` skips it), registers the MCP server when
the `codex` CLI is on `PATH`, and ships the `taskctl` shim. Work the board the same way,
using the running thread as the session id — `--agent-platform codex --session-id
"$CODEX_THREAD_ID"` — for conversation-level attribution. Codex has **no auto-claim** of
its own, so rule 1 needs the claim trigger (or an external scheduler) to fire it.

The full guide — the eight rules in detail, the per-host install and trigger
differences, and a worked example — lives in the skill at
[`skills/task-panel/references/practice-guides.md`](skills/task-panel/references/practice-guides.md).

## Development

Requires **Node >= 22** (the `node:sqlite` era). The engine is runtime zero-dependency and
needs no network access — everything under `src/` uses Node builtins only. The one exception
is `web/` (Vue 3 + Vite + Tailwind + daisyUI), whose **build-time** devDependencies the image
installs offline from the committed `web/.vendor/npm-cache`; nothing from it reaches the
runtime.

```bash
node --test                          # run the smoke / contract test suite
node scripts/sync-skills.mjs         # skills/ → plugins/<host>/skills
node scripts/sync-skills.mjs --check # verify generated skill copies are in sync
node scripts/verify/manifests.mjs    # validate plugin manifests
node scripts/verify/skill.mjs        # validate SKILL.md frontmatter
node scripts/build.mjs               # produce dist/
```

Or run everything at once:

```bash
npm run check
```

## Roadmap

| Milestone | Contents |
|---|---|
| **M0** | Scaffold: layout, manifests, sync/verify scripts, tests *(landed)* |
| M1 | `src/core`: domain model, SQLite repository, state machine, invariants *(landed)* |
| M2 | `taskctl` command surface aligned with `task-interface v1`; minimal local `taskd` *(landed)* |
| M3 | `src/mcp`: stdio MCP server — 18 tools, thin proxy to `taskd` *(landed)* |
| M6 | Full board HTTP API + SSE backend (`src/server/`), and the `web` board frontend → `web/dist` *(landed)* |
| **Epic view** | Visual view of epic hierarchy / progress / rollup — see an epic and how the statuses of its child cards aggregate *(planned)* |
| **Iteration management** | Iteration (sprint) cycle management: group tasks into iterations, with in-iteration progress and capacity *(planned)* |

## License

MIT — see [LICENSE](LICENSE).
