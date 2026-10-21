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

node <host>/meerkat-taskpanel/scripts/loop/passes.mjs patrol   --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/loop/passes.mjs workflow --host claude --agent alice
node <host>/meerkat-taskpanel/scripts/loop/passes.mjs poll     --host claude --agent alice
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
| `--reviewer <agent>` | unset | the deployment reviewer. A project's `reviewer` overrides it; unset disables dispatch for projects without one, and a `required` project with no effective reviewer fails startup. Verdicts in flight still apply. |
| `--auto-accept-reviews=yes\|no` | yes | close a **review card** after applying its verdict; `no` leaves it for a human. It does not gate auto-accepting a no-review original. `agent-only` + `no` is refused at startup (nobody could close a review card). |
| `--acceptance <policy>` | `both` | `human-only` \| `both` \| `agent-only`; **advisory**, the board decides |
| `--workflow-max-actions <n>` | 20 | writes per workflow pass |
| `--review-aging-minutes <n>` | 60 | report a review card with no readable verdict this long |
| `--workflow-ledger <path>` | beside `--state` | workflow alert de-duplication ledger; an unreadable one suppresses nothing |
| `--subscribe` | off | run the event subscriber (`taskctl events tail`); launchd/systemd only |
| `--event-continue=yes\|no` | yes | let events wake a continue turn |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--sla-peer <path>` | unset | peer inspector's last-ok marker; unset registers a dependency, not an alarm |
| `--notify <cmd>` | — | run `<cmd>` with each alert as JSON on stdin |

`--once` with no selector runs the legacy poll pass; installed units use
`--ping-only` / `--continue-only`. `--patrol-only` remains for legacy units.

## The workflow channel

The SLA rows are notify-only. The workflow pass is the only path that writes a
card, and the board decides what it writes: one plan (container reconcile,
review outcomes, auto-accept, dispatch), which the loop then executes. The exact
invocation and every action field are the board skill's capability contract
(`references/capabilities.md` §6–7); the review-card shape and its structural
identity are `references/review-workflow.md` in the same skill.

A flow-A delivery that lands in `in_review` **whose `review_required` snapshot
is 1** is dispatched to the configured reviewer as a **review card**. The
reviewer is `project.reviewer ??` the deployment reviewer. Poll wakes every
configured reviewer through the normal atomic claim; a dedicated reviewer sees
only review cards and never the public pool.

A card at `review_required = 0` gets no review card. The plan carries
`auto_accept`, and the loop applies it only when `taskd` may accept the card's
scope under the board policy; under `human-only` a top-level card is left for
the human (`auto_accept_skipped`, reason `human_only`), while a child still
auto-accepts. `autoAcceptReviews` does not gate this path — it only controls
whether the loop closes a review card.

The reviewer reads the original's description, every acceptance item, the
current round's report, the comment trail and (for an epic) its children. Its
report on the review card must start with `VERDICT: APPROVE` or `VERDICT:
REJECT`. If the original carries `meta.acceptance_derived=yes`, the reviewer
checks that the list covers every requirement in the description and comment
trail; a narrowed list is grounds for `REJECT`.

The reviewer moves nothing. The loop is the acceptor:

| Verdict | The loop does |
|---|---|
| `APPROVE` (`both` / `agent-only`, or any child card) | record the acceptance on the original, move `in_review → done`; close the review card |
| `APPROVE` (`human-only`, top-level original) | **hold**: record the verdict on the original; close the review card — the original stays `in_review` for the human |
| `REJECT` on a task | findings as a `kind=change` comment, start a new rework round, `in_review → in_progress → todo`; close the review card |
| `REJECT` on an epic | **first** create and link a fix child, then comment and reopen `in_review → in_progress`; the child stops the board's reconcile from re-closing the container |

Rules that make it safe to run unattended:

- **One review card per (original, delivery round)** — idempotency key
  `loop-review|<ref>|r<round>`. A re-delivery after a rejection is a new round
  and is reviewed again.
- **Fail-safe** — an unreadable verdict, unseen original, round mismatch or
  conflicting verdict produces an alert and **no write**; the next pass retries.
  On a truncated board read, `original_unseen` carries `reason: board_truncated`
  and `undecidable: true` with its own ledger key: the original may sit below
  the read cap.
- **A combined cap is reported** — when the outcome+auto-accept+dispatch slice
  drops work, the plan carries `actions_capped` (cap / dropped / outcomes /
  auto_accept / dispatch) and it is notified once per cap. `dispatch_capped`
  remains the log-only signal for a dispatch-only overflow.
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
- **A dead configuration is named** — `acceptance=agent-only` with
  `auto_accept_reviews=no` leaves review cards with no writer who may close them.
  The board reports each open one as `review_cards_unclosable` (notified once per
  ledger key) and the loop prints a startup warning; the fix is auto-accept on or
  a non-human writer.
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
