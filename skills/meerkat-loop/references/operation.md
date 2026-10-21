# Operating the loop

Install paths, start/stop, the flags that matter, the review workflow, and the
board/loop compatibility contract.

## What the installer writes

For `<host>` = `~/.claude`, `~/.codex`, `~/.agents`, `~/.config/opencode` or `~/.cursor`:

| Artefact | Where | Notes |
|---|---|---|
| loop skill | `<host>/skills/meerkat-loop/` | always **copied**, never symlinked |
| execution body | `<host>/meerkat-taskpanel/scripts/…` and `scripts/foundation/…` | the copy the units run; closure in the skill's `manifest.txt` |
| units | `<host>/scheduling/{launchd,systemd,cron}/` | ping 60s, continue 600s. Each names the **absolute `node`** it was rendered with and sets `PATH` — a scheduler's minimal `PATH` has neither `node` nor the host CLI |
| wake glue | `<host>/bin/wake-<host>.sh` | resolves the card's directory from `projects.json`, then runs `claude -p` / `codex exec` / `pi --print` / `opencode run` / `cursor-agent -p` |
| host config | `<host>/meerkat-taskpanel.env` | claim policy, stale recovery, `MEERKAT_TASKPANEL_REPO`, workflow answers |
| runtime | `<host>/meerkat-taskpanel/{supervisor.log,supervisor.state.json}` | tick log and worker registry |

`--link` applies to the board skill only: a symlinked loop body would
reintroduce the checkout dependency the copied body exists to remove.

## Start and stop

Nothing is loaded unless asked. The installer prints these commands; the opt-in
flag below runs them.

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.ping.plist   # and .continue.plist
# Linux user units
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-ping.timer meerkat-taskpanel-continue.timer
# Anywhere
crontab ~/.claude/scheduling/cron/meerkat-taskpanel.cron
```

`install.sh --supervisor=enable` (alias `--enable-supervisor`) is the opt-in;
`--supervisor-hosts claude,codex,pi,opencode,cursor` limits the hosts and `--scheduler
auto|launchd|systemd|cron` picks the mechanism. `--supervisor=disable` and
`--supervisor=status` use the same entry point. On a TTY with no flag it asks
once and defaults to **no**; `MEERKAT_TASKPANEL_SUPERVISOR` is the
non-interactive form.

A loaded unit names no checkout: it runs
`<host>/meerkat-taskpanel/scripts/supervisor.mjs`, so moving, renaming or
deleting the checkout does not require a reload.

## Run by hand

```bash
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --ping-only --once
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --continue-only --once

