# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The contract `schema_version` is readable from the CLI — the version leg.**
  A client could compare wire *fields* against the contract, but there was no way
  to read the provider's declared contract **generation** at runtime: the number
  existed only in the snapshot generator. `taskctl --version --json` now answers
  `{"ok":true,"data":{"version":"1.0.0","schema_version":4}}`. The value is
  `CONTRACT_SCHEMA_VERSION` in `src/shared/constants.mjs` — the snapshot generator
  reads that constant instead of holding a second copy, so the published number
  and the frozen snapshot cannot disagree — and the call contacts no board (nor a
  token, nor a data directory), so a version negotiation does not depend on the
  board it is about. The bare `taskctl --version` line is unchanged. The number
  tracks the snapshot's own layout, not every contract change (a new route does
  not move it), so it is the coarse generation marker beside the structural leg.
  See [`docs/contract.md`](docs/contract.md).
- **Project target directories: resolved locally, validated, never guessed.** A woken
  worker now runs in the card's **project target directory**, and the decision stays
  where the board's O3 rule put it — on the host. The supervisor hands the host's wake
  glue (`<host-dir>/bin/wake-<host>.sh`) the card's board project identity in
  `TP_PROJECT` and the map path in `TP_PROJECTS_JSON`; the glue resolves that identity
  against the host-local `projects.json` (see
  [`references/projects-json.md`](skills/meerkat-taskpanel/references/projects-json.md)),
  **validates** the result (absolute, exists, is a directory), `cd`s, and only then
  execs the host CLI. An unresolvable project — no entry at all, or a registered path
  that is relative, missing, or a file — **refuses the wake** (exit 3, reason appended
  to the supervisor log) rather than starting a session in the wrong checkout. With no
  glue installed the supervisor falls back to the host CLI pinned to `--repo` and logs
  an explicit warning on every tick, so the degraded case is never silent. The rule
  itself is `src/shared/project-dir.mjs` (pure, filesystem injected) and
  `scripts/wake-cwd.mjs` (the helper the glue calls); `src/shared/scheduling.mjs`
  `planWakeInvocation()` is the pure decision, so the glue/direct/override choice and
  the warning are asserted without spawning anything.
- **`taskctl project dir <id>`** — print the local directory a project works in,
  resolved from `projects.json`, or exit non-zero **asking which directory it should
  be** instead of continuing without one. The board still holds no directory (O3);
  this is the local map's read side, and the skill docs now say plainly that
  `local_path` is required *and checked*, and that a project with no registered
  directory is a question for the user — never a value to guess, invent, or derive.
  A registered-but-unusable path (relative / missing / not a directory) fails the same
  way, naming what is wrong.

- **API contract snapshot.** `scripts/verify/contract.mjs` freezes the surface a client
  binds to — routes and each route's **declared request shape** (`{query, body}`, down to
  `type`/`enum`/`items`/`anyOf`, recursively), error codes, and the wire field names **and
  types** — as the committed, deterministic JSON at
  `test/fixtures/contract/api.snapshot.json`. It compares the live surface against that
  snapshot and exits non-zero on drift; `--update` refreshes it. A route request field
  retyped or dropped, or a wire field whose type moved, now fails the gate instead of
  slipping through. The snapshot's `schema_version` is **4**.
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
- **Dark-ground logo favicons** — `design/brand/favicon-16-dark.png` and
  `favicon-32-dark.png`, transparent, the Sentinel Watch mark lifted to the dark brand line.
  The light favicons keep their role; the dark pair gives a dark tab strip a mark rendered
  for its ground, and closes the gap left when only the light pair shipped.

### Changed

