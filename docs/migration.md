# Migrations

The board has one migration gate (its SQL schema) and one past surface removal
(the MCP integration).

## The append-only migration gate

The schema is built by numbered SQL files applied once, in order, by
`src/core/storage/migrations-runner.mjs`. The history is **append-only** and each
file's SHA-256 (line endings normalised) is recorded in the `schema_migrations` table;
at startup the runner refuses a database whose applied file has since changed
(`MIGRATION_CHECKSUM_MISMATCH`). That verdict only fires at *runtime*, against a
database that already applied the old file.

The **pre-commit hook** (`.githooks/pre-commit`) moves the same verdict to the earliest
possible point. It runs `scripts/verify/migrations.mjs`, which reuses the runner's own
`checksumFor`, so the gate and the database can never disagree:

```bash
node scripts/verify/migrations.mjs                 # this checkout (git HEAD baseline)
node scripts/verify/migrations.mjs --dir <dir>     # another tree
node scripts/verify/migrations.mjs --no-git        # numbering/name checks only
```

It refuses, with a non-zero exit:

| Violation | Why |
|---|---|
| a file not named `NNNN_lower_snake_name.sql` | the runner would reject it anyway (fail fast) |
| a **duplicate** version | two files claim the same slot |
| a **gap** in the numbering (`0001`, `0003`) | the sequence is not contiguous from `0001` |
| a **changed** already-committed file | checksum drift against the committed baseline — append a new file instead |
| a **deleted** already-committed file | history would no longer be reconstructable |

The checksum/deletion rules compare the working tree against git `HEAD`; with no history
to compare against (a stripped checkout, the image — which ships no `.git`) the check
degrades to the numbering/name rules rather than failing. The same script runs in CI via
`npm run check` (it is part of `npm run verify`) and therefore inside the container job
of `.github/workflows/check.yml`.

## Separate migration: the MCP integration is gone

**The MCP integration has been removed — agent integration is skill-only.** The stdio MCP
server (the `meerkat-taskpanel-mcp` bin, `src/mcp/**`), the installer's MCP registration
and the API contract snapshot's tool section (which moves `schema_version` 3 → 4) are
gone.

A host left with a registration should drop it — `claude mcp remove meerkat-taskpanel`,
`codex mcp remove meerkat-taskpanel`, or the matching entry in OpenClaw's or Pi's MCP
configuration. Nothing else changes: the skill drives the `taskctl` CLI directly, and the
board's HTTP API, CLI and delivery gate are untouched. So an existing board needs no data
migration at all — this is a surface removal, not a schema change of the board itself.
