# 0013 — The role catalog is a local `taskctl` file; the scan set is the discovered roles

> **Note (2026-11-03):** the scan set is now the **full discovered set** — every worker-lane and
> every reviewer-lane role. There is no configured or deployment reviewer to add: the review
> card's assignee is the catalog's `default_reviewer`. The decision — the catalog is
> a local `taskctl` file and discovery is the claim set — is unchanged.

## Status

Accepted — 2026-11-03.

## Context

ADR 0007's discovery answered *which kind runs a role*, but two consumers still had no stable
answer to *which roles exist*: a human or the `meerkat` skill creating a card had to re-derive
the assignee range from the filesystem, and the loop's claimable identities were controlled by
`MEERKAT_TASKPANEL_AGENTS`, a hand-kept list that could contradict the installed skills. A role
moved to a kind the list did not mention was silently unclaimable.

## Decision

- The supervisor publishes the role set it discovered — the exact set it routes with — through
  `taskctl role sync --file -` (payload on stdin). The command writes
  `<config root>/roles.json` atomically, as a **full replacement**; identical content is a no-op
  and keeps the stored `updated_at`. The poll calls it on every tick, including a tick that
  returns early for a missing resident pool, and a failure is logged without blocking a claim.
- The file is a **local projection, never board state**. `taskd` learns no roles: there is no
  table, migration, route or event, and no multi-machine overwrite to design around. It is
  gitignored and dockerignored like `projects.json`.
- `taskctl role list` reads it. It is the valid `assignee` range for the `meerkat` skill and the
  director, and the surfaced list for a human.
- `issue create` and `issue assign` check the assignee against a non-empty catalog before the
  HTTP call (`ASSIGNEE_NOT_IN_CATALOG`). Skipped when the catalog is absent/empty/malformed
  (bootstrap), when `--assignee-id` is used, for an explicit human assignee, when there is no
  assignee, and with `--force-create` (the documented escape). The guard looks at the
  **assignee**, never the writer.
- `MEERKAT_TASKPANEL_AGENTS` is removed. The loop's claim set is every discovered worker-lane
  role plus the configured reviewer(s). `opts.agents` remains the loop's **writer** identity
  (`--agent` / `TASKCTL_AGENT` / OS user), and each scheduling unit renders `--agent <name>` so
  a service-manager start keeps it.

## Why

- One discovery authority: the supervisor already holds the set it will route with; asking
  `taskctl` to re-scan could name a different `home` or kind order than the running loop.
- A file is the smallest projection that survives across processes and surfaces, and the
  atomic full replacement makes the sync idempotent and self-healing.
- The board must not learn roles: roles are a host-local, install-time fact, and teaching the
  schema would buy a migration, an event stream and a cross-machine conflict for a read-only
  convenience.
- The assignee guard closes the gap where a typo silently strands a card. It lives at the CLI
  because that is where every supported surface writes; a direct HTTP client bypasses it by
  design, and that trade is accepted.

## Considered options

- **Board-side role table.** Rejected: no board semantics need it, and it would create a second
  source of truth and a multi-machine overwrite problem.
- **Keep `MEERKAT_TASKPANEL_AGENTS` as the scan set.** Rejected: it duplicated discovery, and
  its one unique case — a custom identity with no role skill — is exactly the case the model
  says is not a claim identity.
- **Have `taskctl` re-scan on sync.** Rejected: a different `home`/kind order would publish a
  set the supervisor does not actually route with.
- **A hash state file to skip unchanged syncs.** Deferred: one small CLI spawn per tick is not
  worth a second local state file until a measurement says otherwise.

## Consequences

- A custom board identity (`--agent-name alice`, no `role.json`) can write but is never scanned;
  the workaround is a role skill. This is the model, stated in the docs.
- The catalog can be stale until the next tick (default 600 s). A role removed after the last
  sync can still be named; the supervisor's `assignee_not_scanned` reporting then surfaces the
  stranded card.
- The catalog is per machine. A session on another machine, or a remote board, has its own file
  or none and falls back to the open range.
- Adding a new `DomainError` code is CLI-only but still joins `ERROR_CODES` and the API
  snapshot's error vocabulary; no route changes.
