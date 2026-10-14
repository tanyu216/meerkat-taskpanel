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
  already ships a per-agent poll / a `task-patrol`, which is the same design, and two
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
- **A contribution contract.** `CONTRIBUTING.md` (the container gate and the
  commit-before-you-run-it ordering, the pull-request flow, and the conventions CI
  enforces), `.github/CODEOWNERS`, a pull-request template, bug and feature issue templates,
  and a `.mailmap` that folds the two `turing` spellings onto one author.
  `test/scaffold.test.mjs` asserts they exist **and** that the two carrying meaning say the
  right thing rather than merely being present. `docs/development.md` gains the
  pull-request section, including the repository settings a maintainer has to set by hand.

### Changed

- **The patrol's `leader_stalled` row now counts the *author* of an event, not its *kind* — and
  `heartbeat_stale` emits the shared SLA tuple beside the legacy alert.** Both are `v1.1`
  write-backs of the SLA inspection contract (`T-20261014-084606-2`, §6.3-D and §10.4), and
  both are user-visible:
  - The leader's action set is a `confirm` / `decision` / `change` comment **authored by the
    leader**, a card the leader created, and the leader-only `done` transition. A `kind=change`
    entry written by a *worker* no longer resets the stall clock, which is the point: any chatty
    worker could otherwise mask a real stall. "Who is the leader" is the board's own decision
    authority by default (an author whose `author_kind` is `human` — the same reading
    `isDecisionComment` / `listDecisions` use); a deployment whose leader writes as an agent sets
    `--sla-leader <id>` (or `$MEERKAT_TASKPANEL_SLA_LEADER`) to the **same** identity on both
    mechanisms. A board whose newest leader-attributed event is older than the 7-day lookback
    still emits the row with its **real** origin (never a softened one) and `confidence: "low"`,
    and a board that has never shown a leader event says so rather than staying quiet.
  - `heartbeat_stale` now also emits the §4 tuple. The legacy `{stale: […]}` alert keeps its
    exact envelope and its consumer — it is a published contract and is not touched — but it
    carries no `dedup_key` and no `sla_row`, so without the tuple the two mechanisms could not
    de-duplicate the row between them. **One stale heartbeat therefore notifies twice, on two
    channels, by design** (§10.4 leaves no additive alternative). The tuple fires one period
    earlier than the legacy alert (`warn` = `L − P`), and an unreadable heartbeat is reported at
    `warn` with no threshold.
- **`inspector_liveness` lands — the mutual watchdog between the two inspectors** (§5.3/§8.4).
  Every completed pass publishes this mechanism's own last-successful-run marker
  (`--sla-last-ok`, default `loop-patrol-last-ok.json` beside `--state`), and `--sla-peer <path>`
  points at the other mechanism's marker: one older than `3 × 15min` raises the row at `warn`
  (no threshold — the bound is derived, never invented). With no `--sla-peer` configured, the
  peer's half is recorded as an **explicit dependency** and nothing alarms, because the peer's
  marker has not landed yet and alarming every pass would be the permanently-red failure the
  contract exists to prevent.
- **Two smaller contract write-backs ride along.** `confidence` is now pinned where it was
  guessed (§6.2): an exactly-read origin is `high` — including `defect_card_creation`, whose
  origin was being reported `low` for no reason — and only a fallback, a shape match, or an
  undecidable predicate is `low` (a board read cut off at the page cap makes the defect row's
  "no fix card exists" check undecidable, and that now shows as `low` while still alerting).
  `releasable_basis: "assignee_changed"` is implemented off the §7 substantive-change trail
  (a `kind=change` entry, authored by the leader, that says it was a reassignment), where it
  previously stayed `null` because "the read surface has no assignee history" — the contract
  names the trail as that history's channel.
