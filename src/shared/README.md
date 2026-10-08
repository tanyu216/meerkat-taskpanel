# `src/shared`

Shared DTOs, type shapes, constants and small pure helpers used by more than one surface
(`src/core`, `src/cli`, `src/mcp`, `src/server` and the `web/` frontend).

In M1+ this module owns the vocabulary that every surface agrees on: task/agent shapes,
status and priority enums, the `task-interface v1` payload schemas, ID formats, and the
constants exported from `constants.mjs`. Nothing here may import from `src/core` — the
dependency direction is `core/cli/mcp/server → shared`, never the reverse.
