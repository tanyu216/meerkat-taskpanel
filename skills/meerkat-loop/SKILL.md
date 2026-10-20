---
name: meerkat-loop
description: Run the host-external scheduler that keeps a Meerkat TaskPanel board moving — a 60-second process-liveness ping, and a 10-minute `继续` judgment turn that wakes the host and runs the deterministic entries: the atomic claim and worker wake (poll), the notify-only SLA patrol, and the workflow pass that asks the board for the reconcile/review plan (`issue reconcile --workflow`), dispatches an independent reviewer for each delivered card, applies the reviewer's verdict and closes the review card. The SLA rows stay notify-only; the board decides the workflow plan and the loop applies it. Installs launchd / systemd / cron units plus the per-host wake glue, carries the scheduler's execution body, the loop entries and their shared modules, and declares the board interface generation it requires. Install for claude / codex / pi only; OpenClaw runs the openclaw-team framework instead.
---

# Meerkat Loop

The **loop** is the part of Meerkat TaskPanel that runs when no agent is looking. Its
scheduler owns two clocks:

| Clock | Cadence | Job |
|---|---|---|
| **ping** | 60s | prune worker-registry entries whose pid is gone. No board read, no claim, no LLM |
| **continue** | 600s (10 min) | wake the host with a bounded `继续` prompt; that turn runs the deterministic entries |

The deterministic entries are separate programs under `scripts/loop/`, not scheduled
units. The continue turn runs them in this order:

1. **patrol** — the notify-only SLA pass. It escalates stale claims, reports unreadable
   heartbeats, and covers the rest of the `PROTOCOL §⑮` timeout table. No alert moves a
   card, and no LLM turn starts by default.
2. **workflow** — the channel that writes. The **board** computes the plan
   (`issue reconcile --workflow`: container reconcile, review outcomes and dispatch);
   the **loop** executes it: an independent reviewer for each flow-A card awaiting
   acceptance, and the reviewer's `VERDICT:` report applied to the original. The review
   card is closed last. On by default; `--workflow=no` turns it off, and `--reviewer`
   enables dispatch at all.

   **Who it may close** follows the board's acceptance policy. The board is
   authoritative and decides it in the plan; `--acceptance` /
   `MEERKAT_TASKPANEL_ACCEPTANCE_POLICY` is this loop's advisory copy, used for
   diagnostics, not for the decision:

   | policy | top-level original | child card | review card |
   |---|---|---|---|
   | `human-only` | **hold** — record the verdict, close the review card, leave the card `in_review` | close | close |
   | `both` (default) | close | close | close |
   | `agent-only` | close | close | close |

   Under `agent-only` the board only requires a **non-human** writer; *which* agent
   applies the verdict is this deployment's business (the loop, an operator's own
   automation, the reviewer itself), not the board's. Under `human-only` a held
   approval is idempotent: the marker `review_verdict=approve` +
   `review_verdict_round` means a second pass rewrites neither the comment nor the
   marker, and only retries the review card's close. A worker still always stops at
   `in_review`; review cards are never held (the loop closes its own bookkeeping).
3. **poll** — the cheap scan, the atomic claim, and the wake that starts exactly one
   worker. Poll runs last so a review card dispatched by workflow in the same turn can be
   claimed and woken immediately.

Claude Code, Codex and Pi have no clock and no timers — their hooks fire only on session
events — so the loop lives **outside** the host and the host is only ever the worker that
gets woken. On launchd/systemd the optional **subscribe daemon** (`--subscribe`) holds one
SSE connection and asks for a continue turn when a dispatch-relevant event arrives; the
continue clock remains the fallback and the only path for time-based work. On cron,
discovery stays at most one continue cadence. `--continue-interval` is the lever for that
fallback.