node <host>/meerkat-taskpanel/scripts/loop/patrol.mjs   --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/loop/workflow.mjs --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/loop/poll.mjs     --host claude --agent alice
```

A bare `node` is right in your own shell. The units cannot assume it, which is
why they name an absolute interpreter.

### Main flags

Precedence: flag > process env > host config > default.
`node …/supervisor.mjs --help` prints the complete list.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--host claude\|codex\|pi\|opencode\|cursor` | `claude` | which worker to wake |
| `--repo <path>` | `MEERKAT_TASKPANEL_REPO`, else this checkout | where `--cli` resolves from; fallback cwd |
| `--ping-interval <sec>` | 60 | liveness clock |
| `--continue-interval <sec>` | 600 | judgment clock |
| `--continue=yes\|no` | yes | enable the continue turn |
| `--max-concurrency <n>` | 8 | simultaneous workers |
| `--claim-unassigned=yes\|no` | yes | also claim the public pool |
| `--recover-stale=yes\|no` | yes | also claim stale `in_progress` (same holder 30 min, anyone 6 h) |
| `--workflow=yes\|no` | yes | run the workflow pass; off means the loop writes no card |
| `--reviewer <agent>` | unset | the independent reviewer; unset disables dispatch, while verdicts in flight still apply |
| `--auto-accept-reviews=yes\|no` | yes | close a review card after applying its verdict; `no` leaves it for a human |
| `--acceptance <policy>` | `both` | `human-only` \| `both` \| `agent-only`; **advisory**, the board decides |
| `--workflow-max-actions <n>` | 20 | writes per workflow pass |
| `--review-aging-minutes <n>` | 60 | report a review card with no readable verdict this long |
| `--workflow-ledger <path>` | beside `--state` | workflow alert de-duplication ledger; an unreadable one suppresses nothing |
| `--subscribe` | off | run the SSE daemon; launchd/systemd only |
| `--event-continue=yes\|no` | yes | let events wake a continue turn |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--sla-peer <path>` | unset | peer inspector's last-ok marker; unset registers a dependency, not an alarm |
| `--notify <cmd>` | — | run `<cmd>` with each alert as JSON on stdin |

`--once` with no selector runs the legacy poll pass; installed units use
`--ping-only` / `--continue-only`. `--patrol-only` remains for legacy units.

## The workflow channel

The SLA rows are notify-only. The workflow pass is the only path that writes a
card, and the board decides what it writes: one plan from `issue
reconcile --workflow` (container reconcile, review outcomes, dispatch), which
the loop then executes.

A flow-A delivery that lands in `in_review` is dispatched to the configured
reviewer as a **review card**: an ordinary `kind=task` card with
`meta.review_of=<original>`, `meta.flow=B`, `meta.review_round=<round>` and the
label `review`. Detection reads the structural `review_of_id`, never the label.
Poll wakes the reviewer through the normal atomic claim; a dedicated reviewer
sees only review cards and never the public pool.

The reviewer reads the original's description, every acceptance item, the
current round's report, the comment trail and (for an epic) its children. Its
report on the review card must start with `VERDICT: APPROVE` or `VERDICT:
REJECT`. If the original carries `meta.acceptance_derived=yes`, the reviewer
checks that the list covers every requirement in the description and comment
trail; a narrowed list is grounds for `REJECT`.

The reviewer moves nothing. The loop is the acceptor:

| Verdict | The loop does |
|---|---|
| `APPROVE` (`both` / `agent-only`, or any child card) | note + `meta.accepted_by=loop-review` on the original, `in_review → done`; close the review card |
| `APPROVE` (`human-only`, top-level original) | **hold**: note + `meta.review_verdict=approve` / `review_verdict_round`; close the review card — the original stays `in_review` for the human |
| `REJECT` on a task | findings as a `kind=change` comment, `meta.rework_round=<new round>`, `in_review → in_progress → todo`; close the review card |
| `REJECT` on an epic | **first** create and link a fix child, then comment and reopen `in_review → in_progress`; the child stops `reconcile` from re-closing the container |

Rules that make it safe to run unattended:

- **One review card per (original, delivery round)** — idempotency key
  `loop-review|<ref>|r<round>`. A re-delivery after a rejection is a new round
  and is reviewed again.
- **Fail-safe** — an unreadable verdict, unseen original, round mismatch or
  conflicting verdict produces an alert and **no write**; the next pass retries.
- **The verdict is the reviewer's** — a report from anybody else is
  `review_report_not_by_reviewer` and is not applied.
- **A silent reviewer is reported** — an `in_review` review card with an
  unreadable verdict raises `verdict_unreadable`; a review card that is not
  `in_review` and has no readable verdict raises `review_aging` after
  `--review-aging-minutes`. The original's SLA row is suppressed while an
  **open** review card exists; a closed review card leaves the row as the
  original's watcher, so a canceled or done review cannot hide it.
- **The board enforces acceptance** — a refused writer gets
  `ACCEPTANCE_FORBIDDEN`; the loop leaves the review card in place and retries.
- **The review card is closed last** — a crash between the original's move and
  the card's close is recovered next pass.
- **A canceled review card ends `canceled`** — from `in_review` it takes the
  two-hop `in_review → in_progress → canceled`; the loop never records a
  canceled review as `done`.
- **A truncated board read dispatches nothing**, and a reviewer equal to the
  card's own assignee is refused (`self_review_not_independent`).

## Headless permission boundary

A wake is non-interactive, so the worker must run under a pre-declared boundary
— a tool allowlist, a permission mode, a sandbox. The generated glues ship
**no** permission bypass (no `--dangerously-skip-permissions`, no Codex
approval bypass). Enabling one is a deliberate act that needs written
authorization and must be documented at the point of use.

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
in the board's checkout, found through `MEERKAT_TASKPANEL_REPO` in the host
config. The body loads with no checkout present, but a *tick* needs the engine
reachable. Re-running `install.sh` after the checkout moves re-points the config
key; no unit reload is needed. This is the one remaining checkout dependency.
