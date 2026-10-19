# Operating the loop

Everything an operator needs: why the loop is a skill of its own, what the installer
writes and where, how to start it, what it is allowed to do, and what has to hold on
both sides of the board/loop boundary.

## Why this is a separate skill

The loop and the board are two things with two lifecycles, and they were one thing only
by accident of packaging.

- **The board** is the state: cards, claims, heartbeats, reports. An agent uses it
  *inside* a session, through `taskctl`.
- **The loop** is a deployment: a daemon that scans, claims and wakes, plus the
  launchd / systemd / cron units that keep it running. It is not something an agent
  "uses" — it is something that runs when no agent is.

Bundled together, the loop was an implicit side effect of installing the board, and it
carried the board's constraints. Split apart:

- **the distribution surface matches the responsibility** — every host that can be woken
  by an external supervisor gets the loop (`claude`, `codex`, `pi`), and OpenClaw — which
  already ships an equivalent supervisor in the openclaw-team framework — does not;
- **the execution body can be self-contained** — the loop's body is copied into the host,
  so a scheduling unit a user has already *loaded* names no checkout path and keeps working
  when that checkout moves, is renamed or is deleted;
- **the two can version independently.** The loop declares the board interface generation
  it needs (see `SKILL.md` §Required board interface); the board declares which generation
  its CLI speaks. Neither has to be released to move the other.

## What the installer writes

`bash install.sh --target <claude|codex|pi>` writes, for that host (`<host>` is
`~/.claude`, `~/.codex` or `~/.agents`):

