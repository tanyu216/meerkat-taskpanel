---
name: task-panel
description: Coordinate work across an AI Agent team using a shared local task board. Use when an agent or a human needs to create and track tasks, move them through a status workflow, assign owners, comment on a decision, link parent/child and blocking relations, record which agent session is working on what, deliver a task with a report, write a periodic (daily / weekly / monthly) report with statistics over completed work, or export the board as markdown. Runs the local `taskctl` CLI; no network required.
---

# Task Panel

Task Panel is a local-first task board for AI Agent teams. Agents coordinate through a
single shared state store instead of ad-hoc chat messages: each agent claims a task, sends
periodic heartbeats so the board can tell liveness from abandonment, reports progress and
status transitions, and rolls child results up its dependency tree.

This skill is the agent-facing entry point. It is a thin wrapper over the `taskctl` CLI.

> **Status: M2.** The command surface is implemented and aligned with `task-interface v1`.
> `taskctl` is an HTTP client for `taskd`, the local board service, and starts one
> when there is none (set `TASKD_NO_AUTOSTART=1` to forbid that). See
> `references/cli.md` for the full surface, the delivery gate and the `--json` contract.

## Running the CLI

From this skill's directory:

```bash
node scripts/run.mjs --help
node scripts/run.mjs --version
```

`scripts/run.mjs` resolves the repository root relative to itself and spawns
`src/cli/index.mjs`, piping stdin/stdout/stderr and propagating the exit code — so it works
regardless of the current working directory.

If `taskctl` is on your `PATH` (installed via `install.sh` or `npm link`), call it directly:

```bash
taskctl --help
```

## When to use it

- **Finding the board** — `taskctl context current` says which project owns this directory.
- **Starting work** — `taskctl issue list` to see what is open, then
  `taskctl issue move <id> in_progress`.
- **Asking for something** — `taskctl issue create --project <id> --title "…" --acceptance "…"`.
- **While working** — `taskctl comment add <id> --body "…"`; a `decision`/`change`
  comment is what a reviewer reads later.
- **Delegating** — `taskctl issue create --kind epic …` plus
  `taskctl relation add <parent> --type parent --target <child>`.
- **Finishing** — `taskctl report template <id>` to get a report, fill in the TODO
  lines, then `taskctl issue deliver <id> --report-file -`. **The board will not let a
  task into `in_review` without a report** for the current round: the refusal prints the
  exact command that fixes it.
- **Reporting on a period** — `node scripts/report.mjs --period daily|weekly|monthly`
  builds a daily/weekly/monthly report plus its statistics from the cards completed in
  the window. `--group-by` picks the dimension (`kind` by default, or `project` /
  `assignee` / `status` / `label:<namespace>`); `--preset <name>` adds named metrics —
  the shipped `software` preset is one example, and the statistics are domain-agnostic.
  The templates, the counting rules and how to define your own metrics live in
  [`references/reports.md`](references/reports.md).

## Reference

See [`references/cli.md`](references/cli.md) for the command surface, the delivery gate,
the report template and the `--json` contract, and
[`references/reports.md`](references/reports.md) for periodic reports and statistics.
