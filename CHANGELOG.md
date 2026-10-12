# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The host-external supervisor is a skill of its own: `meerkat-loop`.** The loop was an
  implicit side effect of installing the board; it is now a self-contained, separately
  distributed skill (`skills/meerkat-loop/`) carrying the execution body, the unit / wake /
  host-config templates and an operator reference. It is distributed to **claude, codex and
  pi**, and **never to OpenClaw** — permanently, by ruling: the openclaw-team framework
  already ships `poll-<agent>` / `task-patrol`, which is the same design, and two
  supervisors on one board would only race each other for the same cards. The board skill
  still goes to all four hosts, so `sync-skills.mjs` now models two skills with two
  distribution surfaces (plus a `plugins/loop` bundle target, so the marketplace can list
  the loop as its own plugin: `.claude-plugin/marketplace.json` now lists
  `meerkat-taskpanel` → `./plugins/claude` and `meerkat-loop` → `./plugins/loop`).
  The loop skill **declares the board interface generation it requires** —
  `task-interface v1`, the surface the board first shipped in release 1.0.0 — and its
  `scripts/board-check.mjs` enforces that against the board's own `taskctl --version --json`
  answer, exiting 3 rather than guessing when the board is too old or cannot be asked.
  Board and loop **version independently** (a `board` and a `loop` group in
  `scripts/verify/version.mjs`, and `scripts/release/bump.mjs --group loop`): the first split
  ships one linked version, but nothing holds them together after that.
- **The loop payload is generated and guarded, not hand-copied.** `scripts/sync-loop.mjs`
  computes the transitive import closure of `scripts/supervisor.mjs` and
  `scripts/wake-cwd.mjs` and writes it into the skill as `body/manifest.txt` — the list the
  installer copies and the test suite checks the copy against, so the closure is declared
  once instead of restated in bash, in a test and in a host's tree. `templates/` mirrors the
  loop-side files under `scripts/install/templates/`, and the installer now renders the
  units, the wake glues and the host config **from the loop skill** rather than from a
  second reading of `scripts/`. `node scripts/sync-skills.mjs --check` (and CI) covers both
  directions, so editing the supervisor without regenerating is a red build.

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

- **The wake glue resolves the card's project directory through the host, not the checkout.**
  The generated `wake-<host>.sh` templates called `{{REPO}}/scripts/wake-cwd.mjs` — a
  checkout path baked into a host-installed file, which is exactly the coupling the split
  exists to remove. They now call the host-local `{{LOOP}}/scripts/wake-cwd.mjs`, which
  travels with the loop body, so a moved, renamed or deleted checkout no longer breaks a
  wake. `scripts/wake-cwd.mjs`, `src/shared/project-dir.mjs` and
  `src/shared/runtime-locator.mjs` join the body closure for that reason (the shared modules
  themselves stay where the CLI imports them; the skill holds a generated copy).
- **`install.sh --link` names the board skill only.** The loop is always copied: a
  symlinked execution body would put the checkout back into the load path the split removes.
  The installer also installs the loop skill itself (`<host>/skills/meerkat-loop/`) for
  claude / codex / pi, and the board skill for OpenClaw — and the board skill's references
  no longer link up into the repository root (`../../../docs/…` dangles everywhere a skill
  is *installed*; they link out by absolute URL now, and `test/skill/loop.test.mjs` asserts
  it).
