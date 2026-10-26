# Operating the loop

Install paths, start/stop, the flags that matter, the review workflow, and the
board/loop compatibility contract.

## What the installer writes

For `<agent-dir>` = `~/.claude`, `~/.codex`, `~/.agents`, `~/.config/opencode` or `~/.cursor`:

| Artefact | Where | Notes |
|---|---|---|
| loop skill | `<agent-dir>/skills/meerkat-loop/` | always **copied**, never symlinked |
| execution body | `<agent-dir>/meerkat-taskpanel/scripts/…` and `scripts/foundation/…` | the copy the units run; closure in the skill's `manifest.txt` |
| units | `<agent-dir>/scheduling/{launchd,systemd,cron}/` | the resident pool (`session`), ping 60s, continue 600s, and the event subscriber (launchd/systemd; part of the enable set). Each names the **absolute `node`** it was rendered with and sets `PATH` — a scheduler's minimal `PATH` has neither `node` nor the agent CLI |
| wake glue | `<agent-dir>/bin/wake-<actor-kind>.sh` | legacy one-shot wakes only: resolves the card's directory from `projects.json`, then runs `claude -p` / `codex exec` / `pi --print` / `opencode run` / `cursor-agent -p` |
| agent config | `<agent-dir>/meerkat-taskpanel.env` | claim policy, stale recovery, `MEERKAT_TASKPANEL_REPO`, workflow answers, the pool's knobs, and the full-tool-access opt-in |
| runtime | `<agent-dir>/meerkat-taskpanel/{supervisor.log,supervisor.state.json,sessions.state.json,subagents.state.json,subscribe.state.json,supervisor.session.json}` | tick log, legacy worker registry, pool sessions + heartbeat (+ `controlMode`), subagent ledger, subscriber liveness, the pool a live session started |

`--link` applies to the board skill only: a symlinked loop body would
reintroduce the checkout dependency the copied body exists to remove.

## Start and stop

Nothing is loaded unless asked. The installer prints these commands; the opt-in
flag below runs them.

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.session.plist # the pool
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist   # and .continue.plist
# Linux user units
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-session.service meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer
# Anywhere — no pool: patrol + workflow only, no worker dispatch
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

`install.sh --supervisor=enable` (alias `--enable-supervisor`) is the opt-in;
`--supervisor-actor-kinds claude,codex,pi,opencode,cursor` limits the agent kinds and `--scheduler
auto|launchd|systemd|cron` picks the mechanism. `--supervisor=disable` and
`--supervisor=status` use the same entry point. On a TTY with no flag it asks
once and defaults to **no**; `MEERKAT_TASKPANEL_SUPERVISOR` is the
non-interactive form.

A loaded unit names no checkout: it runs
`<agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs`, so moving, renaming or
deleting the checkout does not require a reload.

## Run by hand

```bash
node <agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs --actor-kind claude --agent alice --session
node <agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs --actor-kind claude --agent alice
node <agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs --actor-kind claude --agent alice --ping-only --once
node <agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs --actor-kind claude --agent alice --continue-only --once

node <agent-dir>/meerkat-taskpanel/scripts/loop/passes.mjs patrol   --actor-kind claude --agent alice
node <agent-dir>/meerkat-taskpanel/scripts/loop/passes.mjs workflow --actor-kind claude --agent alice
node <agent-dir>/meerkat-taskpanel/scripts/loop/passes.mjs poll     --actor-kind claude --agent alice

# The live-session mode: status, an explicit pool takeover, the console cycle.
node <agent-dir>/meerkat-taskpanel/scripts/loop/status.mjs  --json
node <agent-dir>/meerkat-taskpanel/scripts/loop/status.mjs  --take-over
node <agent-dir>/meerkat-taskpanel/scripts/loop/status.mjs  --stop
node <agent-dir>/meerkat-taskpanel/scripts/loop/console.mjs --once --json
node <agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs --actor-kind claude --agent alice \
  --session --control=external
```

A bare `node` is right in your own shell. The units cannot assume it, which is
why they name an absolute interpreter.

`--control=external` is the pool half of the manual mode: it opens no control session and
skips `continue.pending`; the live session runs the control turn and the pool keeps only
the project sessions. `status.mjs --take-over` starts exactly that, records its pid, and
`--stop` stops only that process.

### Main flags