| Artefact | Where | What it is |
|---|---|---|
| loop skill | `<host>/skills/meerkat-loop/` | this skill — body, templates, gate. Always **copied**, never symlinked |
| execution body | `<host>/meerkat-taskpanel/scripts/supervisor.mjs` + `.../scripts/loop/*.mjs` + `.../scripts/wake-cwd.mjs` + `.../src/shared/*.mjs` | the copy the units run; its closure is listed in this skill's `body/manifest.txt` |
| units | `<host>/scheduling/{launchd,systemd,cron}/` | `StartInterval` 60 (ping) and 600 (continue) units. Each names the **absolute `node`** it was rendered with and carries a **`PATH`** (host CLI's directory + node's, then the scheduler's default) — a scheduler runs a unit with a minimal `PATH` that has neither, so `env node` is exit 127 and the continue turn's host CLI fails on it too |
| wake glue | `<host>/bin/wake-<host>.sh` | resolves the card's project directory from the skill's `projects.json`, then runs `claude -p` / `codex exec` / `pi --print` |
| host config | `<host>/meerkat-taskpanel.env` | the claim-unassigned and stale-recovery policies, `MEERKAT_TASKPANEL_REPO` — where the board engine lives — and the workflow channel's three answers (`WORKFLOW`, `AUTO_ACCEPT_REVIEWS`, `REVIEWER`) |
| runtime | `<host>/meerkat-taskpanel/{supervisor.log,supervisor.state.json}` | the tick log and the running registry |

`--link` applies to the **board** skill only. The loop is always copied: a symlinked body
would reintroduce exactly the checkout dependency this split removes.

Nothing is loaded for you **unless you ask**. The installer prints the command, and loading
a daemon is the operator's call:

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist   # and .continue.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer
# Anywhere
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

Asking is one flag — `install.sh --supervisor=enable` (alias `--enable-supervisor`;
per host with `--supervisor-hosts claude,codex,pi`, one mechanism with
`--scheduler auto|launchd|systemd|cron`), with `--supervisor=disable` and
`--supervisor=status` as the same entry point, and `MEERKAT_TASKPANEL_SUPERVISOR` for
non-interactive callers. On a TTY with no flag it asks once and defaults to **no**;
without a request it still only prints the commands above.

**A loaded unit names no checkout.** That is the point of the host-local body: the units
name `<host>/meerkat-taskpanel/scripts/supervisor.mjs`, so moving, renaming or deleting
the checkout does not invalidate them and reloading is never required.

## Running the supervisor by hand

```bash
# The scheduler owns both clocks; no board work happens here.
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --ping-only --once
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --continue-only --once

# The deterministic entries run on their own too — this is what the continue turn does.
node <host>/meerkat-taskpanel/scripts/loop/patrol.mjs   --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/loop/workflow.mjs --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/loop/poll.mjs     --host claude --agent alice
```

A bare `node` is right *here*, because you are in your own shell and it is your `PATH` that
answers. The units cannot make that assumption (see the `units` row above), which is why
they name an absolute interpreter and set their own `PATH`.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--host claude\|codex\|pi` | `claude` | which worker to wake |
| `--repo <path>` | the host config's `MEERKAT_TASKPANEL_REPO` | where `--cli` is resolved from, and the fallback working directory |
| `--ping-interval <sec>` | `60` | liveness clock: prune dead worker pids; no board read |
| `--continue-interval <sec>` | `600` | judgment clock: wake the host for one `继续` turn |
| `--continue=yes\|no` | from the host config → `yes` | enable the continue turn |
| `--continue-state <path>` | `continue.state.json` beside `--state` | the single-flight continue lock |
| `--patrol-interval <sec>` | `300` | the SLA **measurement** period; it no longer schedules anything |
| `--max-concurrency <n>` | `8` | cap on simultaneously running workers |
| `--claim-unassigned=yes\|no` | from the host config → `yes` | also claim unassigned cards (the public pool) |
| `--recover-stale=yes\|no` | from the host config → `yes` | also claim stale `in_progress` cards — the same holder after 30 min, any agent after 6 h — through `issue claim` |
| `--workflow=yes\|no` | from the host config → `yes` | run the workflow sub-pass (reconcile → outcomes → dispatch). Off means the loop writes no card |
| `--reviewer <agent>` | `$MEERKAT_TASKPANEL_REVIEWER` → unset | the independent reviewer. Unset disables review dispatch only; verdicts already in flight still get applied |
| `--auto-accept-reviews=yes\|no` | from the host config → `yes` | let the loop close a review card after applying its verdict. `no` leaves it in `in_review` for a human; the verdict on the original is still applied |
| `--workflow-max-actions <n>` | `20` | cap on writes one workflow pass performs |
| `--review-aging-minutes <n>` | `60` | report a review card that has had no readable verdict this long |
| `--once` | off | one pass, then exit. With no selector this is the **legacy poll pass**; the installed units use `--ping-only` / `--continue-only` |
| `--ping-only` / `--continue-only` | off | with `--once`, run only that clock's pass |
| `--patrol-only` | off | with `--once`, run only the SLA patrol pass (legacy units) |
| `--subscribe` | off | run the event-subscriber daemon: one SSE connection → one continue turn per coalesced burst. launchd/systemd only; cannot be combined with `--once` or another selector |
| `--url <url>` | the runtime pointer | board URL for the subscriber |
| `--token <token>` | `$TASKD_TOKEN` → the pointer's token file | board token for the subscriber |
| `--sse-idle-ms <ms>` | `45000` | reconnect after this much stream silence (three missed heartbeats) |
| `--event-debounce-ms <ms>` | `300` | coalesce a burst of events |
| `--event-debounce-max-ms <ms>` | `2000` | never delay the first pending event past this |
| `--event-continue=yes\|no` | from the host config → `yes` | let events wake a continue turn |
| `--event-continue-min-ms <ms>` | `60000` | at most one event-triggered turn per interval |
| `--notify <cmd>` | — | run `<cmd>` with each patrol alert as JSON on stdin (the legacy heartbeat alert and the SLA tuple) |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--sla-ledger <path>` | `sla-ledger.json` beside `--state` | the SLA de-duplication ledger; an unreadable one suppresses nothing |
| `--sla-leader <id>` | `$MEERKAT_TASKPANEL_SLA_LEADER` → unset | the author id the leader writes under (the `leader_stalled` attribution set); unset ⇒ the board's decision authority (`author_kind = "human"`) |
| `--sla-last-ok <path>` | `loop-patrol-last-ok.json` beside `--state` | this mechanism's own last-successful-run marker, for the peer's watchdog |
| `--sla-peer <path>` | `$MEERKAT_TASKPANEL_SLA_PEER` → unset | the peer inspector's last-ok marker; stale ⇒ `inspector_liveness`. Unset ⇒ a registered dependency, no alarm |
| `--board-limit <n>` / `--trail-limit <n>` | `500` / `200` | caps on the two reads one patrol pass makes |

The full table, and the tick's flow, are in the repository's `docs/scheduling.md`.

The **event subscriber** is optional and does not add a second dispatch path: it holds one
SSE connection and asks the existing continue turn to run, so the scan → claim → wake
authority stays where it always was. It reacts to card-lifecycle events and
`import_completed`; comments, sessions, progress and attachments are UI-only. Cron cannot
host a long-lived process, so a cron deployment stays on the continue cadence.

## The workflow channel

Two passes with two different powers, and the distinction is load-bearing:

- **the SLA rows are notify-only.** No alert moves a card, releases a blocked one or starts
  a model turn for a new row.
- **the workflow entry writes.** It is its own program (`scripts/loop/workflow.mjs`), run
  by the continue turn after patrol: `issue reconcile` (container start/close), the review
  outcomes, then review dispatch.

A delivery that lands in `in_review` on **flow A** is dispatched to the configured
reviewer as a **review card** — an ordinary `kind=task` card with `meta.review_of=<the
original>`, `meta.flow=B`, `meta.review_round=<round>`, and a label `review` for
discoverability (detection reads the meta keys, never the label). The reviewer is woken by
the poll entry in the continue turn, through the normal atomic claim; a dedicated reviewer is scanned only for
review cards and never claims the public pool. It reads the original's description, every
acceptance item, the current round's delivery report, the comment trail and (for an epic)
its children; it then delivers a report on the review card whose **first line** is
`VERDICT: APPROVE` or `VERDICT: REJECT`. If the original carries
`meta.acceptance_derived=yes`, the list is agent-derived: the reviewer checks that it covers
every requirement in the description and the comment trail, and treats a list that narrows
the card as grounds for `REJECT`.

The reviewer moves nothing. The loop is the acceptor:

| Verdict | The loop does |
|---|---|
| `APPROVE` | note + `meta.accepted_by=loop-review` on the original, `in_review → done`; then closes the review card |
| `REJECT` on a task | findings as a `kind=change` comment, `meta.rework_round=<new round>`, `in_review → in_progress → todo` (releasing the claim); then closes the review card |
| `REJECT` on an epic | **first** creates a fix child and links it, then comments/marks and reopens the epic `in_review → in_progress`. The fix child is what stops `reconcile` from re-closing the container immediately |

Rules that make it safe to run unattended:

- **one review card per (original, delivery round)** — the idempotency key is
  `loop-review|<ref>|r<round>`. A re-delivery after a rejection is a new round and is
  reviewed again; a stale verdict is never applied to it.
- **fail-safe** — an unreadable verdict, an unseen original, a round mismatch or a
  conflicting verdict produces an alert and **no write**. The review card stays in
  `in_review` and the next pass retries.
- **the verdict is the reviewer's** — the report's author is checked against the configured
  reviewer (else the review card's assignee). A report from anybody else is
  `review_report_not_by_reviewer` and is not applied.
- **a silent reviewer is reported** — one that produces no readable verdict within
  `--review-aging-minutes` (default 60) raises `review_aging`; the original's SLA row is
  suppressed while the review card exists, so this is the only watcher that row has.
- **the board enforces acceptance** — `in_review → done` is allowed only for a `human` or
  the board itself (`system`); an agent gets `ACCEPTANCE_FORBIDDEN`. The reviewer never
  closes a card; the loop accepts as `system`.
- **the review card is closed last.** A crash between the original's move and the card's
  close is recovered next pass (`original done + APPROVE`, `rework_round` matching, …).
- **`--auto-accept-reviews=no`** is the escape hatch back to manual acceptance: the
  verdict is still applied to the original, but the review card is left for a human.
- **a truncated board read dispatches nothing**, and a reviewer that equals the card's own
  assignee/claimer is refused (`self_review_not_independent`).

## The headless permission boundary

A wake is non-interactive: there is no human to answer "may I run this?". So the worker
must run under a **pre-declared boundary** — a tool allowlist, a permission mode, a
sandbox — and the generated glues deliberately ship **no** permission bypass (no
`--dangerously-skip-permissions`, no Codex approval bypass). Turning a bypass on is a
deliberate act that needs written authorization and must be documented at the point of
use, in the glue or the host config that carries it. See `docs/scheduling.md`
§Headless permission boundary.

## Compatibility

The loop and the board are released independently, so each side states what it needs:

| Side | Declares | Where |
|---|---|---|
| loop | required board interface generation + release floor (`task-interface v1`, board ≥ 1.0.0) | `SKILL.md`, enforced by `scripts/board-check.mjs` |
| board | its release version and its contract `schema_version`, at runtime via `taskctl --version --json` | the board's own `--version --json` |

Run the gate before pointing a loop at a board:

```bash
node scripts/board-check.mjs --repo <board-checkout>   # exit 3 when the board is too old
```

The gate is deliberately coarse — it answers "is this a board of a generation I was
written against?", not "does every command still behave identically". A change to the
`task-interface` surface means a new generation on both sides, and this table is where
that pairing is recorded.

### What the loop still needs from a checkout

One thing, and it is named rather than hidden: the **board engine**. The copied body
drives `taskctl`, which lives in the board's checkout, and it finds it through
`MEERKAT_TASKPANEL_REPO` in the host config. So the body is self-contained (it loads with
no checkout present) but a *tick* still needs the board engine reachable — re-running
`install.sh` after the checkout moves re-points the config key, and no unit reload is
needed. Installing the board engine into the host as well was considered and left out of
this split; it is the one remaining checkout dependency, and this paragraph is its record.