This skill is that loop, packaged so it can be installed and distributed on its own
(repository: [`meerkat-taskpanel`](https://github.com/tanyu216/meerkat-taskpanel)). The
board it drives is a *different* thing with a different lifecycle: see the
`meerkat-taskpanel` skill for the board itself.

> **Status.** Split out of the board skill (see `references/operation.md` §Why this is a
> separate skill). The executor, the unit templates and the wake glues are all here.

## Required board interface

```text
requires: board task-interface v1   — board release >= 1.1.0
```

The loop drives the board through the `taskctl` CLI (`issue candidates`, `issue move`,
`issue list`, and `issue reconcile --workflow`). Those commands are the `task-interface v1`
surface, which the board first shipped in release **1.0.0**. This loop requires **1.1.0**,
the release that added the board-side workflow plan — so the requirement is stated twice on
purpose: as the interface generation a reader reasons about, and as the release floor a
machine can check.

**Gate check.** Before pointing a loop at a board, run:

```bash
node scripts/board-check.mjs                 # taskctl on PATH
node scripts/board-check.mjs --repo <checkout>
node scripts/board-check.mjs --json          # machine-readable verdict
```

It asks the board `taskctl --version --json` and refuses (exit 3) when the board's
declared version is below the floor, printing what it saw. What it proves is narrow and
worth stating: that a taskctl-shaped board answered, and that it is at least the release
whose CLI surface this loop was written against. It does **not** prove that every command
the loop calls still behaves the same way — that is a release-time concern, and the
compatibility matrix in `references/operation.md` is where it is kept.

## What is in here

```text
SKILL.md                  this file
references/operation.md   install, run, paths, permissions, compatibility
scripts/board-check.mjs   the interface gate above
body/                     the execution body (generated)
  manifest.txt              the file closure the body is closed under
  scripts/supervisor.mjs    the scheduler: ping + continue clocks, mode dispatch
  scripts/loop/options.mjs  the shared option surface (one parser for every entry)
  scripts/loop/runtime.mjs  registry, log, taskctl shell-out, SLA ledger, continue lock
  scripts/loop/runners.mjs  injected-dependency runners + worker/continue spawners
  scripts/loop/board.mjs    the real board reads and the SLA/workflow passes
  scripts/loop/poll.mjs     scan → atomic claim → wake a worker
  scripts/loop/patrol.mjs   notify-only SLA rows
  scripts/loop/workflow.mjs apply the board's workflow plan
  scripts/loop/continue.mjs one judgment turn (the `继续` wake)
  scripts/wake-cwd.mjs      what the wake glue calls to resolve the card's directory
  src/shared/*.mjs          the shared modules those import
  src/shared/sla-patrol.mjs   the PROTOCOL §⑮ rows: thresholds, tiers, tuple, ledger
templates/                what the installer renders (generated)
  scheduling/{launchd,systemd,cron}/   the units
  {claude,codex,pi}/wake-<host>.sh     the wake glue
  host/meerkat-taskpanel.env           the host config
```

`body/` and `templates/` are **generated** — by `node scripts/sync-skills.mjs` in the
repository this was split from, guarded by `--check`. Do not hand-edit them: edit
`scripts/supervisor.mjs`, `scripts/loop/`, `scripts/wake-cwd.mjs`, `src/shared/` or
`scripts/install/templates/` and regenerate. Anything else in this directory
(`SKILL.md`, `references/`, `scripts/board-check.mjs`) is authored here.

## Installing it

**An installer is the executor** — a skill cannot deploy a launchd / systemd / cron unit
by itself, and it should not try. In the repository this skill is authored in:

```bash
bash install.sh --target claude     # or codex, pi
bash install.sh --target all        # claude, codex, pi — and openclaw, which gets the board only
```

The installer copies this skill into the host's skill directory, copies the execution
body into `<host>/meerkat-taskpanel/`, renders the units and the wake glue, and prints the
one command that loads a unit — it never enables a daemon for you **unless you ask**:
`install.sh --supervisor=enable` (per host: `--supervisor-hosts claude,codex,pi`,
`--supervisor=disable` / `status`) is the opt-in path that runs that load, and it is
never a silent default. Full detail, with every path, is in
[`references/operation.md`](references/operation.md).

**OpenClaw is deliberately excluded.** `install.sh --target openclaw` installs the board
skill and nothing else: the [openclaw-team](https://github.com/tanyu216/openclaw-team)
framework already ships a per-agent poll and a `task-patrol` — this same design.
Installing both would be two supervisors racing one board. Its cadence is deliberately not
repeated here: the framework's own `AUTOMATIONS.md` is the single source of truth for it,
and a number copied into this file is a number that drifts.

## See also

- [`references/operation.md`](references/operation.md) — install, the exact paths, the
  headless permission boundary, and the compatibility matrix.
- [The scheduling design](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/scheduling.md) —
  the host-agnostic statement of the loop, its cost gate and its atomic-claim dispatch.
- The **`meerkat-taskpanel`** skill — the board this loop drives. The installer for the
  three loop hosts installs it alongside this one; it is a separate skill with its own
  release, and this file's *Required board interface* section is the contract between them.