Precedence: flag > process env > agent config > default.
`node …/supervisor.mjs --help` prints the complete list.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `MEERKAT_TASKPANEL_AGENTS` → `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--roles-dir <path>` | project `.meerkat/roles`, then the loop skill's `roles/` | optional team roles root; see “Team roles” |
| `--actor-kind claude\|codex\|pi\|opencode\|cursor` | `claude` | which worker to wake |
| `--repo <path>` | `MEERKAT_TASKPANEL_REPO`, else this checkout | where `--cli` resolves from; fallback cwd |
| `--ping-interval <sec>` | 60 | liveness clock |
| `--continue-interval <sec>` | 600 | judgment clock |
| `--continue=yes\|no` | yes | enable the continue turn |
| `--max-concurrency <n>` | 8 | simultaneous subagents — workers and reviewers share the budget; the split follows demand, with no per-role reservation |
| `--claim-unassigned=yes\|no` | yes | also claim the public pool |
| `--recover-stale=yes\|no` | yes | also claim stale `in_progress` (same holder 30 min, anyone 6 h) |
| `--workflow=yes\|no` | yes | run the workflow pass; off means the loop writes no card |
| `--reviewer <agent>` | unset | the deployment reviewer. A project's `reviewer` overrides it; unset disables dispatch for projects without one, and an `agent` card with no effective reviewer fails startup. Verdicts in flight still apply. |
| `--workflow-max-actions <n>` | 20 | writes per workflow pass |
| `--review-aging-minutes <n>` | 60 | report a review card with no readable verdict this long |
| `--workflow-ledger <path>` | beside `--state` | workflow alert de-duplication ledger; an unreadable one suppresses nothing |
| `--session` | — | run the resident session pool (control + one project session per target directory); this is a daemon mode |
| `--control=internal\|external` | internal | who owns the control turn: the pool (`internal`) or a live session (`external`, which opens no control session and skips `continue.pending`) |
| `--resident=auto\|no` | auto | use a live pool for continue; `no` never dispatches workers |
| `--session-state <path>` | beside `--state` | pool state file (`sessions.state.json`) |
| `--session-max-age <sec>` | 86400 | fresh conversation after this age; 0 = never |
| `--session-turn-timeout <sec>` | 1800 | one agent turn; must be **1200–7199** (≥ 2× the 10-minute heartbeat window, < the ledger's 2-hour reap) |
| `--opened-by human\|supervisor` | supervisor | who started this loop: a supervisor escalates questions to the board; a human-opened session may ask its own operator first and records the answer with `--as-human` |
| `--session-poll-ms <ms>` | 1000 | queue poll interval |
| `--session-pool-max <n>` | 8 | project sessions held open |
| `--project-concurrency <n>` | `--max-concurrency` | live subagents per project |
| `--project-idle-ms <ms>` | 1800000 | close an idle project session (keeps its session id) |
| `--subagent-background=yes\|no` | no | project sessions spawn background subagents |
| `--allow-all-tools` | off | full agent tool access; requires `--allow-all-tools-reason "<who authorized it and why>"` |
| `--subscribe` | off | run the event subscriber (`taskctl events follow`, the local event hub); launchd/systemd only — the installed units pass it |
| `--event-continue=yes\|no` | yes | let events wake a continue turn |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--sla-peer <path>` | unset | peer inspector's last-ok marker; unset registers a dependency, not an alarm |
| `--notify <cmd>` | — | run `<cmd>` with each alert as JSON on stdin |

Configuration and transport:

| Flag | Default | Meaning |
|---|---|---|
| `--url <url>` | `TASKD_URL` (env or install-root `.env`), then the runtime pointer | board address |
| `--env-file <path>` | `MEERKAT_TASKPANEL_ENV_FILE`, then `<repo>/.env` | config file for the loop's `taskctl` children |
| `--token <token>` | `$TASKD_TOKEN` / `TASKD_TOKEN_FILE` / pointer tokenFile | board token; prefer the env or file form |
| `--config <path>` | `<home>/<agent-dir>/meerkat-taskpanel.env` | agent config the installer writes |
| `--projects-json <path>` | beside the board skill, or `MEERKAT_TASKPANEL_PROJECTS_JSON` | agent-local project map handed to the glue |
| `--home <path>` | `$HOME` | root the defaults resolve against |
| `--cli <path>` | `<repo>/src/cli/index.mjs` | `taskctl` entry |
| `--glue <path>` | `<home>/<agent-dir>/bin/wake-<actor-kind>.sh` | wake glue |
| `--wake-command <cmd>` | — | your own wake command instead of the built-in agent form |

Selectors, state and internals:

| Flag | Default | Meaning |
|---|---|---|
| `--once` | — | run one pass and exit; no selector means the legacy poll pass |
| `--ping-only` / `--continue-only` / `--patrol-only` | — | the selector for `--once` |
| `--continue-state <path>` | `continue.state.json` beside `--state` | continue lock |
| `--log <path>` | `<home>/<agent-dir>/meerkat-taskpanel/supervisor.log` | append log lines |
| `--state <path>` | `<home>/<agent-dir>/meerkat-taskpanel/supervisor.state.json` | worker registry |
| `--sla-ledger <path>` | sibling of `--state` | SLA de-duplication ledger |
| `--sla-leader <id>` | the board's human decision authority | author id passed to `sla list` / `sla get` |
| `--sla-last-ok <path>` | — | this mechanism's last-successful-run marker |
| `--board-limit <n>` | 500 | max cards per read |
| `--trail-limit <n>` | 200 | max comment trails per SLA read |
| `--patrol-interval <sec>` | the board's `TASKD_SLA_PERIOD_SECONDS`, else 300 | SLA measurement period |
| `--patrol-llm=yes\|no` | no | allow patrol to start an LLM turn |
| `--sse-idle-ms <ms>` | 45000 | reconnect after this much stream silence |
| `--event-debounce-ms <ms>` | 300 | coalesce a burst of events |
| `--event-debounce-max-ms <ms>` | 2000 | never delay the first pending event past this |
| `--event-continue-min-ms <ms>` | 60000 | at most one event-triggered turn per interval |

`--poll-interval` is the deprecated alias of `--ping-interval`; `--assignee-only` is
`--claim-unassigned=no`; `--allow-all-tools-reason` is required with `--allow-all-tools`.
There is no `--acceptance-policy` (nor `--acceptance`) flag: the card's own
`acceptance_mode` is authoritative and the loop keeps no copy.

`--once` with no selector runs the legacy poll pass; installed units use
`--ping-only` / `--continue-only`. `--patrol-only` remains for legacy units.

## No resident pool

Poll is the only claim path, and the project session is the only dispatcher, so the
loop refuses to claim when the pool is not live (`sessions.state.json`: pid alive
and heartbeat younger than 60s) or when `--resident=no` is set:

- `poll` claims nothing, scans nothing, logs why, and emits one `--notify` alert per
  cadence (`kind: no_resident`);
- an event-triggered turn is skipped entirely (the subscriber logs it): it could dispatch
  nothing, so it does not buy a turn at the event cadence;
- a one-shot continue turn runs **patrol + workflow only** — the prompt omits poll;
- `patrol --patrol-llm=yes` degrades to notify-only;
- `workflow` runs, and review cards accumulate until the pool returns.

That is the cron shape, and the shape on an agent kind whose CLI lacks the resident
protocol. Start the session unit to get dispatch. All five agent kinds have an adapter:
Claude Code (stream-json), Codex (app-server threads), Pi (`--mode rpc`),
OpenCode (`serve`, one per directory), Cursor (ACP).

## Manual mode (a live session hosts the control turn)

The loop has one control turn. In manual mode the **live session** runs it; the pool is
started with `--control=external`, so it opens no control session and leaves
`continue.pending` alone. Nothing else changes: the same `patrol → workflow → poll`, the
same question ladder, the same acceptance rules.

1. `status.mjs --json` → `running | busy | starting | configured-idle | partial | absent`.
   - `running` + `pool.controlMode: internal`: the installed supervisor owns the turn; do
     not run a second one. You may attach as a question console.
   - `configured-idle` / `partial` / `busy`: report; the service manager or an in-flight
     turn owns it.
   - `absent`: ask the human, then `status.mjs --take-over` (explicit; the pool persists
     until `status.mjs --stop`).
2. Control ticks run `passes.mjs patrol → workflow → poll` (the same commands the
   supervised prompt lists). With the external pool live, poll claims and enqueues; the
   pool's project sessions spawn the workers/reviewers.
3. Question ticks run `console.mjs --once --json`: `awaiting` cards, in_progress agent
   questions with no later human comment, and `in_review` cards pending acceptance. The UI
   comment and the in-session answer are the **same record**: re-read the card before asking
   and again before recording; if a human comment is already newer than the question, do not
   ask or duplicate it — use that comment and run a control tick. Otherwise ask, then record
   with `taskctl comment add <ref> --as-human …`; the board comment is authoritative, the
   in-session question is the front-end. Then apply the ladder's move and run a control tick.
4. Bound the loop (control cadence 600 s, question tick 30 s, TTL 30 min). Never decide
   E1–E5 yourself, never claim/move a work card, never start a second pool, and run at most
   one console per agent directory (`session.lock` guards the pool; two consoles would race
   the workflow ledger). For unattended operation, enable the units.

`--opened-by human` is the same idea at the single-turn level; manual mode adds the pool
and the repeated loop around it.

## Card briefs and task process directories

The loop gives each dispatched card one directory under the project's working directory
(the resolved `target_dir`):

```text
.meerkat/<identifier>/
  card.md          exported by the loop; read-only to agents
  plan.md          the worker's plan: goals, steps, risks, acceptance mapping
  …                notes, logs, evidence, report drafts, downloaded attachments
```

**Export before claim.** `poll` resolves the project directory, then runs
`taskctl export md <identifier> --out <target_dir>/.meerkat/<identifier>/card.md` before
`issue claim`. The CLI writes a unique temp file in the same directory and the loop renames
it over `card.md`, so a reader never sees a partial file and a legitimate growth (comments,
a report) cannot trip the CLI's growth guard. If the export fails, the card is **deferred
unclaimed** and the next turn retries it. Patrol's `--patrol-llm=yes` lane claims the same
way and applies the same gate.

A reviewer's dispatch also exports the original (`review_of`) best-effort; a failure there
is logged but does not block the review card.

**The brief is authoritative for dispatch and resume.** The handoff names the relative path
(its cwd is the project directory), says to read it first, and says never to edit it: only
`taskctl export md` overwrites it. `taskctl issue get <ref> --json` stays in the handoff for
live status and the `version` a write needs. A resumed session re-reads the brief before
continuing (`buildReattachPrompt`).

**Attachments go in the same directory.** Use
`taskctl attachment list <ref> --json`, then
`taskctl attachment download <attachment-id> --out .meerkat/<identifier>/<filename>`.
`--out` is the caller's choice; the loop's handoff is what fixes it to the task directory.

**Refresh on events.** With `--subscribe`, every event that names an active queued card
(including `comment_added` and `report_written`, and including the loop's own writes) adds
its `task_id` to a debounced batch. The batch refreshes the briefs of every matching card
and, for a review card, its original. It runs even when `--event-continue=no`; it is bounded by its own minimum
interval (`CARD_REFRESH_MIN_MS`) and a failed refresh only logs and keeps the previous file.
Dispatch is separate: an event wakes a continue turn only while the resident pool is live.
The daemon publishes `subscribe.state.json` (pid, last connection/event, pending reconnect),
which `install.sh --supervisor=status` reports as `streaming` / `reconnecting` /
`starting` / `not running`.

The queue row carries the event UUID (`task_id`) and `review_of`/`review_round` so this
mapping needs no board read. Rows written before this convention have no `task_id` and are
not refreshed until they are enqueued again.

**The plan file.** Workers maintain `plan.md` beside the brief and update it as they learn;
the reviewer reads it and treats an unexplained deviation as grounds for `VERDICT: REJECT`.
A missing plan is not itself a failure: the reviewer falls back to the description and the
frozen acceptance snapshot. The board holds no directory (O3); this is a loop convention
under the project's own working directory.

## Team roles (optional)

A team is an optional roles root authored by `setup-meerkat`; `install.sh` never ships one.
The loop reads `manifest.json` there and adds two layers:

1. **Routing** — the role named by the card's assignee (`Jobs`, `Linus`, `Turing`,
   `Reviewer`) supplies the responsibilities and boundaries.
2. **Workflow** — the handoff carries the role's workflow path (and the self-check path);
   the spawned subagent reads them before acting.

Precedence is whole-manifest: `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR`, then
`<project>/.meerkat/roles/`, then `<agent-dir>/skills/meerkat-loop/roles/`, then
`<agent-dir>/meerkat-taskpanel/roles/`. A malformed manifest warns and degrades to no
role; it never wedges a tick. With no roles root the prompts are unchanged.

`setup-meerkat` writes the team's board names to `MEERKAT_TASKPANEL_AGENTS` in the agent
config. Without that list the loop scans only its default agent, so a role card is never
claimed. A role may also be listed explicitly with repeated `--agent` flags.

`install.sh --force` replaces the loop skill directory, including an installed `roles/`;
re-run `/setup-meerkat` after a forced reinstall.

## Questions and decision rights

The ladder is **subagent → main session → human**; the full policy is
`references/decision-policy.md`. A subagent never decides an unauthorized question: it
writes an agent `question` comment, keeps the card `in_progress`, and stops. The project
session answers what it can with a `note` (then reattaches the subagent or moves the card
to `todo`), or escalates E1-E5 to the human with
`issue move <ref> awaiting --awaiting-reason E1..E5 --question "…"`.

Any human comment auto-resumes an awaiting card — the kind does not matter and the board
does not read it. Approve, reject and direction are judged from the content by the resumed
worker; an incomplete or ambiguous answer is not consent, and the card goes back to
`awaiting` for another human comment. The loop never writes a decision kind for its own
answer, and never uses `--as-human` except to record what the human actually said in a
human-opened conversation (`--opened-by human`). With `--opened-by supervisor` the question
stays on the board for the human.

## The workflow channel

The SLA rows are notify-only. The workflow pass is the only path that writes a
card, and the board decides what it writes: one plan (container reconcile,
review outcomes, auto-accept, dispatch), which the loop then executes. The exact
invocation and every action field are the board skill's capability contract
(`references/capabilities.md` §6–7); the review-card shape and its structural
identity are `references/review-workflow.md` in the same skill.

A flow-A delivery that lands in `in_review` **on a card whose
`acceptance_mode` is `agent`** is dispatched to the configured reviewer as a
**review card**. The reviewer is `project.reviewer ??` the deployment reviewer.
Poll wakes every configured reviewer through the normal atomic claim; a
dedicated reviewer sees only review cards and never the public pool.

An `off` card gets no review card. The plan carries `auto_accept`, which the
loop applies (`loop-auto`); an `off` card may also skip `in_review` entirely
(`issue deliver --to done`). A `human` card is left for the person
(`auto_accept_skipped`, reason `human_mode`).

What keeps it safe to run unattended:

- **One review card per (original, delivery round)** — idempotency key
  `loop-review|<ref>|r<round>`. A re-delivery after a rejection is a new round
  and is reviewed again.
- **The review card is closed last** — a crash between the original's move and
  the card's close is recovered next pass.
- **A truncated board read dispatches nothing**, and a reviewer equal to the
  card's own assignee is refused (`self_review_not_independent`).
- **A canceled review card ends `canceled`** — the two-hop
  `in_review → in_progress → canceled`; it is never recorded as `done`.
- **A review card always has a closer** — the loop closes the card it
  dispatched; there is no switch that could leave it for nobody.

Operational alerts: `original_unseen` (`board_truncated` when the read is
capped), `verdict_unreadable`, `review_aging`, `review_report_not_by_reviewer`,
`review_stale_round`, `actions_capped` / `dispatch_capped`. An unreadable
verdict, unseen original, round mismatch or conflicting verdict produces an
alert and **no write**; the next pass retries.

The verdict contract and the loop's action per verdict are the board skill's
`references/review-workflow.md` §6; the agent-facing protocol is §3. The reviewer reads the
original's description, every acceptance item, the current round's report, the
comment trail and (for an epic) its children, and writes `VERDICT: APPROVE` or
`VERDICT: REJECT` on the review card. The reviewer moves nothing; the loop is
the acceptor.

## Headless permission boundary

A wake is non-interactive, so the worker must run under a pre-declared boundary
— a tool allowlist, a permission mode, a sandbox. The generated glues ship
**no** permission bypass (no `--dangerously-skip-permissions`, no Codex
approval bypass). Enabling one is a deliberate act that needs written
authorization and must be documented at the point of use.

The resident pool keeps role allowlists by default (control: read + `taskctl` +
`node`; reviewer: read/search + `taskctl` + `git`; worker: the same plus
edit/write). Full tool access is the documented opt-in:

```bash
# agent config, not a unit flag:
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS=yes
MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS_REASON="<who authorized it and why>"
```

The reason is required and recorded in `--supervisor=status`. With it, every
control, project and subagent session runs with the installing user's full OS
permissions; the project directory is a working directory, **not** an isolation
boundary. The legacy one-shot wake glue never carries a bypass: full access is
the resident pool's opt-in only.

## Compatibility

| Side | Declares | Where |
|---|---|---|
| loop | `task-interface v1`, board release ≥ 1.1.0 | `SKILL.md`, enforced by `scripts/board-check.mjs` |
| board | its release version and contract `schema_version` | `taskctl --version --json` |

```bash
node scripts/board-check.mjs --repo <board-checkout>   # exit 3 when too old
```

The gate is deliberately coarse: it answers "is this a board of the generation
I was written against?", not "does every command still behave identically". A
change to the `task-interface` surface means a new generation on both sides.

### What the loop still needs from a checkout

One thing: the **board engine**. The copied body drives `taskctl`, which lives
in the board's checkout, found through `MEERKAT_TASKPANEL_REPO` in the agent
config. The body loads with no checkout present, but a *tick* needs the engine
reachable. Re-running `install.sh` after the checkout moves re-points the config
key; no unit reload is needed. This is the one remaining checkout dependency.