- **The candidate read is scoped in SQL instead of truncated before the filter — C-WEIGHT-1's one
  existing-read change.** `GET /api/v1/tasks/candidates` — the read a supervisor's poll performs
  before claiming — read `tasks.list({status:"todo"})`, which the repository caps at its default
  **`LIMIT 200`**, and dropped the rows that were not the caller's *afterwards*, in JavaScript. An
  assignee whose claimable cards sat past the first 200 `todo` rows of the board therefore had them
  **silently invisible to their own poll**: a truncate-then-filter read. The `status` and
  `assignee` filters are now pushed into the query and the read is issued with **no `LIMIT` clause
  at all** (`limit: null`, the repository's explicit statement of "the whole scope", which the JS
  page must not re-impose on top of), so the ordering and the paging are built on the complete set.
  It is a **pure extension**: the sort key chain is unchanged (bucket → `sort_order` → `created_at`
  → `project_id` → `identifier`) and the bucket table is the same four entries (`ready` /
  `unassigned` / `stale_same` / `stale_any`), so the old read's rows appear item-for-item, in the
  same order — the new read only appends. Nothing else moves: the default order is byte-unchanged
  (`?order=weight` is opt-in), activity / waiting / the markdown export are untouched, and there is
  no UI switch.
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
- **`web/scripts/shot-compare.mjs` no longer carries a default output directory.** Review
  artefacts belong to the task workspace, which lives outside this checkout, so the only
  default the script could have had was one machine's absolute path. `--out <dir>` (or
  `SHOT_OUT`) is now required, and a run without one fails with usage rather than writing
  somewhere only its author could find.
- **An actor's `kind` is no longer a closed vocabulary** (migration **`0018`**). The two
  columns that carried `CHECK (kind IN ('agent','human','system'))` and are not otherwise
  scheduled to move — `comments.author_kind` and `task_reports.author_kind` — now accept any
  non-empty string. `human` is the one reserved value; everything else is "not the human",
  and naming *which* agent platform wrote a row is data rather than something the schema
  should adjudicate. `NOT NULL` is unchanged: the enumeration goes, the requirement does not.

  The other four actor-kind columns are deliberately untouched, because each is going away
  with the column it sits on: `tasks.assignee_kind` / `creator_kind` / `creator_id` are the
  denormalised kind copies the identity model removes, and `assignees.kind` / `reporters.kind`
  belong to the two dictionary tables that a later migration replaces with a single `actors`
  table whose column is open from birth. Rebuilding those five columns' tables here would be
  work done twice — on the two tables that carry inbound foreign keys from `tasks`.

  **No data step, and no board migration to run by hand:** `agent`, `human` and `system`
  remain legal values of an open string, so every existing row is already valid. The
  migration is a pure widening, which is why it ships with no accompanying code change.
  It also brings one constraint into view that was previously invisible: `task_reports.origin`
  was constrained by `0008`'s `ALTER TABLE … ADD COLUMN`, which the SQL-parity reader does
  not see; the rebuild declares it in a `CREATE TABLE` body, so the value set is now declared
  on the JS side too (`REPORT_ORIGINS` in `src/core/domain/enums.mjs`) and the parity test
  covers it for the first time.

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

- **The prototype-comparison manifests and their project-side wiring.** `web/manifests/`
  (`board.json`, `board-m2.json` and the 970-line `README.md`), `web/.ui-align.json`,
  `web/scripts/ui-align-serve.mjs` and the browser-free drift guard
  `test/web/ui-align-ready.test.mjs` are gone. They were the project half of a
  prototype-versus-implementation comparison engine that lives **outside this repository**,
  in the team's own toolchain — so what is removed here is the half that named a tool no
  reader of this repo could obtain, and the half that could only ever be run on the machine
  it was written on.

  **Nothing that runs is lost.** The browser-free assertions those manifests duplicated are
  already asserted by `test/web/blocks.contract.mjs`; the geometry and multi-viewport legs
  run in `web/scripts/dom-smoke.mjs` (inside `npm test`) and in
  `web/scripts/rail-chip-overflow.mjs`; the screenshots are `web/scripts/shot-compare.mjs`.
  `web/scripts/dom-smoke.mjs`'s `startServer()` also loses its unused `{ port }` parameter —
  its one caller that had to name the port up front was `ui-align-serve.mjs`.

  Three contracts had delegated their typography/colour/border assertions to that external
  engine's computed leg (`rail-chip-overflow.md`, `side-rail-short-code.md`,
  `assignee-weight-order.md`); those clauses now read "not in this contract's assertion
  scope", because the delegation was never this project's to hold. The `design/fidelity-r*`
  round records keep their references — they are records of what was run, not instructions.

### Fixed

