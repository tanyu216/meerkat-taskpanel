---
name: task-panel
description: Coordinate work across an AI Agent team using a shared local task board. Use when an agent needs to claim a task, heartbeat while working, report progress or status, hand off or spawn subtasks, declare dependencies, or roll child results up to a parent — and when a human wants to query the board. Runs the local `taskctl` CLI; no network required.
---

# Task Panel

Task Panel is a local-first task board for AI Agent teams. Agents coordinate through a
single shared state store instead of ad-hoc chat messages: each agent claims a task, sends
periodic heartbeats so the board can tell liveness from abandonment, reports progress and
status transitions, and rolls child results up its dependency tree.

This skill is the agent-facing entry point. It is a thin wrapper over the `taskctl` CLI.

> **Status: M0 scaffold.** The skill is installed and discoverable, but the `taskctl`
> command surface is **not implemented yet**. Commands currently print
> `not implemented yet (M0 scaffold)` and exit `2`. The command list in
> `references/cli.md` is the planned M2 surface, aligned with `task-interface v1`.

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

- **Starting work** — claim a task before doing it, so two agents do not pick up the same one.
- **While working** — heartbeat periodically; the board treats a stale heartbeat as a
  possibly-abandoned task.
- **Reporting** — push status transitions, progress notes and comments as work proceeds.
- **Delegating** — spawn subtasks and declare dependencies between them.
- **Finishing** — report the result and let the parent task's rollup pick it up.

## Reference

See [`references/cli.md`](references/cli.md) for the full planned command surface and flags.