- **The brand mark gained its face — V2 logo landing, candidate A «Pin · 克制» — and the
  silhouette does not move.** The Sentinel Watch mark keeps its frozen V2 geometry to the
  byte — same `viewBox 0 0 32 32`, same `y = 27` baseline, same ink extent
  `x ∈ [3.6, 28.4]`, `y ∈ [1.3, 27]`, all five V2 parameters untouched — and gains the
  eyes and mouth as **negative-space knockout**: two eyes per figure (`r 0.42`,
  `cx ∓ 0.80`, `cy − 0.20` measured from the head centre) and one mouth
  (`0.72 × 0.20`, `rx 0.10`, `cy + 0.95`), cut out of the ink with an SVG `<mask>`.
  Because the face is a hole rather than a second colour, the mark still restores to one
  colour in the mono state, no palette value was added (the mask's greys are functional
  luminance, not brand colours), and the **watch signal stays outside the mask**, so the
  sentinel on duty and its dot are always solid. Declared size behaviour: the face reads
  clearly **from 128px up**, is only just perceptible at **48–96px** (eye `r 0.42` =
  0.63px at 48px), and by **32px the knockout degenerates to the plain V2 silhouette** —
  so the 16/32 favicons keep the small-size reading they already had. One geometry source
  as before: `design/brand/logo.svg` / `-dark` / `-mono` and their PNG rasters, the two
  inline marks in `prototype/index.html` (distinct mask ids, `face-knockout-a-top` /
  `face-knockout-a-lg`, because both share one document) and `prototype/favicon.svg`
  (which keeps its `prefers-color-scheme` pair). `BRAND.md` §5 gains a **Face** table and
  a rewritten *Size behaviour* paragraph; §7 records the landing. The whole 48-frame
  `prototype/screenshots/` set was recaptured, because the top-bar mark appears in nearly
  every frame: **15 frames are byte-identical** — exactly the ones that never frame the
  top bar — and every moved frame differs only inside the mark's own box.
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
- **The loop body is installed into the host, so a loaded scheduling unit no longer names
  this checkout.** `install.sh` used to render its launchd / systemd / cron units with the
  checkout's absolute `scripts/supervisor.mjs`, so moving, renaming or deleting the
  checkout left every loaded unit pointing at a file that was gone — the loop died with the
  directory, and reviving it meant reinstalling *and* reloading the unit. The installer now
  **copies** the executor and the `src/shared/` modules it imports
  (`scheduling.mjs` → `constants.mjs`, `errors.mjs` → `redact.mjs`) into
  `<host-dir>/meerkat-taskpanel/`, preserving the `scripts/` + `src/shared/` shape those
  relative imports need, and the units name that copy: `{{SUPERVISOR}}` keeps its meaning
  and changes only its value. Re-pointing the loop after a move is a re-run of `install.sh`
  with no `launchctl` / `systemctl` / `crontab` reload. Because the copied executor has no
  board beside it, the host config now also records where the board engine it drives lives
  (`MEERKAT_TASKPANEL_REPO`), which the supervisor falls back to when its own location holds
  no `src/cli/index.mjs` — a key the installer adds to a pre-existing config file, since a
  differing config is otherwise never rewritten without `--force`. The board engine itself,
  the `taskctl` shim and the wake glue's project resolver stay checkout-resident; that
  remaining half of the split is its own card.

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

- **The board's selection surfaces are painted again, and the theme cell shows a glyph.**
  Eight fidelity findings from a design review, each one a place where the board rendered
  *something* where the prototype renders *that thing*: the Board/List switch had no visible
  selected state at all (the control states its choice with `aria-pressed`, which daisyUI's
  tab vocabulary does not read) and the current sidebar row — nav or project — was grey
  rather than the brand accent; the Access dialog was a right-hand drawer instead of the
  prototype's centred modal, and its token mask leaked the first six characters of the
  stand-in; a card title could wrap to any number of lines; the list view had no column
  head, no group shell and no status dot, and its row grid did not match the design's six
  tracks; the drawer's status chip had lost its dot (colour alone is not a signal); the
  sidebar's theme cell rendered **no glyph whatever** — the attribute binding that was meant
  to hide two of the three glyphs wrote a literal `hidden="false"`, and a `hidden` attribute
  hides by its *presence*, so all three were hidden; and both footer cells stacked their icon
  above their label instead of sitting on one row. The web layer also gained the accent
  tokens it never had (`--brand-accent` / `--brand-accent-soft`) — before this, the board had
  no way to paint a *selection* as anything but grey.
- **The sidebar's per-project count is served, not guessed.** `[data-project-count]` — the
  badge on every project row, `12 / 4 / 2` in the prototype — was read from the *current*
  project's task list, so only the open project had a number and the other rows rendered an
  empty one (1/3 rows). `GET /api/v1/projects` (and `/projects/:id`) now returns
  `task_count` per project — its total number of tasks, every status and archived included,
  `0` for a project with none — and the sidebar renders that value; the row count is
  independent of the §4.6 ordering and of which project is open.


- **`scripts/verify/install-e2e.sh` no longer fails its own claim.** The script acted as
  `TASKCTL_AGENT="install-e2e"` but assigned its card to `install-e2e-bot`, and the claim
  policy only lets the assignee claim a card — so the run died on `not_assignee` at
  `issue move … in_progress`. Actor and assignee now come from one variable, so they cannot
  drift apart again.
- **The install + first-run end-to-end is now a step of
  `docker/verify-in-container.sh`.** It had been a separate `docker run` in CI only, which
  meant `npm run verify:docker` could be green while the CI `docker` job was red. Both
  tracks now run the same script; the CI job's duplicate step is gone.
- **A symlinked install path no longer turns the host-bundle writer into a silent no-op.**
  `scripts/install/lib/apply.mjs` decides whether it was executed or imported by comparing
  `process.argv[1]` — the path *as invoked* — against its own `import.meta.url`, which Node
  has already resolved. Reached through a symlink the two never matched, so the guard was
  silently false: `emit` / `snippet` / `merge-settings` wrote nothing and the helper still
  exited 0 with no output. `script_dir()` (`cd "$(dirname "$0")" && pwd`) prints the logical
  path, and on macOS `/tmp` is itself a symlink to `/private/tmp`, so an install tree under
  `/tmp` — or any symlinked checkout — hit it on every file. Both sides are now resolved
  with `realpathSync` before the comparison, and `test/install/apply-guard.test.mjs` pins the
  direct, symlinked and imported states.

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
