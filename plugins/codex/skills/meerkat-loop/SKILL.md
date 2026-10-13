---
name: meerkat-loop
description: Run the host-external supervisor loop that keeps a Meerkat TaskPanel board moving — the 1-minute candidate scan, the atomic claim, the worker wake and the 5-minute patrol that Claude Code, Codex and Pi cannot run themselves because they have no timer. Installs launchd / systemd / cron units plus the per-host wake glue, carries the supervisor's execution body and its shared modules, and declares the board interface generation it requires. Install for claude / codex / pi only; OpenClaw runs the openclaw-team framework instead.
---

# Meerkat Loop

The **loop** is the part of Meerkat TaskPanel that runs when no agent is looking: a cheap
1-minute scan for claimable cards, an atomic claim, a wake that starts exactly one worker,
and a slower 5-minute patrol that escalates stale claims and reports unreadable
heartbeats. Claude Code, Codex and Pi have no clock and no timers — their hooks fire only
on session events — so the loop lives **outside** the host and the host is only ever the
worker that gets woken.

This skill is that loop, packaged so it can be installed and distributed on its own
(repository: [`meerkat-taskpanel`](https://github.com/tanyu216/meerkat-taskpanel)). The
board it drives is a *different* thing with a different lifecycle: see the
`meerkat-taskpanel` skill for the board itself.

> **Status.** Split out of the board skill (see `references/operation.md` §Why this is a
> separate skill). The executor, the unit templates and the wake glues are all here.

## Required board interface

```text
requires: board task-interface v1   — board release >= 1.0.0
```

The loop drives the board through the `taskctl` CLI (`issue candidates`, `issue move`,
`issue list`). Those commands are the `task-interface v1` surface, which the board first
shipped in release **1.0.0** — so the requirement is stated twice on purpose: as the
interface generation a reader reasons about, and as the release floor a machine can check.

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
  scripts/supervisor.mjs    the tick: scan → claim → wake → patrol
  scripts/wake-cwd.mjs      what the wake glue calls to resolve the card's directory
  src/shared/*.mjs          the shared modules those two import
templates/                what the installer renders (generated)
  scheduling/{launchd,systemd,cron}/   the units
  {claude,codex,pi}/wake-<host>.sh     the wake glue
  host/meerkat-taskpanel.env           the host config
```

`body/` and `templates/` are **generated** — by `node scripts/sync-skills.mjs` in the
repository this was split from, guarded by `--check`. Do not hand-edit them: edit
`scripts/supervisor.mjs`, `scripts/wake-cwd.mjs`, `src/shared/` or
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