- **The loop's scheduling units no longer resolve anything on the host's `PATH` — the
  `env: node` exit 127, fixed at both layers at once.** A scheduler starts a unit with a
  minimal `PATH` of its own, and on a machine whose node lives under nvm or Homebrew that
  set holds no `node` at all: the launchd / cron units named `/usr/bin/env node` and exited
  **127** before the tick could run. Repairing only that would have moved the failure down a
  layer rather than removing it — the wake glue the tick starts runs `exec claude` on the
  *same* inherited `PATH` and exits 127 in turn, with the worker's own `git` / `node` /
  `taskctl` tree blind under it. Each unit now names the **absolute `node`** that rendered it
  *and* carries a `PATH` whose head is the host CLI's directory and node's, followed by that
  scheduler's own documented default (prepended, never narrowed: `sh`, `git` and the rest
  stay exactly where the scheduler would have put them). The value comes from one recipe,
  `scripts/install/lib/unit-path.mjs`, which the installer's bash side reads through its CLI
  and JavaScript callers import — so the two cannot drift — and the taskd guard's own
  `{{PATH}}` is deliberately unchanged by the sharing. When the host CLI is **not** on the
  installing machine's `PATH`, the installer says so and renders node's directory alone
  rather than inventing one. The systemd service keeps its current form until the ruling on
  whether its `Environment=PATH=` should be the documented default or an inherited prefix
  lands; shipping its absolute interpreter alone would be the half-fix above. One path stays
  out of reach and is documented as such: `templates/codex/trigger.sh` is scheduled from the
  user's own crontab line, where no unit of ours is in the chain.

- **The board skill's wrapper works when the skill is deployed on its own — which is how it
  is deployed.** `install.sh` distributes the skill as a *copy* of `SKILL.md` +
  `references/` + `scripts/`, so the taskpanel checkout is not beside it; but
  `scripts/run.mjs` — the entry point `SKILL.md` documents — resolved the CLI only as
  `<here>/../../..`, which from `<home>/.claude/skills/meerkat-taskpanel/scripts/` lands on
  `<home>/.claude`. The documented command therefore died with
  `Cannot find module '<home>/.claude/src/cli/index.mjs'`: a path the user never had,
  reported as a module-not-found stack rather than as a condition of the deployment. The
  wrapper now walks a checked ladder — an explicit `MEERKAT_TASKPANEL_ROOT` (or the
  `MEERKAT_TASKPANEL_REPO` key `install.sh` records in the host config), then its own
  checkout, then `taskctl` on `PATH` — skipping any rung whose CLI is not there, and
  refusing with the three remedies when none is. So an installed copy runs a `taskctl` you
  installed or a checkout you name, and the reference docs' `src/…` pointers are marked for
  what they are — provenance in the source repository, not files an installed copy has — with
  `card-schema.md` §Conformance labelled as needing the checkout and refusing clearly
  (exit 2) when run without one. Regression-tested per host in
  `test/install/installed-copy.test.mjs`, which installs by copy — the mode
  `scripts/verify/profiles.mjs` never exercised, because it installs with `--link`.

