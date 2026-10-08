# `src/core`

The engine of Task Dashboard. It owns the domain model and everything that can be
expressed without knowing which surface called it — so the CLI, MCP server and HTTP API
are all thin adapters over this module.

In M1+ this is where the task/agent domain model, the SQLite repository (local database at
`.data/taskboard.sqlite`), the task lifecycle state machine, and the domain invariants and
migrations live. It must not import from `cli/`, `mcp/` or `server/`; it may only depend on
`src/shared`.
