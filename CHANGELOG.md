# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **API contract snapshot.** `scripts/verify/contract.mjs` freezes the surface a client
  binds to — routes and each route's **declared request shape** (`{query, body}`, down to
  `type`/`enum`/`items`/`anyOf`, recursively), error codes, the wire field names **and
  types**, and each MCP tool's full `inputSchema` — as the committed, deterministic JSON
  at `test/fixtures/contract/api.snapshot.json`. It compares the live surface against that
  snapshot and exits non-zero on drift; `--update` refreshes it. A changed argument **type
  or enum**, a route request field retyped or dropped, or a wire field whose type moved,
  now fails the gate instead of slipping through. The snapshot's `schema_version` is **3**.
  It runs in `pre-push` (every push) and `pre-tag`, in `contract-gate.yml` (every branch
  push / PR) and at tag time in `version-gate.yml`, and inside the container suite. The
  route request schemas are declared (in `src/server/requests.mjs`, beside each route),
  not enforced — the handlers read their requests as before. See
  [`docs/contract.md`](docs/contract.md).
- **Route-request lint.** The snapshot freezes each route's *declared* request schema,
  but nothing proved the declaration was what the handler actually reads — the
  declaration is a second description of the request, and a handler that starts reading
  a field the declaration omits (or a declared field nothing reads) does not move the
  snapshot. `scripts/verify/route-request.mjs` closes that at the mechanism level: it
  reads every route's handler **source**, statically extracts the query and body fields
  it reads (`query.get("x")`, `body.x`, `body["x"]`, `body[x]` over a literal loop,
  `const { x } = body`) and compares them against the declaration in both directions —
  `undeclared_read`, `unread_declaration`, `unresolvable_read`, `stale_refusal`,
  `uncovered_endpoint`. A read form it cannot resolve is a **failure**, not a shrug: the
  lint refuses to pass a route it cannot prove, so a new form is a red gate rather than a
  silent hole. The one read a name-matching lint cannot reconcile — `PATCH
  /api/v1/tasks/:ref` reads `body.status` only to refuse it, and the declaration correctly
  omits it — is an explicit, checked entry in `REFUSED_READS`; the entries go stale (and
  go red) on their own if the field is declared, unread, or its route is gone.
  `test/verify/route-request.test.mjs` is the red→green proof over synthetic handlers,
  touching no `src/`. It runs in `pre-push`/`pre-tag`, in `contract-gate.yml`, and inside
  the container suite.
- **Scheduling & patrol.** A host-external supervisor (`scripts/supervisor.mjs`) runs the
  cheap 1-minute **poll** (a $0 candidate scan; an LLM turn starts only when a card is
  actually claimed) and the 5-minute **patrol** (escalate a stale claim; report an
  unreadable heartbeat, never silently). The atomic claim is the only dispatch source, so
  wakes are idempotent and capped by a concurrency limit. The design is in
  [`docs/scheduling.md`](docs/scheduling.md).
