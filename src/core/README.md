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

## Creation idempotency (the main gate is you, the creator)

Two agent turns can race to create the same card. The defence has two layers,
and the ordering matters: the mechanical key below is a **backstop**, not the
gate. L1 reading: `PROTOCOL §㉙` + `guides/task-interface.md §14`.

**1 — Main gate: read before you create (semantic, an LLM does it).** Before
creating a card, the creator reads the existing **non-terminal** cards —
`taskctl issue list` — and decides whether the *intent* is already covered.
If it is, do **not** create: reuse the existing card. No mechanical rule can see
intent, so this step cannot be delegated to the key.

**2 — Backstop: the idempotency key (mechanical).** `domain/idem.mjs` derives

```text
idem = <kind> | <assignee> | <source> | <target>
```

(fields `String(x).trim()`, one space around each `|`; `source` is `review_of`,
else `parent`, else `""`). When a create carries a key and a **non-terminal**
task already holds it, the create is **refused and the existing task is
returned** — its `id`/`identifier` *is* the answer — with no new row and no new
activity. Terminal cards (`done`/`canceled`) **release** the key, so the same
work can be created again later. `--allow-dup` writes `NULL` and bypasses the
guard entirely.

The key deliberately **does not look at the title**: a match means "the same
card was submitted twice", not "these are conceptually the same task". A generic
card with no assignee/source/target derives no key at all, so two ordinary cards
never refuse each other.

**The machine guarantee.** The read above is a race; the arbiter is the partial
unique index `ux_tasks_idem_active` (`storage/migrations/0009_task_idem.sql`),
which covers only non-terminal rows and lets `NULL` rows collide. A lost race
surfaces as `IDEM_EXISTS` and `commands/tasks.mjs#createTask` converges onto the
existing row (or re-throws if there is genuinely nothing to reuse).
