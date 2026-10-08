# `src/core`

The engine of Task Panel. It owns the domain model and everything that can be
expressed without knowing which surface called it — so the CLI, MCP server and HTTP API
are all thin adapters over this module.

M1 lands the whole of it: the domain model (`domain/`), the SQLite repository and
migrations (`storage/`, local database `.data/board.sqlite`, overridable with `TASKD_DB`),
the use-cases (`commands/`), the md card migrator (`storage/md/`, runnable as
`node src/core/storage/md/migrate-cli.mjs`) and `openBoard()` in `bootstrap.mjs`.

Rules that are enforced, not just documented:

* `domain/` imports no Node builtin at all (`test/core/domain/purity.test.mjs`);
* nothing here imports `cli/`, `mcp/` or `server/` — the dependency direction is
  `cli|mcp|server → core → shared`;
* every failure is a `DomainError` with a code, never a bare `Error`;
* the delivery gate is a database trigger *and* a domain check, and the two are
  tested against each other (`test/contract/`).
