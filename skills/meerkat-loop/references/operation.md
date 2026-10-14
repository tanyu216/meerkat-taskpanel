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
| execution body | `<host>/meerkat-taskpanel/scripts/supervisor.mjs` + `.../scripts/wake-cwd.mjs` + `.../src/shared/*.mjs` | the copy the units run; its closure is listed in this skill's `body/manifest.txt` |
| units | `<host>/scheduling/{launchd,systemd,cron}/` | `StartInterval` 60 (poll) and 300 (patrol) units. Each names the **absolute `node`** it was rendered with and carries a **`PATH`** (host CLI's directory + node's, then the scheduler's default) — a scheduler runs a unit with a minimal `PATH` that has neither, so `env node` is exit 127 and the wake glue's `exec claude` fails on it too |
| wake glue | `<host>/bin/wake-<host>.sh` | resolves the card's project directory from the skill's `projects.json`, then runs `claude -p` / `codex exec` / `pi --print` |
| host config | `<host>/meerkat-taskpanel.env` | the claim-unassigned policy, and `MEERKAT_TASKPANEL_REPO` — where the board engine lives |
| runtime | `<host>/meerkat-taskpanel/{supervisor.log,supervisor.state.json}` | the tick log and the running registry |

`--link` applies to the **board** skill only. The loop is always copied: a symlinked body
would reintroduce exactly the checkout dependency this split removes.

Nothing is loaded for you **unless you ask**. The installer prints the command, and loading
a daemon is the operator's call:

```bash
# macOS
launchctl load ~/.claude/scheduling/launchd/com.meerkat-taskpanel.poll.plist   # and .patrol.plist
# Linux (user units)
mkdir -p ~/.config/systemd/user && cp ~/.claude/scheduling/systemd/* ~/.config/systemd/user/
systemctl --user enable --now meerkat-taskpanel-poll.timer meerkat-taskpanel-patrol.timer
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
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --host claude --agent alice --once
node <host>/meerkat-taskpanel/scripts/supervisor.mjs --agent alice --dry-run --once
```

A bare `node` is right *here*, because you are in your own shell and it is your `PATH` that
answers. The units cannot make that assumption (see the `units` row above), which is why
they name an absolute interpreter and set their own `PATH`.

| Flag | Default | Meaning |
|---|---|---|
| `--agent <name>` | `$TASKCTL_AGENT` → `$USER` | agent(s) to work for; repeatable / comma-separated |
| `--host claude\|codex\|pi` | `claude` | which worker to wake |
| `--repo <path>` | the host config's `MEERKAT_TASKPANEL_REPO` | where `--cli` is resolved from, and the fallback working directory |
| `--poll-interval <sec>` / `--patrol-interval <sec>` | `60` / `300` | loop cadences |
| `--max-concurrency <n>` | `8` | cap on simultaneously running workers |
| `--claim-unassigned=yes\|no` | from the host config → `yes` | also claim unassigned cards (the public pool) |
| `--once` / `--patrol-only` | off | one tick (for cron / launchd / systemd); patrol pass only |
| `--notify <cmd>` | — | run `<cmd>` with each patrol alert as JSON on stdin (the legacy heartbeat alert and the SLA tuple) |
| `--dry-run` | off | print intended actions; claim nothing, spawn nothing |
| `--sla-ledger <path>` | `sla-ledger.json` beside `--state` | the SLA de-duplication ledger; an unreadable one suppresses nothing |
| `--sla-leader <id>` | `$MEERKAT_TASKPANEL_SLA_LEADER` → unset | the author id the leader writes under (the `leader_stalled` attribution set); unset ⇒ the board's decision authority (`author_kind = "human"`) |
| `--sla-last-ok <path>` | `loop-patrol-last-ok.json` beside `--state` | this mechanism's own last-successful-run marker, for the peer's watchdog |
| `--sla-peer <path>` | `$MEERKAT_TASKPANEL_SLA_PEER` → unset | the peer inspector's last-ok marker; stale ⇒ `inspector_liveness`. Unset ⇒ a registered dependency, no alarm |
| `--board-limit <n>` / `--trail-limit <n>` | `500` / `200` | caps on the two reads one patrol pass makes |

The full table, and the tick's flow, are in the repository's `docs/scheduling.md`.

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