- **One light-dismiss rule for the floating controls, the label filter aligned to its two
  selects, and the list's two states made exclusive.** Three findings from Terry's
  2026-10-12 review of the board.
  The top bar's project switcher never closed by itself: there was no outside-click path at
  all, so an open switcher stayed up until its own list was clicked — and since its floating
  panel covers the filters bar, it also swallowed the next click on the label control. Every
  floating control now joins **one** document-level rule by carrying `data-dismiss-on-outside`:
  a click outside closes each open member, opening one closes its siblings, and Escape takes
  them all down. Membership is the attribute — no class name, no selector list — so a third
  control joins the rule with no code change, and the rule is stated once, in `App.vue`.
  The label filter wore the `.td-select` class but not its metrics: 14px text in a 31px box
  against the two selects' 12px in 32px, and the two selects floated 6px *above* the row's
  centre line because their wrappers carried a stray `mb-3` from a stacked form. The trigger
  now wears the field's shell (`.td-label-trigger`: the family's 32px, the 12px/400 ink face,
  the 14px caret parked at `right 6px` in the room the right padding reserves), the chosen
  value renders as plain text, and the stray margin is gone — all four controls in the bar
  sit on one line. The control stays a `<details>` dropdown rather than becoming a third
  `<select>`: its shape is seventeen choices plus a chosen-value readout.
  The list view rendered its skeleton and its rows at the same time — the render filled the
  rows and never took the skeleton down — so "Loading tasks" sat above twelve live rows.
  `[data-list]` now carries `data-list-state` (`loading` | `data`), that state is a **rule**
  in `app.css` rather than a per-element swap, and entering the view is one read: `loading`
  until it returns, `data` after. Both groups stay resident (the data group keeps its
  six-column head), so the pair is exclusive at every instant, including at rest, before any
  script runs.
  Machine checks: the block contract gains the declarable half (the dismiss register and its
  membership floor, the trigger's metrics and flattened value, the two states with each half's
  `display` and the skeleton's `hidden`), the manifest three R9 blocks and five `r9-*`
  computed-style targets, and the DOM harness an R9 section for the three relations a probe
  cannot state — which half of the list is on screen at one instant, three controls' heights
  against each other, and where a floating control went after a real pointer click — holding
  the fixture's own list read open so the in-flight state can be sampled. Rules 245 → 276.
- **An empty board shows its empty state instead of seven bare columns, the task drawer saves
  its assignee / reporter / labels as they change, and the create dialog's description fills
  the column it sits in.** Three findings from Terry's 2026-10-12 review of the running board.
  The board view had no state of its own: the no-results block was shown only for a filter that
  matched nothing (`total > 0 && shown === 0`), so a project with **no cards at all** drew its
  seven bare columns with "No tasks match your filters" hidden behind them. The view now has a
  state root of its own — `[data-board-view][data-board-state]` (`data` | `empty`), the same
  shape the list's `loading | data` got in R9 — whose two members are its own two direct
  children, made exclusive by a **rule on the attribute** rather than by swapping elements, so
  the resting document is already consistent. The condition is now `shown === 0`, which covers
  the filtered case and the genuinely empty project alike.
  The detail drawer's assignee, reporter and label controls had no save path at all — the three
  fields were rendered, read and then thrown away. They now commit as they change: a
  single-valued field on focus loss (or when a roster row is accepted), the label set when a
  chip arrives or leaves; an empty value is the one failure the drawer decides on its own. One
  region above them says what the save is doing — `[data-detail-save][data-save-state]`
  (`idle` | `saving` | `saved` | `error`), with `[data-detail-save-error]` (`role="alert"`) as
  its only visible half, written by the same act so the attribute and the block can never
  disagree. The write is real (`PATCH /tasks/:ref`, `if_version`, optimistic local state with a
  rollback on rejection), not a state machine that reports success without saving. The two
  single-valued boxes are **seeded** with the field's value — the prototype's own
  `value="linus"` — which is what lets "left the field with a different value" be answered by
  the input itself.
  The create dialog's description stopped 240px short of the dialog's last edge: the two-column
  grid stretched its tracks but nothing inside the left track filled them, because the field
  wrapper was a **block** container (so the editor's `flex: 1 1 auto` had no parent to resolve
  against) and the panes carried a fixed `clamp(280px, 46vh, 520px)` — a rule about the window,
  not about the row. The chain is now explicit end to end: the grid stretches, each track is a
  column flex box, `.td-field-grow` is the field that fills, the editor fills that and the panes
  fill the editor, with a `min-height: 200px` floor instead of a viewport ceiling. Measured at
  1512×950: the space under the editor 240.5px → 16px, which is now exactly the dialog's own
  padding.
  Machine checks: the block contract gains the board's state domain and the four save states
  (plus the walk of the stretch chain's own computed style), the manifest three R10 blocks and
  two `r10-*` targets, and the DOM harness an R10 section for what a document probe cannot state
  — which of the board's two members is *painted* at one instant (including the empty project,
  reached by switching to one), that a real edit moves the save state off `idle` and that the
  alert follows it, and where the editor actually ends relative to its own row. Rules 276 → 308.
- **The task list's columns line up under headings, the create dialog separates from its
  background in the dark, and an identifier renders at most eight characters plus `…`.**
  Three findings from the 2026-10-12 review of the list and the create dialog.
  The list's header held one label — the identifier — while its rows were a six-track grid,
  so five columns had no heading and the head had no column widths at all; head and rows now
  share **one** template declaration and all six columns are named (ID · Title · Status ·
  Assignee · Priority · Revision), with the middle three dropping, on both sides, at the same
  breakpoint. Sharing the declaration was not enough on its own: the row is a `button`, which
  is shrink-to-fit, so its flexible track resolved against the row's own width rather than
  the group's and the columns drifted — 735px of a 1238px box — which the row's `width: 100%`
  pins, and which the machine check now measures as matching column edges at two viewports.
  The create dialog separated from its background on none of its three devices in the dark:
  the veil resolved from `--color-neutral`, which is *lighter* than the dark canvas, so it
  lifted the background instead of dimming it; the panel's edge used a hairline that sits on
  both the canvas and the panel surface; and the panel's shadow was tinted with the canvas
  colour, so the elevation vanished into the surface it should lift off. `--brand-scrim`
  (new; light keeps the exact value the dialogs already composited to), the strong hairline
  and a dark `--shadow-pop` fix all three, and the light is byte-identical — measured, not
  assumed. The dialog's panel also gained a hook of its own (`[data-create-task-panel]` /
  `[data-create-project-panel]`), because until now the only way to address it was a
  positional anchor. An identifier now renders at most its first eight characters plus an
  ellipsis at all three of its render points (the list's rows, the cards, the drawer's head);
  the cut is a character slice in the render layer, never a CSS width — `max-width: 9ch`
  depends on the face's advance width and its letter-spacing and cannot promise a character
  count. The full value stays on the element's `title` and on the row / card / drawer root's
  `data-identifier`, which is the only thing identity is ever read back from; a new
  `.td-id` class is the single-line guard, not the cap.