- **Host scheduling units.** `install.sh` drops launchd / systemd / cron units and a
  per-host wake script (`claude -p` + `--resume`, `codex exec`, `pi run`) for Claude Code,
  Codex and Pi, prints the exact load command, and never enables a daemon. OpenClaw gets
  none — it uses the [openclaw-team](https://github.com/tanyu216/openclaw-team)
  framework's own poll/patrol, which are this design.
- **The claim-unassigned question.** `install.sh` asks once (TTY only, default yes)
  whether the supervisor may claim unassigned cards, and persists the answer to
  `<host>/meerkat-taskpanel.env` as `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED`; `--claim-unassigned=yes|no` and
  `--assignee-only` work non-interactively.
- **`issue candidates --include-unassigned`** — the poll read now optionally adds the
  unassigned public pool (the supervisor's `claim_unassigned` policy).

### Changed

- **Renamed to `meerkat-taskpanel`.** <!-- legacy-name-compat: quotes the former name to record the migration --> Every naming surface moved off the former `task-panel` / `TaskPanel` spellings — the npm package name and the MCP bin (`meerkat-taskpanel-mcp`), the skill source and its generated plugin copies (`skills/meerkat-taskpanel/`), the plugin + marketplace manifests, the installer environment variables (`MEERKAT_TASKPANEL_*`), the host config file (`<host>/meerkat-taskpanel.env`), the launchd / systemd / cron units, the per-user runtime directory (`Application Support/MeerkatTaskPanel/`, `~/.meerkat-taskpanel/`), the Docker image and compose project names, the Prometheus rules file and metric namespace, and the `web/` localStorage keys. The CLI keeps its name: `taskctl`.
- **Backward compatibility.** The installer still accepts the pre-rename `TASKPANEL_*` environment variables, and the supervisor still reads a legacy `TASKPANEL_CLAIM_UNASSIGNED` key in the host config file; the new `MEERKAT_TASKPANEL_*` spelling wins when both are set.
- **Migration.** Re-run `install.sh` to write the new paths. The previous npm bin alias for the MCP server is not retained — an existing MCP registration points at the server by path, so it keeps working — and a runtime pointer written under the former per-user directory is not read; the CLI writes a fresh one on first run.

### Fixed

- **`scripts/verify/install-e2e.sh` no longer fails its own claim.** The script acted as
  `TASKCTL_AGENT="install-e2e"` but assigned its card to `install-e2e-bot`, and the claim
  policy only lets the assignee claim a card — so the run died on `not_assignee` at
  `issue move … in_progress`. Actor and assignee now come from one variable, so they cannot
  drift apart again.
- **The install + first-run end-to-end is now a step of
  `docker/verify-in-container.sh`.** It had been a separate `docker run` in CI only, which
  meant `npm run verify:docker` could be green while the CI `docker` job was red. Both
  tracks now run the same script; the CI job's duplicate step is gone.

## [1.0.0] - 2026-10-09

The first release. The engine has landed through **M6**: the core domain model, the
`taskctl` CLI and its local `taskd`, the stdio MCP server, the four-host installer, the
markdown migrator, and the full board HTTP API + SSE backend with the `web/` frontend.

### Milestones

- **M1 — core engine.** `src/core/`: the domain model, the SQLite repository and
  migrations (Node's built-in `node:sqlite`), the task state machine, and the invariants
  pushed down into database triggers, exposed through `openBoard()`.
- **M2 — CLI and local service.** `src/cli/`: the `taskctl` command surface (`project`,
  `issue`, `comment`, `relation`, `session`, `report`, `export`, `token`, `labels`,
  `assignees`, `reporters`, `context`), and the minimal loopback `taskd` the CLI
  auto-starts (`TASKD_NO_AUTOSTART=1` disables it).
- **M3 — MCP server.** `src/mcp/`: a stdio MCP server exposing 18 frozen tools as a thin,
  gate-equivalent proxy to `taskd`. `task_deliver` is the only tool that reaches
  `in_review`.
- **M4 — installers.** `install.sh` and `scripts/install/<host>.sh`: install the skill for
  Claude Code, OpenClaw, Codex and pi, with comma-separated targets and a per-host
  summary.
- **M5 — markdown migrator.** `src/core/storage/md/` and
  `node src/core/storage/md/migrate-cli.mjs`: import/export board cards as markdown, with
  a reconcile and post-import invariants check.
- **M6 — board API and frontend.** `src/server/`: the full board HTTP API and its SSE
  event stream, serving the `web/` board frontend (Vue 3 + Vite) built to `web/dist`.

### Added

- **A delivery gate with evidence.** A card can only reach `in_review` with a report for
  the *current* delivery round, enforced both in the domain layer and by a database
  trigger. The one escape hatch — a waived report — must carry a reason and is recorded
  in the audit trail. The MCP surface is stricter still: `task_move` carries no waiver, so
  `task_deliver` is the only tool that can reach `in_review`.
- **Dependencies and epics as first-class edges.** `depends_on` links form a DAG so
  independent work runs in parallel; parent/child links roll a subtree's progress up into
  its epic.
- **Sessions that resume.** Every agent session gets a deterministic id derived from
  `task + owner + segment`, so reconnecting reuses the same session.
- **An append-only audit trail.** Comments, reports and activities are append-only.
- **Local-first, zero runtime dependencies.** A single SQLite file is the only
  persistence; the engine (`src/core`, `src/cli`, `src/server`, `src/mcp`), every script
  and every test use Node builtins only and run fully offline.
- **One board, many front doors.** A `taskctl` CLI, a stdio MCP server (18 tools), and the
  local `taskd` HTTP API + SSE stream, with skill/plugin installers for Claude Code,
  Codex, OpenClaw and pi.
- **A read-only board frontend.** The `web/` Vue 3 board (kanban, task drawer, epic
  roll-up) is served by `taskd` from `web/dist`; it renders state, it does not edit it.
- **Long-running agent support.** Heartbeats set a freshness window on a claim; claims
  go stale for their own holder after 30 minutes and for everyone after 6 hours, so a
  crashed agent never wedges a card.
- **Release tooling.** `scripts/verify/version.mjs` (the six-manifest version contract),
  `scripts/release/pack-manifest.mjs` (npm tarball content check), and
  `scripts/verify/install-e2e.sh` (containerised install + first-run end-to-end).

### Changed

- Version promoted from the `0.0.0` scaffold placeholder to `1.0.0`, kept identical across
  the six shipped manifests (`package.json`, `plugins/pi/package.json`,
  `plugins/{claude,codex}/*/plugin.json`, `plugins/openclaw/openclaw.plugin.json`,
  `.claude-plugin/marketplace.json`) and now checked in CI.
- The release pipeline: on a `v*` tag, `.github/workflows/release.yml` builds the frontend
  and release tree, runs `npm pack`, verifies the tarball's contents, and opens a **draft**
  GitHub Release. It previously did a packaging dry run only.

[Unreleased]: https://github.com/tanyu216/meerkat-taskpanel/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v1.0.0