- **The brand mark moved to V2 geometry (candidate B, "Mob").** The Sentinel Watch mark
  (three upright meerkats of a mob + one watch dot) keeps its structure — same skeleton,
  same `viewBox 0 0 32 32`, same `y = 27` baseline — and moved **exactly five parameters**:
  ear `r` `0.85 → 1.2`, ear `cx ±` `1.9 → 2.4`, ear `cy = top +` `1.0 → 1.7`, watch dot
  `r` `1.7 → 2.1`, watch dot `cy` `5.2 → 3.4`. The ears now hold shape from **48px up**
  (below that they still fall under a pixel and the mark degrades to three round-headed
  bars + a dot, as before), and the watch signal floats clear of the crown by **4.1 units**
  (was 2.7) at every size, so the "signal, never a cap" rule holds even at 16px. Ink extent
  is `x ∈ [3.6, 28.4]`, `y ∈ [1.3, 27]`. Every asset follows one geometry source:
  `design/brand/logo.svg` / `-dark` / `-mono` and their PNG rasters, the two inline marks in
  `prototype/index.html` (top bar + large empty state), and `prototype/favicon.svg`. The
  mark's **name is unchanged** — still `Sentinel Watch`; "Mob" was the candidate's variant
  label, not a brand name. No colour moved. The whole 48-frame `prototype/screenshots/` set
  was recaptured, because the top-bar mark appears in nearly every frame.
- **Renamed to `meerkat-taskpanel`.** <!-- legacy-name-compat: quotes the former name to record the migration --> Every naming surface moved off the former `task-panel` / `TaskPanel` spellings — the npm package name, the skill source and its generated plugin copies (`skills/meerkat-taskpanel/`), the plugin + marketplace manifests, the installer environment variables (`MEERKAT_TASKPANEL_*`), the host config file (`<host>/meerkat-taskpanel.env`), the launchd / systemd / cron units, the per-user runtime directory (`Application Support/MeerkatTaskPanel/`, `~/.meerkat-taskpanel/`), the Docker image and compose project names, the Prometheus rules file and metric namespace, and the `web/` localStorage keys. The CLI keeps its name: `taskctl`.
- **Backward compatibility.** The installer still accepts the pre-rename `TASKPANEL_*` environment variables, and the supervisor still reads a legacy `TASKPANEL_CLAIM_UNASSIGNED` key in the host config file; the new `MEERKAT_TASKPANEL_*` spelling wins when both are set.
- **Migration.** Re-run `install.sh` to write the new paths. A runtime pointer written under the former per-user directory is not read; the CLI writes a fresh one on first run.

### Removed

- **Project directories, from the board — the local map moves to the skill.** TaskPanel
  no longer manages project directories at all. `project create` / `project update` no
  longer take `--workspace-path` and `project list` no longer prints a `workspace_path`
  column; the `context` command group (`context current`) and the
  `GET /api/v1/projects/current` route are gone; the DB column `projects.workspace_path`
  and its unique index are dropped by migration **`0012`** (existing rows are kept —
  only their directory strings are discarded); and the markdown importer no longer treats
  a registry `root`/`workspace_path` as a directory anchor. A card's `target` is no
  longer derived from a project: it is an **opaque per-card value** preserved verbatim
  through import/export (`meta_json.legacy`), so an existing card's `target` is not
  silently dropped. This removes the **M5 invariant "one project, one target"**. The
  local **directory ↔ board project** map now lives in a `projects.json` beside the
  installed skill (schema: `skills/meerkat-taskpanel/references/projects-json.md`).
  **Migration:** an existing board needs only the automatic `0012` migration; anything
  that relied on `--workspace-path` or `context current` must move that mapping into the
  skill-local `projects.json`.

- **The MCP integration, entirely — agent integration is skill-only.** The stdio MCP
  server (`src/mcp/**`: its 18 tools, protocol and `README.md`), the
  `meerkat-taskpanel-mcp` bin, the installer's MCP registration (`register_mcp`, and the
  `claude mcp add …` / `codex mcp add …` calls), the packaged entry point and the
  MCP-specific coverage gate are removed. The API contract snapshot no longer carries a
  `mcp_tools` section; that is a layout change, so its `schema_version` moves **3 → 4**.
  **Migration:** a host left with an MCP registration should drop it —
  `claude mcp remove meerkat-taskpanel`, `codex mcp remove meerkat-taskpanel`, or the
  matching entry in OpenClaw's or Pi's MCP configuration. Nothing else changes: the skill
  drives the `taskctl` CLI directly, and the board's HTTP API, delivery gate and SQL
  schema are untouched, so an existing board needs no data migration.

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