- **The sidebar's glyphs, count pills, footer split and the drawer's close button match the
  prototype.** Four findings from the 2026-10-12 sidebar review. The nav glyphs had lost the
  brand's stroked line-icon face (`.td-icon`) and wore the project monogram's `data-side-icon`
  hook instead, so at the ≤1023px rail the chip rule painted them as 24px bordered grey tiles
  where the prototype draws a bare 16px stroke; each project row's count was a daisyUI
  `badge-sm` box (34.45×20, 4px radius) rather than the brand's `.td-count` pill (20×18,
  fully rounded), and its `data-project-count` hook sat on the row button rather than on the
  number; the footer is now **one row of three equal thirds at ≥1024px and three stacked
  rows below it** — each cell a `[data-access-cell]` button, with the hairline turning from
  the cells' inline start to the stacked rows' block start — matching the prototype's own
  breakpoint split; and the task drawer's close button moved out of a line of its own *under*
  the title into the identifier's top row, pushed to that row's inline end and drawn as an
  `svg.td-icon` ✕ instead of a text character.
- **The board's base type, the sidebar's row rhythm, the top bar at 980px, the column
  count's place and the list's resident skeleton were five measured departures from the
  prototype.** Five fidelity findings from the running board, each one a computed-style
  value the board reported differently from `design/prototype/index.html`.
  The app set no base font size, so every inheriting surface rendered at the browser's
  16px where the prototype's `body` states 14px / 1.5 — the sidebar read a size too
  large, and the type in the bar, the sidebar, the board, the cards and the list was off
  by the same factor. The declaration now sits on `body`, exactly where the prototype
  puts it, so `rem` stays anchored to the 16px root and every rem-based utility keeps the
  value the prototype computes with. Two geometry examples that travel beside it are
  their own root causes and were fixed in the same pass: the shell's first track is the
  design's `--shell-topbar` (56px) rather than `auto`, which had been sizing the bar from
  whatever its content happened to be (49px at ≥780); and `.td-sidebar` keeps the
  design's `16px 12px` box rather than one uniform 12px.
  Both sidebar row lists are the prototype's `.td-nav` box verbatim — a column flex with
  the design's 2px row rhythm. It is not cosmetic: as a *block* child a row button
  resolves `min-width: auto` to `0px`, which was the whole computed-style divergence; as
  a flex item it stays `auto`, which is what the prototype reports.
  The top bar stopped clipping at 980px: `flex-none` on the right cluster is the
  prototype's own declaration for it (`.td-topbar-actions`), and without it the cluster
  was the only shrinkable item besides the search, so the two split the shortfall — the
  cluster kept its box while its content (revision + New task) spilled 12px past the
  shell's right edge, which `overflow: hidden` then clipped. That clipping was the one
  implementation-only entry `shot-compare --strict` reported at 980px. The search is the
  item the bar is designed to give slack to, so it now absorbs the whole shortfall.
  The column header's count sat at the column's far edge (`ms-auto`), where the
  prototype reads `[dot][name][count][+]` with no auto margin anywhere; the count now
  follows the name.
  The language menu's option rows were a 14px/500 line in a 4px-padded, 6px-rounded box
  against the prototype's 13px/400 line in a 28px row with `0 8px` of inline padding and
  the `--r-sm` radius. The size now lives on the row rather than on the label span, and
  the selected row keeps the same 400 as its sibling: the design marks the current
  language with colour and the tick, never with weight.
  The list view rendered its skeleton group only while loading, so the rest state held
  one `.td-list-group` where the prototype holds two (the skeleton group is resident in
  the prototype's markup and in its rendered rest state). The group is resident again,
  and the manifest's anchor for it moves from `min: 1` to the prototype's real `count: 2`.
  Machine checks: the manifest's `.td-list-group` anchor, the computed-style diff, and a
  20-frame prototype ↔ implementation matrix with no horizontal overflow and no console
  error. `design/**` is untouched — every one of the five is the implementation moving to
  the frozen prototype, not a design change.
- **The top bar's box and its narrow band, the sidebar's section rhythm, the column's add
  button, the card's box and rhythm, and two review-tool calibers now match the
  prototype.** The M2c round's out-of-scope findings, taken one at a time against
  `design/prototype/index.html`.
  The top bar's inner spacing is the prototype's `.td-topbar` box — which is **three**
  boxes, one per band: `0 12px` at ≥780px, `8px` with an 8px `row-gap` in the 760–779px
  band, and the same `8px` with a 6px `gap` below that. The bar had carried one flat
  `8px / 16px`, so its block padding was pure divergence at ≥780 (it is 56px through the
  shell grid's own topbar track, not through its padding, and the content is centred by
  `items-center` already) and its inline padding was 8px too wide in every band. The
  sidebar's section gap is the prototype's `20px`, not the `16px` that is its *inline
  padding*, a different axis.
  The narrow band is where the bar folds, and it folded into **three** rows where the
  prototype folds into two: the bar's own inline padding, plus a `Filter` word that
  cost its first row 31px, put that row past a phone-width line. Both controls that the
  prototype draws as a compact icon button are now one — a new `.td-iconbtn` (the
  prototype's own class and box: 32 × 32, transparent with an ink-2 glyph, the `--r-md`
  radius and the design's hover/pressed faces) — worn by the top bar's filters toggle
  (funnel-lines `svg.td-icon`, the word's name moved to the `aria-label` it already
  carried) and, at the prototype's 24 × 24 with 2px of clearance, by the column header's
  add control (`.td-iconbtn.td-col-add`).
  The card is a **block** again, not a flex column with one `gap`: its three bands carry
  the prototype's own top margins (2 / 6 / 8px, which a single gap cannot state), its
  padding is `8px 10px 8px 13px` (the 13px is the 10px the other sides take plus the 3px
  stripe that hangs into it) and its radius is the design's `--r-md` 6px for
  button/input/card rather than the panel's 8px `rounded-lg` was pulling. The block model
  is also what puts the title's `min-width` back on the block's `0px`, where the flex
  item's `auto` had put it.
  Two review-tool calibers were wrong: `web/scripts/shot-compare.mjs` captured `500px` as
  its narrowest tier, a width no other surface in the repo names, so the `430` the
  acceptance actually reviews had never been captured at all; and the list's
  `.td-list-head` anchor sat at `min: 1` where both sides have 2 (one per
  `.td-list-group`), the companion of the `.td-list-group` anchor M2c had already taken
  to `count: 2`.
  The block contract also gained the row-level **floor** under the project count pill:
  after a retired assertion went, the R7 ② family stated only "at most one pill per row",
  so a row that lost its pill while its siblings kept theirs was invisible.
  Machine checks: `shot-compare --strict`,
  `node --test "test/web/**/*.test.mjs"` and the DOM smoke, plus the 20-frame matrix.
  `design/**` is untouched — every change is the implementation moving to the frozen
  prototype.
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
- **Host-absolute paths out of the files a second person has to read.** Six of them told a
  reader to run a command at a path that exists on exactly one machine: the `shot-compare`
  default above, `design/prototype/README.md` (the `tw.css` build now leads with the in-repo
  `npm run build:css`, with the out-of-tree scratch-toolchain variant kept as the copy-free
  alternative), and four round records (`design/fidelity-r11/r12/r12-supplement/r16.md`)
  whose repro commands now take their workspace through a placeholder. The records still
  describe what was run; they no longer claim a path the reader cannot have.
- **`docs/docker.md` cited a test that does not exist.** Its host-allowed-checks list named
  `test/web/tokens.parity.test.mjs` reading `design/brand/tokens.css`. No test reads that
  file and no test has that name; the sentence now names the check that really does
  self-skip inside the container for the same reason.

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
