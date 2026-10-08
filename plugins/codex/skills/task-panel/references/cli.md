# `taskctl` CLI reference

> **Status: planned (M2).** Nothing below is implemented in the M0 scaffold. This document
> describes the intended command surface so the skill, the MCP server and the HTTP API can
> be designed against it. The surface is aligned with **`task-interface v1`**.

Global form:

```bash
taskctl <command> [options]
```

`--help` prints usage, `--version` prints the version. Both already work in the scaffold.

## Commands (planned, M2)

| Command | Purpose |
|---|---|
| `claim <task-id>` | Atomically take ownership of a task. Fails if already claimed by another live agent. |
| `heartbeat <task-id>` | Mark the task's owner as still alive; refreshes the liveness timestamp. |
| `status <task-id> <status>` | Transition a task's lifecycle status (validated by the core state machine). |
| `progress <task-id> <note>` | Append a progress note without changing status. |
| `comment <task-id> <text>` | Attach a free-form comment to a task. |
| `report <task-id> <result>` | Record a task's final result payload. |
| `session-id` | Print the current agent session identifier. |
| `session-set <id>` | Bind this process to a given session identifier. |
| `session-close` | Close the current session and release its claims. |
| `spawn <parent-id> <title>` | Create a child task under a parent. |
| `depend <task-id> <depends-on-id>` | Declare that one task depends on another. |
| `children <task-id>` | List a task's direct children. |
| `deps <task-id>` | List a task's dependencies. |
| `rollup <task-id>` | Aggregate child results/status into the parent. |
| `query [filters]` | Query the board (by status, agent, parent, tag, …). |
| `read <task-id>` | Read a single task's full record. |

## Notes

- All commands are **local** — they read and write the local SQLite board at
  `.data/taskboard.sqlite`. No network access is required or performed.
- Every command that mutates state is expected to be safe under concurrent agent access
  (the M1 core owns that guarantee, not the CLI).
- Output is intended to be machine-readable (JSON) when `--json` is passed; the human
  default is a compact table.
