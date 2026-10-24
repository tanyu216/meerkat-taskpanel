# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **One acceptance mode per card; the policy × scope matrix is gone (migrations `0038`,
  `0039`).** A card now stores `acceptance_mode` — `off` (no review; the deliverer may close
  it, and `in_progress → done` is allowed), `agent` (an independent review card must APPROVE;
  the loop or a human closes) or `human` (a person only) — resolved once at creation. A
  project stores a default (`auto`, the default, or one of the three); `auto` leaves the
  decision to the creator, and an unresolved card falls back to `human`. The retired
  two-axis model is removed: `TASKD_ACCEPTANCE_POLICY` (a board configured with it now
  **refuses to start** until the key is deleted), the loop's advisory `--acceptance` copy,
  `--auto-accept-reviews` / `MEERKAT_TASKPANEL_AUTO_ACCEPT_REVIEWS`, the `human-only` hold
  (`approve_hold`) and the `review_cards_unclosable` deadlock check. The loop always closes
  the review card it dispatched. `issue deliver --to done` performs an `off` card's direct
  acceptance atomically; `issue update --acceptance-mode <value> --reason "<why>"` is the one
  audited override (an agent may only tighten). `projects.review_policy` and
  `tasks.review_required` survive one release as the legacy spelling (`required → agent`);
  `--review yes|no` is their CLI alias. **`kind=deploy` is retired** (migration `0039`): a
  historical deployment card becomes a `task` and keeps its acceptance snapshot, and
  `--kind deploy` is refused. Whether a card belongs to a release line is the loop's
  decision, not a card kind.

- **Reports are reports: report provenance is no longer recorded (migration `0035`).**
  `task_reports.origin` (`delivery` | `import`) is gone. The board records a report and
  enforces its shape — a non-empty conclusion, one report per round, `deliver`/`writeReport`
  validating the payload — but it no longer tries to decide whether the writer was the
  worker, a backfill or an importer; that judgement belongs to the team consuming the report.
  The delivery gate now accepts any report for the card's current delivery round (an epic
  still requires its current-round rollup marker). Consequences: `taskctl report list` /
  the report wire never had `origin`, and still do not; the markdown export stops writing
  `origin: import` (old cards that carry the line are parsed and the line is ignored); the
  acceptance refusal hint now points at `taskctl issue deliver` instead of a nonexistent
  `report write` command. The migration rebuilds `task_reports` to drop the column,
  preserving every row.

### Added

- **Three read-surface conveniences for an integrating poll (no migration).**
  `comment add --ref <kind:id>` (repeatable) stores references in the comment's existing wire
  `refs`; `project ensure <id>` creates a project if absent and returns an existing one
  **untouched** (`PUT /api/v1/projects/:id`, with `created:false`), so an idempotent caller
  stops treating a duplicate as a conflict; and `issue candidates` now carries `created_at`,
  `target` (the card's own `meta.target`) and the card's whole `meta`, so a poll can read a
  target or routing field without an `issue get` per candidate. The candidate's `target` is
  the card's opaque value, not a project directory.

- **`/setup-meerkat`, an optional team, and a narrower decision ladder.** A third skill,
  `skills/setup-meerkat/`, is a user-invoked install/repair command: it detects the server,
  `taskctl`, the board/loop skills and the supervisor without writing anything, installs what
  is missing (checkout, one `npx` attempt, then a shallow clone), offers the Matt Pocock
  issue-tracker integration without overwriting an unrelated tracker, and installs an
  optional team — **Jobs** (product design), **Linus** (architecture and implementation),
  **Turing** (acceptance) and a separate **Reviewer**. The role names are ordinary board
  agent names; `kind == human` writes still use the configured human name. `install.sh
  --target claude` copies the skill to `~/.claude/skills/setup-meerkat`; the shared bundle
  and marketplace carry it for the other agent kinds. The loop gains an **optional** roles
  loader (project `.meerkat/roles` > the loop skill's `roles/` > the legacy state dir) with
  two layers — the handoff carries the role's responsibilities, the subagent reads its
  workflow and self-check — a `--roles-dir` flag, and `MEERKAT_TASKPANEL_AGENTS` scanning.
  Every worker is told to maintain `.meerkat/<id>/plan.md`. A subagent no longer decides an
  unauthorized question: it writes an agent `question` comment and stops; the project
  session answers operationally with a `note` + reattach/requeue, or escalates E1–E5 to the
  human with `awaiting`. Any human comment resumes an awaiting card, whatever its kind
  (the resumed worker judges its content). Review cards now
  carry the original acceptance snapshot **plus** requirement-coverage and plan-deviation
  checks (dynamic 64-item cap), and the review prompt requires an omission check: a
  missing requirement or an unexplained deviation from `plan.md` is grounds for `REJECT`.
  With no roles root, every handoff is byte-identical to before.
- **The board read takes scope filters, and a claim can re-check its dependencies.**
  `issue list` (and `GET /api/v1/tasks`) accepts `--parent <ref>`, `--kind`, `--label`
  (repeatable, exact display name), `--target` (the card's `meta.target`), `--meta k=v`
  (repeatable, every pair must hold) and `--assignee <name>`. All of them are pushed into
  SQL before `LIMIT`, so a narrow read cannot truncate the card it wanted; `--assignee` and
  `--assignee-id` are refused together, and an unknown assignee matches nothing rather than
  everything. `issue claim --check-blockers` is the opt-in dependency re-read: the default
  claim is unchanged (the candidate scan already withholds blocked cards), and with the flag
  an open `blocks` predecessor refuses the claim with the new `BLOCKED_BY_PREDECESSOR` (409),
  naming the predecessors in `details.blockers[]`.

- **`taskctl status` reports the board this client talks to.** A top-level, **local** read
  (`status [--url <url>] [--json]`): it reads the runtime pointer, probes `/health`, and
  prints `{runtime: {pointer, data_dir, pid, url, running, note}, version, schema_version}`.
  It needs no `--actor-kind`, resolves no token, never autostarts, and exits 0 when the board
  is down — "not running" is the answer it was asked for. `--url` is a pin; the pointer is
  not consulted behind it. The CLI contract snapshot grows a `top_level` section (schema 2)
  and freezes the `status` payload keys.

- **Sessions record opaque host observations, and can be read/closed across cards (migration
  `0036`).** `agent_sessions.meta_json` stores a free-form object the board never interprets;
  `session set --meta k=v` writes it (a re-registration merges the supplied keys), and the
  session wire carries `meta`. `session close <ref> --seg <seg> [--owner <name>]` closes by the
  natural key `(task, seg, owner)` instead of the row id, and `session list` without a card ref
  is the board-wide read (`--owner` / `--owner-kind` / `--status`, newest first, `--limit`
  default 200; an unfiltered scan is refused). The per-card `session list <ref>` is unchanged.
- **A worker can ask, and the answer re-queues it (migration `0034`).** `comments.kind` gains
  `question`; an agent entering `awaiting` must supply `issue move … --question "…"` (or
  already have an unanswered question), which is written as a `question` comment in the same
  transaction (`QUESTION_REQUIRED` otherwise; a human may park silently). `awaiting → todo`
  becomes a legal edge — not a reopen, so the delivery round does not move and the claim is
  released — and **any human comment** moves the card there automatically (the resumed
  worker judges its content; a `decision` kind remains the I5 record). The waiting payload is now the
  newest `question` (falling back to the newest human comment), mirrored in `web/`. The loop
  gains `--opened-by human|supervisor` and a waiting-questions section in the continue
  prompt, and the turn/ledger/heartbeat clocks are stated as one contract: the turn must be
  `1200–7199` seconds and finish before the ledger's 2-hour reap (`LEDGER_STALE_MS`).
- **An epic's delivery is its rollup, and `done` checks it (migration `0033`).** Delivery
  reports gain `is_rollup` (only a `delivery` report on an `epic` may carry it; the DB refuses
  anything else with `ROLLUP_INVALID`). A report written on an epic is always a rollup and
  must name every live child by `ref` (`done` → `met`, `canceled` → `not_applicable` with a
  note, at least one `done`); a missing current-round rollup is `ROLLUP_REQUIRED`, one that no
  longer matches the children is `ROLLUP_STALE`. A `--no-report` waiver can no longer deliver
  a container, an empty epic has nothing to roll up, and `in_review → in_progress` (a new
  round) is the repair for a stale rollup. `report template <epic>` now reads the children and
  emits one `ref` item each; `issue reconcile` reports `rollup_stale` / `rollup_missing`
  read-only; the auto-accept and review-approve planners refuse a missing or stale rollup
  before the write gate would. The report wire gains `is_rollup`, and the markdown export
  marks rollup blocks (`rollup: yes`) and each item's `ref`. The epic `done` trigger only
  answers the legal `in_review → done` edge, so an illegal move still reports
  `INVALID_TRANSITION`.
- **The acceptance baseline is frozen, and `done` must cover it (migration `0032`).** A card
  now carries `acceptance_json` + `acceptance_revision`, seeded once at creation (or first
  claim) from `meta.acceptance` / the imported checkbox texts and never read from writable
  meta again. The list can be appended to (`issue update --acceptance`); only a human may
  remove an item, with `--drop-acceptance --reason` recorded as `acceptance_pruned`. The DB
  refuses any rewrite that does not bump the revision (`ACCEPTANCE_SNAPSHOT_IMMUTABLE`) and
  any `not_applicable` report item without a note (`REPORT_NOT_APPLICABLE_NOTE`). Moving to
  `done` now requires the current round's delivery report to cover the baseline
  (`ACCEPTANCE_UNVERIFIED` / `ACCEPTANCE_INCOMPLETE`); `met` and `not_applicable` pass,
  `partial` / `not_met` block, and a waiver no longer satisfies acceptance. A review
  `APPROVE` is checked against the original's baseline, and the auto-accept planner reads the
  report so it never plans a refusal. The task wire gains `acceptance[]` /
  `acceptance_revision`, the PATCH body gains `acceptance_drop` / `acceptance_revision`, and
  the markdown export prefers the snapshot while fixing the long-standing lost `meta.target`
  and emitting the delivery/review/waiver facts.

- **The package is the distribution: `npx meerkat-taskpanel` installs the server, `taskctl`
  and the skill for every supported agent kind.** The root manifest now declares
  `meerkat-taskpanel` (the installer), `taskd` and `taskctl` as bins, and its `files`
  whitelist carries the built `web/dist`, so the published tarball is a runnable board rather
  than a source drop; the release workflow stages the image's build there before `npm pack`.
  `--target all` is the default and means **every agent plus the server**: the installer
  materializes the runtime at `~/.meerkat-taskpanel` — `src/**`, `web/dist`, `bin/taskd`,
  `bin/taskctl`, a `.env` and `.data` — and installs the skill for all six agent kinds. Narrow it with
  `--no-server` (agent skills only), `--target server`, or an explicit list such as
  `--target claude,server,pi`; `--prefix`, `--force`, `--dry-run` and `--skip-web-build`
  steer it. The tree is self-locating: the launchers exec the tree's own `src/`, so it
  survives the checkout moving or the npx cache being pruned, and a combined install points
  the agent shims, loop config and `taskd` guard unit (`TASKD_DATA_DIR` pinned) at it instead
  of the checkout. Both entry points share one materializer
  (`scripts/install/lib/server-install.mjs`, invoked by `scripts/install/server.sh`). `.env`
  and `.data` are never overwritten, pruned or deleted — not even by `--force`. A
  container-only `scripts/verify/server-install.mjs` step installs through both entry points
  into throwaway homes and proves the installed `bin/taskd` answers `/health`. Docs, both
  READMEs and `docs/publishing.md`'s stale "name is taken" / "no `web/` in the tarball"
  claims are updated.

- **Per-project review policy and per-card review decision (migration `0031`).** A project
  now carries `review_policy` (`required` / `optional` / `off`, default `optional`) and an
  optional `reviewer` override; a card carries a `review_required` snapshot resolved at
  creation (`required` marks every ordinary card, `off` marks none, `optional` asks the
  creator; a `deploy` card is always marked, and a review card is always `0`). Review
  dispatch and the `done` gate read the card snapshot, never the project's current policy.
  A card at `0` is auto-accepted by the loop (`meta.accepted_by=loop-auto`) when the board's
  acceptance policy allows `taskd` to close its scope; under `human-only` a top-level card
  still waits for a human. The reviewer is `project.reviewer ??` the deployment reviewer;
  the loop merges every project reviewer into its scan/wake set and refuses to start when a
  `required` project has none, or when `agent-only` meets `auto-accept-reviews=no`. New
  surfaces: `project create/update --review-policy` / `--reviewer`, `issue create/update
  --review` (a non-human creator must state it in an `optional` project), and the markdown
  export's conditional `review_required: yes` key. `autoAcceptReviews` now gates only the
  review card's own close, not the no-review auto-accept path.
- **SLA is computed by the board and configured in `.env`.** The six card/board
  inspection rows of `docs/sla.md` now move server-side: `src/core/commands/sla.mjs`
  computes them from the board's own facts and the effective `TASKD_SLA_*` table,
  and `GET /api/v1/sla` publishes them (`taskctl sla list|get` is the CLI face).
  Sixteen keys in the install-root `.env` override the documented defaults — the
  per-row normal limit and further bound, the measurement period, the leader
  lookback and the peer-liveness parameters — validated as integers with
  `F ≥ L` and re-read per request, so a hand edit applies without a restart.
  The loop's patrol now only de-duplicates, re-reads a survivor
  (`sla get <ref>`), notifies, and keeps `inspector_liveness` (whose marker file
  lives on its host). The board may import `foundation/sla-patrol.mjs` through
  that one command; `src/cli` still may not (`test/cli/imports.test.mjs`).
- **The SLA contract is in the repository, and a confirmation request has a kind.**
  `docs/sla.md` is now the single source of truth for the threshold table, the tier ladder,
  the 09:00–23:00 Asia/Shanghai working-hours basis, the 26-field alert tuple, the
  de-duplication ledger, the pre-emit re-check and the peer-inspector marker format. The
  external SLA anchors / `team/guides` citations are gone from the live surface; `SLA_ROWS`
  references the document, and a test pins the two together. `confirm_request` is a new
  comment kind (migration `0030`) that opens a confirmation gate at high confidence; the
  legacy `[confirm-request]` marker and prose shape remain as fallbacks, and only a
  leader-authored `confirm` closes the gate. The router's request schema snapshot gains the
  new enum value.
- **Card details carry the attachment list.** The single-card read
  (`GET /api/v1/tasks/:ref`, `taskctl issue get <ref>`) now returns `attachments[]` with the
  same metadata as `attachment list`; the human `issue get` prints an attachment table. The
  markdown card gains an `## Attachments` section between Sessions and Report, written only
  when the card has files, so a card without attachments keeps its five-section shape. The
  board list and mutation responses stay lean; bytes remain on the board and are not in the
  card.
- **The identifier syntax is published in the installed skill.** `references/card-schema.md`
  now states both tiers: the permissive storable pattern (`isValidIdentifier`: 1–128
  characters, `[A-Za-z0-9][A-Za-z0-9._-]*`) and the generated shape `<PREFIX>-<serial>`
  (serial from 1, zero-padded to at least four digits, no overflow cap), plus the prefix fold
  and a copyable generated-form regex. A test re-derives every example against the code, so
  the page cannot drift.
- **`taskctl session id` derives a session id without registering one.** The id is exactly
  what `session set` writes for the same `(task, owner, seg)` — same namespace, same
  NUL-joined name — so a caller can hand it to a host as `--session-id` before the session
  exists. The command is read-only (a GET and a local derivation; no session row) and always
  derives: a global `--session-id` is ignored. The skill also ships
  `scripts/session-id.mjs`, a self-contained offline derivation for when the board is not
  running; it takes the resolved task UUID (`issue get --json` → `data.task.id`). Parity is
  pinned by a vector matrix against `src/foundation/ids.mjs`, including the namespace and the
  RFC 4122 test vector.
- **`taskctl issue list --review-of <ref>` filters to a card's review cards.** The read side of
  the 0025 review marker now has the filter the acceptance flow needs: the reviews of the
  named card (id or identifier), across every round, combinable with `--project`, `--status`,
  `--assignee-id` and `--include-archived`. It is read-only; an unknown ref is `NOT_FOUND`
  and an identifier used in two projects is refused (`VALIDATION_FAILED`) rather than
  guessed. `GET /api/v1/tasks` takes the same `review_of` query param.
- **`taskctl export md <ref>` exports one card, to a directory or one file.** The positional
  takes an id or identifier; with `--out <dir>` the card lands at `<dir>/<ID>.md`, and with
  `--out <file.md>` it is written to exactly that path (the parent must exist). `--check`
  compares only that card and keeps exit 3; `--project` cannot be combined with a ref. The
  server still renders (`POST /api/v1/export` takes `ref`), so the markdown stays
  byte-identical to the whole-board export. The CLI write path now applies the
  `MD_GROWTH_FACTOR` (4×) guard before every overwrite — the core exporter had it, the real
  path did not.
- **An agent session records a one-sentence goal.** `taskctl session set <ref> --seg … --owner-kind …
  --goal "<one sentence>"` stores what that conversation is working on on the session row
  (migration 0028), so concurrent segments on one card each state their own. Omitting `--goal` on a
  re-registration keeps the recorded sentence; `session list` and the drawer's Agent session trail
  show it. The markdown card's `## Sessions` line carries it as `goal:` between `id` and `phase`,
  escaped so the sentence may contain ` · `.
- **Done/canceled cards can be reopened to `todo`.** `taskctl issue reopen <ref> --reason "<why>"`
  (and `POST /api/v1/tasks/:ref/reopen`) returns a finished card to the queue with an audited
  `task_reopened` activity, starts a new delivery round, clears its archive and releases its
  idempotency key. `in_progress` is not a reopen target; review cards are refused (reopen the
  original). The board's drawer offers the action behind an 8-character reason prompt.
- **`meerkat-loop` for OpenCode and Cursor.** The supervisor now ships to both hosts:
  loop skill and body, scheduling units, and `wake-opencode.sh` / `wake-cursor.sh`.
  `--host` and `--supervisor-hosts` accept `opencode` and `cursor`; OpenClaw remains
  excluded. OpenCode's wake is `opencode run` (resume `--session`); Cursor's is
  `cursor-agent -p` (resume `--resume <sid>`, `--continue`). The flag-level probe and a
  real `-p` round trip (`--e2e`, gated on `CURSOR_API_KEY`) live in
  `scripts/verify/host-resume-matrix.mjs`; `--wake-command` remains the escape hatch.
- **One config file: `.env` at the program install root.** `taskd`, `taskctl` and the loop's
  SSE endpoint now read `<program root>/.env` (the checkout root, or the npm package root) for
  the board URL, the client token, the allow-list and the acceptance policy. Precedence is
  CLI flag > process environment > `.env` > default, key by key, so `$TASKD_TOKEN` overrides a
  `TASKD_TOKEN_FILE` in the file. `--env-file <path>` and `MEERKAT_TASKPANEL_ENV_FILE` select
  another file. Values come only from the known `TASKD_*` / `TASKCTL_*` /
  `MEERKAT_TASKPANEL_*` keys — a shared `.env` carrying `VITE_*`, `PATH` or `NODE_OPTIONS` is
  ignored, and an unknown key inside our own namespaces is an error rather than a silent
  no-op. `install.sh` seeds a `.env` with `TASKD_URL=http://localhost:9527`; the Access panel
  writes to the same file. Two new codes: `CONFIG_FILE_INVALID` (unreadable, malformed,
  unknown or conflicting keys, bad URL/port, a missing explicit token file) and
  `CONFIG_FILE_INSECURE` (an inline token or explicit token file that is group/world
  readable). `TASKD_URL` also makes a remote board usable without repeating `--url`: a live
  configured URL is used, a dead non-loopback one is an error rather than an autostart.
- **Every `taskctl` invocation carries an identity.** `--actor-kind` (platform: `claude`,
  `codex`, `openclaw`, `pi`, `opencode`, `cursor`, or `system` for automation) — or
  `TASKCTL_ACTOR_KIND`, or `--as-human` — is required on every command except `--help` and
  `--version`; omitting it is `CLI_USAGE`. The id is a role: `--agent jobs|linus|turing`
  overrides the `TASKCTL_AGENT` default, and a non-human id no longer falls back to
  `TASKCTL_HUMAN`. `--actor-kind human` is still refused; a human write uses `--as-human`.

### Changed

- **BREAKING: the platform vocabulary is now `kind` / `actor kind`, and "host" means only
  the machine.** An application value (`claude`, `codex`, `pi`, `opencode`, `openclaw`,
  `cursor`) is an **actor kind** — the same word records use (`author_kind`, `owner_kind`)
  and the CLI already takes on `--actor-kind`. An **agent** remains the recorded identity
  (`--agent jobs|linus|turing`, `--agent-name`); it does not name the application. Every
  former "host" surface follows: `supervisor.mjs --host` → `--actor-kind`,
  `install.sh --supervisor-hosts` → `--supervisor-actor-kinds`, `scripts/loop/hosts/` →
  `scripts/loop/actor-kinds/`, `TP_HOST`/`{{HOST}}` → `TP_ACTOR_KIND`/`{{ACTOR_KIND}}`,
  the profile key `host:` → `actor_kind:`, and the verify tools `host-cli`/`host-runtime`/
  `host-resume-matrix`/`host-session-matrix` → `kind-*`. The SLA alert field
  `mechanism_host` becomes `mechanism_actor` (its value is `<kind>/<agent>`). No aliases are
  kept: re-run `install.sh --force` and reload the scheduling units, because the rendered
  launchd labels / systemd descriptions and the `--host` argv changed with it. Upgrades also
  ignore the old `host:` session state and `mechanism_host` last-ok key; nothing migrates
  them. Docs and both READMEs now say **agent kind** and reserve "host" for the machine.

- **The concurrency cap is one demand-driven budget.** `--max-concurrency` (default
  8) now reads from the host config (`MEERKAT_TASKPANEL_MAX_CONCURRENCY`) as well as
  the flag and environment, so an installed unit can be tuned without re-rendering
  it. Workers and reviewers share the same budget and compete for slots by demand —
  there is no per-role reservation, and at 8 the 6-worker/2-reviewer mix is a nominal
  steady state, not a guarantee. The resolved value always travels into the child
  poll, so a continue turn cannot re-resolve a different cap.
- **The loop is resident: a session pool dispatches subagents, and poll only
  claims and enqueues.** `supervisor.mjs --session` (the new `session` unit) owns a
  long-lived control session in the taskpanel checkout plus **one project session
  per target directory**; the project session spawns the worker/reviewer as a
  subagent, which inherits the project directory as its cwd. Poll resolves the
  card's project directory through `projects.json` **before** claiming it, claims
  atomically, and writes the handoff to `cards.pending.json`; it no longer starts a
  host process. The durable queues (continue, cards), the subagent ledger, resume
  and native reattach, per-project and global concurrency, idle eviction and a 24 h
  session max-age are all new. With no live pool — cron, a stopped session unit,
  `--resident=no` — poll claims nothing, one `--notify` alert per cadence says so,
  and the one-shot continue turn runs patrol + workflow only. The loop skill is now
  **command-only** (`disable-model-invocation: true`): the continue prompt begins
  with `/meerkat-loop Continue — …`. New flags/config: `--session`,
  `--resident`, `--session-*`, `--project-concurrency`, `--project-idle-ms`,
  `--subagent-background`, and the authorized full-tool-access opt-in
  `--allow-all-tools` + `--allow-all-tools-reason` (off by default; the reason is
  required, and the project directory is not an isolation boundary). The legacy
  glue/`--wake-command` path remains for manual and old installations and keeps
  the no-default-bypass rule. Resident
  adapters ship for all five hosts — Claude Code stream-json, Codex app-server
  threads, Pi `--mode rpc`, OpenCode `serve` (one per directory), Cursor ACP. See
  `docs/scheduling.md` §The resident session pool.
- **The external protocol document's name is gone from the tree.** The remaining external
  section anchors have been rewritten to the product's own sources: creation idempotency to
  `src/core/README.md`, SLA thresholds to `docs/sla.md` §2/§3, relation caps to
  `RELATION_FANIN_MAX` / `RELATION_CHAIN_MAX`, terminal states to `status.mjs`, and timestamps
  to migration `0001` / `task.mjs`. Prototype and design-contract comments were rewritten too;
  the only retained literal is the historical raw-output block in
  `design/contracts/naming-boundary.md` §9, plus the negative guard in
  `test/scheduling/sla-patrol.test.mjs`. No gate was changed.
- **The SLA patrol reads what the board and the peer actually say.** Five correctness fixes:
  the inspector boundary now uses the cadence a peer declares in its last-ok marker (fallback
  15 min) instead of a hard-coded one; an acceptance wait on a capped board read is still
  reported but marked undecidable at `confidence: "low"`; a fresh confirmation gate re-reads
  the card's trail immediately before notifying and drops itself when the leader has answered;
  a blocked card's "answered" hint and a gate's closing `confirm` both require a leader author
  (a worker's comment no longer releases a card or closes a gate); and `--notify` is bounded at
  10 s so a hung notifier cannot stall the pass. `patrol` also logs a warning when
  `--sla-leader` matches a display name rather than an actor id.
- **The continue prompt opens in English.** The loop's periodic judgment turn now starts with
  `Continue — Meerkat TaskPanel loop, judgment turn.` rather than `继续`; the scheduled units,
  the skill text and the docs quote the new cue. Behaviour is unchanged: the host reads the
  prompt as text, not as a keyword.
- **Breaking: an agent session's `backend` is now `owner_kind`.** The column, the wire field, the
  `session set` flag (`--backend` → `--owner-kind`) and the markdown `## Sessions` field all use the
  one spelling; migration 0029 renames the column in place (`RENAME COLUMN`, no rebuild). The value
  is unchanged — an actor's platform kind (`claude`, `codex`, `pi`, …) — but the old word is gone
  from the API and the card grammar, with no compatibility alias.
- **The drawer's Activity trail lists newest first.** `GET /api/v1/tasks/:ref/activities` takes an
  optional `order=asc|desc` (default `asc`, which the SSE replay cursor needs); the drawer asks for
  `desc` with `limit=50`, so it now shows the newest 50 events rather than the oldest 50. An unknown
  `order` is `VALIDATION_FAILED`, like `GET /tasks?order=`.
- **Breaking: `src/shared/` is now `src/foundation/`.** The layer's name now describes its
  role (the dependency floor: `cli|server → core → foundation`, importing nothing from
  `src/`) instead of its audience. Because the package ships `src` without an `exports` map,
  deep imports such as `meerkat-taskpanel/src/shared/constants.mjs` must move to
  `meerkat-taskpanel/src/foundation/constants.mjs`. The loop payload follows: its foundation
  copy lives at `skills/meerkat-loop/scripts/foundation/**`, and the skill carries no `src/`
  tree. Foundation copies are byte-for-byte; the 14 generated entry scripts differ only in
  their foundation import specifiers (`../src/foundation/x` → `./foundation/x`), which
  `sync-loop --check` verifies. Host-installed paths move from
  `<host>/meerkat-taskpanel/src/shared/**` to `<host>/meerkat-taskpanel/scripts/foundation/**`;
  an old tree is inert after the upgrade and can be deleted by hand.
- **The loop skill no longer wraps its generated payload in `body/`.** `manifest.txt` and
  the generated `scripts/` + `src/` trees now sit at `skills/meerkat-loop/`, alongside the
  authored `scripts/board-check.mjs` (which `sync-loop.mjs` never writes, prunes, or reports
  as stale). Copied modules stay byte-identical because their relative imports are unchanged;
  host-installed paths (`<host>/meerkat-taskpanel/{scripts,src}`) are unchanged. An older
  host may retain an inert `<host>/skills/meerkat-loop/body/`; `--force` replaces it.
- **Breaking: `<dataDir>/taskd.env` is no longer read.** The allow-list and acceptance policy
  now live in the install-root `.env`; there is no runtime fallback. An existing installation
  must move the keys by hand (`mv <dataDir>/taskd.env <program root>/.env`, merging with any
  keys already there). `install.sh` prints this hint when it finds the old file; it does not
  move or read it.

### Removed

- `ACCESS_ENV_FILE` and `ACCEPTANCE_ENV_FILE` and the `<dataDir>/taskd.env` path helpers.
  Config writers now create a missing parent directory but never `chmod` an existing one.

- **The board skill is now a taskctl manual, not a design archive.** The skill's prose was
  reduced by roughly half: each rule has one home (`status-lifecycle.md` for the state model,
  `cli.md` for the command surface and the `--json` contract, `card-schema.md` for the card
  file, `reports.md` for periodic reports, `projects-json.md` for the local directory map),
  and the restatement, migration history and `src/…` provenance were removed. The two
  references that carried no instruction of their own — `practice-guides.md` (an abridged copy
  of `SKILL.md` plus per-host install guides) and `scheduling-integration.md` (the loop's
  topology) — were deleted; the few unique rules (conflict retry, session id, the tick recipe,
  the `--json` machine contract) moved into `SKILL.md`. The loop still depends on the board
  skill; the board skill no longer depends on the loop.

- **The board skill no longer ships periodic reports.** `references/reports.md` and
  `scripts/report.mjs` were deleted, along with their test. The skill is now strictly a
  `taskctl` manual for task handling, status and workflow; computing statistics or a daily /
  weekly / monthly report is a consumer concern. `taskctl issue list --json --include-archived`
  already returns every card's `status`, `status_changed_at`, `created_at` and `updated_at` —
  the same envelope the deleted generator read — so any aggregation can be written against it.
  Per-card delivery reports (`taskctl report`, `--report-file`, `report_waived`, rollup) are
  unchanged. An existing host install keeps the old files until it is re-installed with
  `--force`.

### Changed

- **The `ready`/`failed` status aliases are removed.** The markdown export always writes the
  canonical status; the inbound alias resolver and its tests were dead code since the
  markdown importer was removed. A stored `meta.legacy_status` is now inert, and a card that
  used a legacy word exports `todo` / `canceled`.
- **The markdown card no longer carries `## Progress`.** It rendered only the imported
  `progress` activity event, whose sole writer was the removed markdown importer, so a new
  card always exported an empty section. The audit trail remains a separate board read
  (`GET /api/v1/tasks/:ref/activities`); historical `progress` rows are still there.

### Fixed

- **The review workflow is tightened and no longer silently loses state.** A review card
  whose original re-delivered (round ≥ 2) now applies its verdict: the planner parsed the
  original's `review_round` instead of the review card's own delivery round, so every later
  round read as `verdict_unreadable`. `issue create --review-of` now requires the original to
  be `in_review` (a retried create still returns the existing card), and a `parent` relation
  refuses a review card on either end (`VALIDATION_FAILED`, `details.field = source|target`,
  not bypassable with `--force`) because a review child inherits child acceptance scope and
  breaks the original's rollup. A truncated board read marks `original_unseen`
  `reason: board_truncated` / `undecidable: true` under its own ledger key instead of
  implying the original is gone; the combined `maxActions` slice reports `actions_capped`
  (cap / dropped / outcomes / dispatch, notified once) rather than dropping work silently;
  and `agent-only` with `--auto-accept-reviews=no` raises `review_cards_unclosable` for each
  open review card plus a loop startup warning, since neither a human nor the loop may close
  them. `references/review-workflow.md` documents both flows, the verdict protocol and these
  refusals.
- **The markdown card's `## Acceptance` section now carries modern acceptance criteria.**
  `issue create/update --acceptance` stores `meta.acceptance` (a string list), but the
  exporter only read the imported `meta.acceptance_legacy` checkbox list, so a modern card
  exported an empty section. Modern criteria now render as plain bullets, one per line; an
  imported card's checkboxes are preserved, and the modern list wins when both exist (the
  same precedence as `report`).

### Changed

- **Any human comment now resumes an `awaiting` card.** The board no longer requires a
  `decision` / `confirm` / `change` kind to re-queue it: a human's reply from the board's
  comment box, the CLI or the API moves the card back to `todo` in the same transaction,
  whatever its kind. The board does not read the text — the resumed worker judges from the
  content whether the answer is a complete decision (approve, reject, or still incomplete),
  and an incomplete answer asks again and returns the card to `awaiting`. `decision` /
  `confirm` / `change` remain the explicit I5 record a reviewer reads; the loop still never
  writes a decision kind or uses `--as-human` for its own answer. A team's own
  `.meerkat/roles/decision-policy.md` overrides the shipped default and must be updated
  separately.

## [1.1.0] - 2026-10-20

### Added

- **The board owns the workflow decisions; the loop executes them.**
  `src/shared/workflow.mjs` moved to `src/core/domain/workflow.mjs`, and a new
  `src/core/commands/workflow.mjs` assembles a bounded board snapshot for it.
  `taskctl issue reconcile --workflow` (and the same route,
  `POST /api/v1/tasks/reconcile`) now performs the board's container reconcile and returns
  the review outcomes/dispatch plan; the loop applies the plan's review actions and no
  longer carries the decision module. The loop requires board **1.1.0**. The board skill's
  new `references/status-lifecycle.md` consolidates every status, transition, guard,
  delivery-round rule, claim/heartbeat window, acceptance policy × scope matrix, creation
  gate and refusal code, and is pinned to the domain table by a drift test.

- **Acceptance is a board policy: `human-only` | `both` | `agent-only`.** `in_review →
  done` is no longer a fixed "human or taskd" rule. `both` (the default) keeps the
  historical behaviour; `human-only` lets only a human close a **top-level** card (children
  and review cards are still the agents'/loop's to close); `agent-only` lets any non-human
  writer close one. The policy lives in `<dataDir>/taskd.env` (`TASKD_ACCEPTANCE_POLICY`,
  merged beside the Access panel's keys and re-read per decision), and `install.sh
  --acceptance=` writes both the board's copy and the loop's. The loop records a
  `human-only` top-level approval, closes the review card and leaves the card `in_review`
  for the human (a `meta.review_verdict` marker makes the hold idempotent); "Waiting on
  me" now lists those deliveries. Two new structural gates make the flow safe: a card may
  not enter `in_review`/`done` with a non-terminal child (`CHILDREN_OPEN`, migration 0026),
  and a human closing a top-level card needs the current round's reviews resolved
  (`REVIEW_PENDING`). Review identity moves from the writable `meta.review_of` into the
  immutable `tasks.review_of_id` / `review_round` columns (migration 0025).
- **Workers derive the acceptance list when a card has none.** The wake handoff and the
  board skill now tell a worker to read the card with `issue get --json`; when both
  `meta.acceptance` and an imported `meta.acceptance_legacy` are empty, it derives 1–6
  externally checkable acceptance items from the title, description, labels and comments,
  persists them with `--acceptance`, marks them `meta.acceptance_derived=yes`, and leaves a
  `change` comment listing them. Existing lists are never rewritten, epics and review cards
  are skipped, and a reviewer audits a derived list for coverage; `report template` warns
  when it seeds that list.
- **The loop can be event-driven.** `supervisor.mjs --subscribe` holds one SSE connection
  to the board and asks for a continue turn when a dispatch-relevant event arrives
  (coalesced, at most one turn per minute). It does not claim or wake by itself: the
  existing continue turn still scans, claims and dispatches, so there is one dispatch
  path. launchd and systemd get a long-lived subscribe unit; cron stays on the continue
  cadence, which also remains the only path for time-based work (stale claims, review
  aging, SLA).
- **Every surface that can change now records an event.** Project metadata/README,
  attachment create/content/delete, and a completed markdown import (one
  `import_completed` row with counters, not one per card) join the activity stream;
  `relation_removed` carries both endpoints and `task_archived` carries the status it
  left. The web board consumes them: the open drawer refreshes its relations, reports,
  sessions, attachments and trail; the waiting queue re-reads the question when it can
  change; archived cards leave the board; project counts and the actor/label rosters
  refresh on a trailing debounce; and the first stream connection seeds from
  `/meta.revision` instead of replaying the whole audit trail.
- **Actor kinds name a platform.** The board writes `taskd` (its own concrete platform
  name) rather than the vague `system`, automated acceptance recognises `human`/`taskd`,
  and the command layer no longer invents an `agent` kind when the caller did not name
  one. `test/contract/actor-kind.test.mjs` keeps new `system`/`agent` kinds out of the
  source; historical rows are left as recorded.
- **Every read shows its skeleton.** Switching projects — from the sidebar or the top bar's
  dropdown — puts the board, list, activity and 「等你回复」 views into their skeletons until the
  new project's read lands, instead of briefly drawing the previous project's cards (and a failed
  switch no longer leaves them behind). The activity backfill and the waiting queue's comment
  reads do the same, and opening a card now slides the drawer in immediately with a skeleton
  head and body while its detail loads, where it used to stay invisible until every read
  returned. Skeletons follow **reads, never a timer**: a view switch with its data already in
  hand stays instant.
- **A container closes itself: the epic rollup.** When the container's children are all finished
  — every child `done` or `canceled`, and **at least one `done`** — the board writes the
  container's rollup report (one acceptance line per child, plus the children's own delivery
  evidence, authored by the board itself as `system` / `taskd`) and moves the epic to `in_review`
  in the same transaction as the move that completed the set — the last child's `done`, or the
  `canceled` that finishes it. A `canceled` child is terminal, so it does not
  hold the container open; the report lists it as `not_applicable` with the reason the card's own
  comment trail records, because whether finishing without that work was right is a human's call
  — the acceptance material states the cancellation instead of hiding it. Human acceptance still
  gates the tree: a nested container reaches `in_review`, never `done`, so its parent keeps
  waiting until a human accepts the inner one. Two cases stay manual by design: a container with
  **nothing delivered** (every child canceled, or every delivered child waived under
  `--no-report`) has no evidence to roll up and stays open.
- **The container starts itself, and a reconciler repairs both transitions.** The first child to
  enter `in_progress` moves its epic `todo → in_progress` — a **system** move, not a claim
  (`claimed_by` stays NULL, an `epic_auto_start` activity is recorded, and the board writes a
  `kind=note` comment naming the child). The rollup close now writes the same note, naming its
  source (`event` | `sweep`), the basis (`N/N` children) and the instant. `taskctl issue
  reconcile [--dry-run]` replays both rules over every non-terminal epic: it is the backstop for
  a child attached after it started or finished (which fires no status transition) and for a
  write that bypassed the service layer. It is idempotent — a second run writes nothing — and
  the same sweep runs once at `taskd` startup. A create can no longer be born `in_progress`
  (any kind), and an epic's initial status is `backlog` or `todo`; this closes the
  holderless-`in_progress` epic hole.
- **A `todo` epic may now be delivered (`0024`).** An epic is never claimable, so `todo` was a
  state with no exit: `done` is reachable only from `in_review`, and `todo` had no edge there —
  `issue create --kind epic`, which births a container in `todo`, produced a card no legal path
  could close. Migration `0024_epic_deliver_from_todo.sql` adds the pair **for `kind = epic`
  only** and re-arms the delivery gate for the new source status: the report is still required,
  and a `task` in `todo` still cannot reach `in_review`.
- **A gate against signposts out of the repository: `scripts/verify/signposts.mjs`.** This
  project interoperates with an external development framework that keeps its own task store
  in a private directory under the user's home. A document that names one of that framework's
  internals *in a walkable form* is an instruction to go there, and this repository is
  greppable — so a session reading it follows. That is not hypothetical: a design contract
  that spelled the framework's card-writer path **in order to declare the word forbidden**
  became the signpost, and a session followed it out of the repository and created cards in
  the external store. The gate fails on either shape — a **home-relative path** into that
  private store (the two subpaths a shipped feature legitimately integrates with, the card
  directory and the project registry file, are carved out inside the rule rather than parked
  on an allowlist), or one of the framework's **internal mechanism names**. What it
  deliberately does *not* ban is the larger half: framework names that name somebody else's
  thing, attributed and not used as our own — the project name, the interface-generation
  codename the loop declares, and the external SLA anchors the patrol then published as a
  wire field and the test suite asserted. Its one exemption
  (`test/fixtures/framework-signposts-allowlist.json`) is keyed by `{file, rule}` rather than
  by file, so that the contract which must write the forbidden terms is not thereby also
  allowed to spell the store path. It runs in `npm run verify`, in `.githooks/pre-push`
  (which now also runs the host-path gate — its documented claim to do so had been false),
  and in CI as `signposts-gate.yml`; CI is authoritative, because the container image drops
  `design/`.

- **The host-external supervisor is a skill of its own: `meerkat-loop`.** The loop was an
  implicit side effect of installing the board; it is now a self-contained, separately
  distributed skill (`skills/meerkat-loop/`) carrying the execution body, the unit / wake /
  host-config templates and an operator reference. It is distributed to **claude, codex and
  pi** by `install.sh --target claude|codex|pi`, and **never to OpenClaw** — permanently, by
  ruling: the openclaw-team framework already ships a per-agent poll / a `task-patrol`, which
  is the same design, and two supervisors on one board would only race each other for the
  same cards. The board skill still goes to all six hosts, and every one of them reads the
  repository's own `skills/` tree in place through a manifest at the repository root — the
  board's plugin root *is* the repository root.
  The loop skill **declares the board interface generation it requires** —
  `task-interface v1`, the surface the board first shipped in release 1.0.0 — and its
  `scripts/board-check.mjs` enforces that against the board's own `taskctl --version --json`
  answer, exiting 3 rather than guessing when the board is too old or cannot be asked. That
  interface floor is the only coupling: the loop carries **no version of its own** and moves
  with the board (see *Removed* below).
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
- **Two more harnesses: OpenCode and Cursor.** Both read the repository's own `skills/` tree
  in place and add no committed copy — the rule the distribution refactor below established.
  - **OpenCode** (`.opencode/plugins/meerkat-taskpanel.js`) registers the shared directory
    through the host's plugin API: on V1 the `config` hook pushes `<root>/skills` into
    `config.skills.paths`, on V2 (`>= 2.0.4`) `default.setup(ctx)` adds one `Skill.Info` per
    `skills/<name>/SKILL.md`. Since V2 dropped the directory form, the V1 hook recognises
    V2's flat `config.skills` array and stands down. Nothing is injected into bootstrap: the
    board's session opener stays an install-side concern.
  - **Cursor** (`.cursor-plugin/plugin.json`, `"skills": "./skills/"`) makes the repository
    root a Cursor plugin root too. No hooks, deliberately — Cursor's hook contract is its own
    schema and the upstream reference implementation has no uninstall/update path for it yet,
    so the delivery is skills-only, as the Claude plugin and the OpenClaw bundle are.
  - Both are **directory-granular**: a host handed a directory gets both skills, so OpenCode
    and Cursor receive the board and the loop together.
  - **A contract change this forced.** The root now carries two client markers and OpenClaw's
    detection precedence is codex → cursor → claude, so OpenClaw reports the root bundle as
    `Bundle format: cursor` instead of `claude`. Measured on OpenClaw 2026.9.8 with and
    without the marker: that is the only line that changes — `Format: bundle`,
    `Shape`, `Capability mode` and `Bundle capabilities: skills` are byte-identical, and the
    skills load either way.
  - **Honest gap, documented rather than papered over:** neither the OpenCode nor the Cursor
    CLI is available on the development host or in the container, so neither host integration
    has ever been run from here. OpenCode's plugin logic is covered offline by
    `test/install/opencode-plugin.test.mjs` against a fake plugin context; Cursor's marker is
    covered by the manifest and bundle assertions. See `docs/install.md`.
- **`issue heartbeat <ref>` — the heartbeat finally has a write surface.** The eight shared
  rules have always told an agent to "keep the heartbeat fresh (≤10 minutes)", but no CLI
  flag, route or request schema could write `heartbeat_at`: the core op existed
  (`tasks.heartbeat`, with `setHeartbeat`'s holder-only CAS behind it) and the rule named a
  command nobody could run. The only way to move the timestamp was a full round-trip out of
  `in_progress` and back — and inside the 10-minute window even that is a `reuse` that does
  **not** reset it — so a card parked in `in_progress` alerted as abandoned with no way to say
  otherwise. The pulse is reachable end to end now: the op is declared in `TASK_OPS`
  (`src/core/commands/tasks-input.mjs`), the route is
  `POST /api/v1/tasks/:ref/heartbeat` (frozen in the contract snapshot), and the CLI is
  `taskctl issue heartbeat <ref>`. It takes **no body field** — the card is the path's `:ref`
  and the pulsing actor is the caller — and it refreshes `heartbeat_at` and nothing else: not
  the status, not the claimer, not the delivery round, so it can never resurrect a card
  somebody else has moved. Only the holder may send it (`EXECUTION_ACTIVE` otherwise); a card
  that is not `in_progress` is refused `INVALID_TRANSITION` ("nothing to pulse"). The write is
  recorded as a `task_heartbeat` activity, which the board already classified as SSE noise
  (`SSE_NOISE_EVENTS`), so a pulse never wakes a board client.
  **The ruling it settles:** the heartbeat belongs to the **agent**, not to the loop. A
  supervisor-written pulse would be a proxy lie, and it would permanently silence the
  `heartbeat_stale` SLA row — the one mechanism that notices a worker has stopped.

### Changed

- **The loop is now a scheduler with two clocks.** `scripts/supervisor.mjs` no longer reads the
  board: it owns a 60-second **ping** (prune dead worker pids; no board read, no LLM) and a
  10-minute **continue** turn (wake the host with a bounded `继续` prompt). Poll, patrol and
  workflow are independent entries under `scripts/loop/`, invoked by the continue turn in the
  order patrol → workflow → poll. The installed units are now `ping`/`continue` (60s / 600s);
  `--supervisor=enable` takes the legacy `poll`/`patrol` units down before loading them, and a
  bare `--once` still runs the legacy poll pass so a partially upgraded host keeps discovering
  work. The trade-off is a work-discovery latency of at most one continue cadence
  (`--continue-interval`).
- **The naming-boundary contract is retired and narrowed, not executed.**
  `design/contracts/naming-boundary.md` adjudicated which words of the external framework may
  appear in this repository, and laid out a three-batch cleanup plus independent acceptance
  criteria. It was written on 2026-10-14, **never double-signed, and never executed**: when
  it was reviewed on 2026-10-17 the sign-off boxes were still empty, two of its five criteria
  had never held (the external SLA anchors were *then* published data — a wire field the
  patrol emitted and the suite asserted — and the framework's project name is a sanctioned
  pointer),
  and the vocabulary it meant to shrink had grown from 6 files to 29. It is now marked
  **retired and narrowed**: the batch plan and the criteria are kept as history, a current-state
  table says where each framework word legitimately lives today, and only two bans remain
  live — the private store path and the internal mechanism names — with
  `scripts/verify/signposts.mjs` as their enforcement. The walkable paths it used to spell
  (in it and in three other design documents) were rewritten to describe the location
  instead of naming it, and its stale `plugins/**` targets and baseline counts are marked
  void.

- **The repository root is the board's plugin root; three bundle directories were deleted.**
  `plugins/claude/`, `plugins/codex/` and `plugins/pi/` are gone, and the marketplace source
  moved from `./plugins/claude` to `./`. Each harness's manifest now sits next to the one
  `skills/` tree and points at it, so claude, codex, cursor, pi and opencode need no generated
  copy: `.claude-plugin/plugin.json` was lifted out of `plugins/claude/` unchanged, and Codex
  turned out to need nothing of its own at all — it reads the same repository-root
  marketplace and installs the same `./` bundle, so `plugins/codex/` was dead weight.
  - **Pi** declares itself in the root `package.json` — `pi.skills` names the shared tree and
    `pi.extensions` names `.pi/extensions/meerkat-taskpanel.ts`, which re-registers that
    directory at load time through Pi's `resources_discover` event, resolving its own path so
    it follows the install location. `plugins/pi/` is deleted with it.
  - Together: **6 → 3 `skills` directories** (68 → 35 committed copy files, as measured when
    this landed). What remained was the floor the plan called irreducible — the OpenClaw
    native manifest and the loop's own marketplace bundle — both since removed as well, so
    the repository is down to **one `skills` directory and no copies at all** (see
    *Removed*).
  - Gates followed the move: `HOST_BUNDLES`' claude/codex/pi rows point at `.`, the OpenClaw
    probe re-points at the repository root, and `manifests` / `version` / `profiles` /
    `pack-manifest` / `host-cli` and their tests were re-pathed. `package.json#files` names
    each dot-directory explicitly, since npm does not include dot files by default
    (verified with a real `npm pack`).

- **`sync-skills.mjs` generates, but copies nothing.** With the last two bundles gone it has
  one job — generating the loop skill's payload (`body/` + `templates/`) from the repository's
  own modules and installer templates — and `--check` guards that alone. The "exactly one
  `skills` tree" invariant therefore moved out of it entirely and into
  `test/scaffold.test.mjs`, which asserts against the checkout that `skills/` is the only
  `skills` directory and that no `plugins/` tree exists. That is deliberate: a table can only
  describe the copies it knows about, and with no copy targets left `--check` could not notice
  an orphan tree a future harness added.
- **The heartbeat rule now names the command that satisfies it.** `buildHandoff` (the
  supervisor's wake prompt) lists `taskctl issue heartbeat <ref>` beside the read and the
  deliver; the Claude `session-start.sh` rule 4 and the Codex `AGENTS.md` snippet name it; and
  `README` / `SKILL.md` / `references/cli.md` / `references/practice-guides.md` say plainly
  that the board sends **no** pulse of its own — nothing but the holder knows the work is still
  going. Before this, four surfaces stated an obligation with no command behind it.
- **A `projects.json` entry no longer has to name a directory — and a project that has none
  may still be woken through a `run_dir` launch pad.** The map's rule is now
  `dir = local_path ?? run_dir`: `local_path` stays the project's own directory (unchanged for
  every entry that has one), and the new optional `run_dir` names where a worker starts for a
  project that has no directory of its own. An entry that names **neither** is the complete
  answer *"this project has no local directory"* — for operations or coordination work that
  never touches the disk — and `taskctl project dir <id>` now reports it and succeeds
  (`dir: null`, exit 0) instead of failing with `PROJECT_DIR_REQUIRED`. That code survives for
  a genuinely unusable value (a key that is present but blank, or a path that is relative,
  missing or not a directory), and a project with **no entry at all** still fails
  `PROJECT_DIR_UNMAPPED` and asks which directory it should be — the two answers stay
  distinguishable. A **wake** needs somewhere to start a worker, so both of the "no directory"
  answers refuse it (exit 3, with its own reason), as before. Two boundaries restated alongside
  it: the keys beyond `project`/`local_path`/`run_dir` are **the business's metadata** — read by
  the agent from the file, never prescribed, validated or interpreted here — and the directory is
  where a **worker** runs, not where results are stored: where a task's output lives, or whether
  it is kept at all, is not the board's business. `run_dir` deliberately takes no part in the
  directory → project lookup, and a `local_path` that is *omitted* (or `null`) falls through to
  `run_dir` while one that is given but blank is a failure to fix rather than a reason to fall
  through. See
  [`references/projects-json.md`](skills/meerkat-taskpanel/references/projects-json.md).
- **`pre-push` now refuses a direct push to `main`.** `main` advances through a pull request,
  so a mistaken `git push origin main` (or a `--delete` of it) is caught locally, before the
  round trip, instead of by the branch-protection rule on the remote. A deliberate release
  push says so — `ALLOW_PUSH_MAIN=1 git push origin main` — and only that rule is silenced;
  the two API gates still run. The hook remains a courtesy (`git push --no-verify` bypasses
  everything here), and the GitHub rule is the enforcement. See
  [`.githooks/README.md`](.githooks/README.md).
- **An actor's `kind` is a platform, and it lives on the record** (migration **`0023`**).
  `0019` put the kind on the `actors` row and removed the per-reference copies. That row is
  `UNIQUE(normalized_name)` — **one row per person** — and a kind describes an *act*: the same
  handle works from `claude` today and from `codex` tomorrow, and one row cannot hold both. It
  also kept the **first** kind it was ever given, so the column could be *wrong* with nothing
  able to tell. The kind moves back onto the three references that record an act —
  `tasks.assignee_kind`, `tasks.reporter_kind`, and a new `tasks.claimed_kind` — and
  `actors.kind` is dropped. `creator_id` does not come back: `0019` collapsed provenance to
  `reporter_id`, and nothing here needs a second provenance column.
- **The kind vocabulary is no longer narrowed in the application layer either.** `0018` opened
  the two author-kind columns in SQL, but five places re-imposed a `agent | human | system`
  list on top: the domain's `ACTOR_KINDS` / `DICT_KINDS`, `actorOf`, `actorFromRequest` (which
  **rewrote** any other kind to `human`), and the declared request schemas. So a platform was
  unrepresentable, and — because the board reads `kind === human` to decide whether a comment
  goes on the record as a decision (I5), whether an `awaiting` card resumes, and whether the
  patrol counts the leader as acting — a write naming a platform was recorded as a person's.
  The rule is now the schema's own: **any non-empty string, with `human` the one reserved
  value**. `--actor-kind` states what a writer is; `human` is refused, and `--as-human` is the
  one write made in the person's voice.
- **The registry read reports a kind it derives, not one it stores.** With `actors.kind` gone,
  `GET /api/v1/actors` aggregates each actor's kind from the references that recorded one (the
  latest wins; `human` breaks a tie, because reading a person as an agent opens the agent-only
  affordances where reading an agent as a person only costs a badge). An actor nothing has ever
  named reports `null`. Nothing is denormalised, so nothing goes stale.
- **The markdown importer no longer carries a roster of person-names.** It recognised a human by
  a hardcoded, case-insensitive list of names and filed every other author as an agent — a
  machine's list of who its people are, in a public repository, and a silent misread for anyone
  it did not name. The rule is now: **the board knows exactly one human**, the one
  `install.sh --human-name` recorded (`TASKCTL_HUMAN`), matched through `norm`; everything else
  is an agent. A card that knows better declares it — `created_by_kind`, a new frontmatter key
  beside `created_by`, isomorphic to `assignee_kind`.
- **`assignee_kind` and two new keys round-trip through a card.** The drill used to report
  every `assignee_kind` as an unmappable field-drift, because the column had no export home.
  `assignee_kind`, `created_by_kind` and `claimed_kind` are now written back — each **only when
  it differs from that column's default**, so a card that never carried one does not grow a
  line and the checked-in goldens are untouched. The drill's false `field-drift` item is gone.

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
- **A gate on host-absolute paths, so the cleanup above cannot come back.**
  `scripts/verify/paths.mjs` fails a build in which any tracked file carries a
  `/Users/<name>` or `/home/<name>` path that names a real machine. It reads as ordinary
  prose, which is exactly why review did not catch the six that were fixed by hand, and why
  it took several rounds for anyone to notice the tree was carrying a developer's home
  directory.

  Two kinds of path are exemptions, listed by name rather than inferred: **placeholders**
  (`/Users/you`, `/home/you` — the thing a reader substitutes into, in the skill references
  and `docs/scheduling.md`) and **fixture names** (`tester`, `op`, `team`, `alice` — arguments
  to pure path-resolution functions under test, in the same spirit as `/tmp/…`). A new
  placeholder name outside that list is a red whose message says what to do about it.

  `test/fixtures/host-paths-allowlist.json` carries the files that legitimately keep one —
  records of verification runs that really happened on one machine. It is checked in three
  directions: nothing off the list may offend, every entry must still exist, and every entry
  must still offend. The last two mean the list cannot grow without an edit in the same
  change and cannot go stale once a file is cleaned; there is deliberately no `--update`.

  Wired into `npm run verify`, `.githooks/pre-push`, the container suite and its own
  `.github/workflows/paths-gate.yml` — that last one for the same reason `contract-gate.yml`
  exists separately: `check.yml` is owned by a concurrent change and must not be modified.
  The checker uses `git ls-files` when there is a git checkout and walks the tree otherwise,
  because the verification image carries no `.git` (`.dockerignore` drops it).
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

  **`0023` partly reverses this paragraph, and the reason is worth reading.** `0019` did remove
  those copies and put the kind on the `actors` row — but that row is `UNIQUE(normalized_name)`,
  **one row per person**, and a kind describes an *act*: the same handle works from `claude`
  today and `codex` tomorrow. Worse, the row keeps the first kind it is ever given, so the
  column was not merely lossy but could be **wrong**. `0023` moves it back onto the reference
  (`tasks.assignee_kind` / `reporter_kind`, plus a new `claimed_kind`) and drops `actors.kind`.
  `creator_id` does **not** come back: `0019` collapsed provenance to `reporter_id`, and
  nothing in the kind argument needs a second provenance column.

  **No data step, and no board migration to run by hand:** `agent`, `human` and `system`
  remain legal values of an open string, so every existing row is already valid. The
  migration is a pure widening, which is why it ships with no accompanying code change.
  It also brings one constraint into view that was previously invisible: `task_reports.origin`
  was constrained by `0008`'s `ALTER TABLE … ADD COLUMN`, which the SQL-parity reader does
  not see; the rebuild declares it in a `CREATE TABLE` body, so the value set is now declared
  on the JS side too (`REPORT_ORIGINS` in `src/core/domain/enums.mjs`) and the parity test
  covers it for the first time.
- **The two dictionary tables are one `actors` table, and everything that referenced them
  moved with it** (migration **`0019`**). `assignees` and `reporters` are gone; a person is
  one row keyed by `normalized_name`, whichever role the board knows them in. The merge
  **deduplicates**: the group's earliest row survives — its `id` is one a task already holds —
  `use_count` sums, `first_seen_at`/`last_seen_at` take the extremes, and every
  `tasks.assignee_id`/`reporter_id` is repointed, **across tables**, because a person can be
  an assignee on one card and a reporter on another. The guard that refused to delete a
  referenced dictionary row is now one trigger on `actors` checking both roles.

  The surface follows the table: `GET /api/v1/assignees` and `GET /api/v1/reporters` become one
  `GET /api/v1/actors`; the CLI's `assignees` and `reporters` groups become one `actors` group;
  `dictionary_entry` loses `platform`; and the board fetches its roster once instead of twice.
  **The dictionary still has no management surface** — that ruling is unchanged.

  **Two behaviour changes worth naming.** The importer now drives the *same* dictionary
  decision as the live path (normalise, exact match, unique-prefix match, the dictionary's own
  spelling wins on reuse). Before, it called the repository directly: a card imported as
  `"  terry "` kept that spelling while the same name entered through the CLI stored
  `"Terry"` — one key, two spellings, and behaviour that depended on import order. And a
  card's `claimed_by` **no longer creates a dictionary row**: the old importer resolved the
  claimant into an actor and then discarded the id, so the row was a roster entry nothing
  referenced. `tasks.claimed_by` stays a free string here — the migration that turns it into a
  reference will create the rows it needs itself.

  The board's platform badge reads an actor's `kind`, but only a kind that *names* a platform
  (`claude`, `codex`, …); the generic `agent`/`human` deliberately fill nothing in, so the
  badge is absent exactly as it was while the `platform` column was never written. That was a
  holding position, not a finished rule: the DOM contract reads `[data-card]`'s
  `data-assignee-kind` off the same value and requires `human` or `agent`, so no single value
  satisfies both until an actor's kind carries a platform name.

  **`0023` is where that is settled, and it settles it by splitting the value rather than by
  making one value serve two rules.** The kind now lives on the *reference*, so the app derives
  both attributes from it on its own terms: `data-assignee-kind` is the **two-valued** question
  ("is this not the human?") that the closed domain and the stylesheet ask for, and
  `data-agent-platform` is the platform, emitted only when the kind names one the design has a
  face for. The two no longer contend, and the badge is filled in for the first time.
- **Every attribution column is now a reference to `actors(id)`** (migration **`0020`**).
  `tasks.claimed_by`, `comments.author_id` and `task_reports.author_id` join
  `tasks.assignee_id`/`reporter_id` as foreign keys, so "who claimed this", "who wrote this"
  and "who reported this" all point at the one person table.
- **…and the two log/telemetry columns deliberately are not.** `task_activities.actor_id`
  (an append-only audit log) and `agent_sessions.owner` (runtime telemetry, half of a
  natural key) stay free strings: a foreign key from a log to a mutable dictionary couples
  deletion to history, and the log has to outlive the people it names. The synthetic ids
  `taskd` and `md-import` are **reserved names in the log namespace** — no `actors` row is
  created for them, and a roster never shows a "person" called `taskd`. Both exclusions,
  and the reserved names, are pinned by `test/contract/attribution-boundary.test.mjs`, the
  way `tasks.blocked_reason`'s exclusion is.

  **The back-fill, and the one way it rewrites history.** Every distinct value in those three
  columns is a **name** — the live path writes `--agent`/`$TASKCTL_AGENT`/`$USER`/`local`,
  the importer writes the card's own text — so each value is normalised (`norm`) and
  resolved to the `actors` row with that `normalized_name`, or a new row is created for it
  (a value like `local` or a caller's `$USER` has no row yet, and is **created, not dropped**).
  Because `norm` folds case and whitespace, **spellings merge**: `"Terry"` and `"terry"` are
  two `author_id` values on a pre-0020 board and become **one person**. That is intended —
  they were always one identity — but it is a merge of historical rows, so a board that
  carried both spellings will see them collapse.

  **The write side follows the column.** Every writer — a claim, a heartbeat, a comment, a
  report, and the markdown importer — now resolves the name it was given to an actor row
  first, and the claim comparison (`claimed_by` against the claimant) is between ids.
  The markdown round trip is unchanged: a card still carries the **name** (`claimed_by:`,
  the comment/report author), the exporter resolves the id back to it, and the importer
  resolves the name forward.

  **The wire now carries an actor reference** (the change just below): `author_id` /
  `claimed_by` stay as ids, and a companion `author` / `claimed_by_actor` object carries the
  readable `display_name` beside each.

- **The wire carries an actor reference beside the id** — the readability regression `0020`
  left open is closed at the projection. `commentToWire` and `reportToWire` gained an
  `author` object and `taskToWire` gained `claimed_by_actor`, each `{id, display_name,
  kind}` — the shape `assignee`/`reporter` already had — so a client names an actor without a
  second request. `author_id` / `claimed_by` are **kept**, so nothing that keys on the id
  breaks, and the CLI prints the author's name again (`taskctl comment list`). `author_kind`
  also stays: it is the append-only column's own record of the kind a write claimed, a
  different fact from the actor row's *current* kind the ref resolves. The claim and
  heartbeat refusals name the holder again (`decideClaim`/`assertClaimable`/`setHeartbeat`
  take an injected `describeHolder`, the same seam as `resolveAssignee`), and the loop's
  `planPatrol` reads the holder's name
  off `claimed_by_actor`. The contract snapshot is refreshed; `author` / `claimed_by_actor`
  and their nested shapes are frozen by it.

### Removed

- **The `plugins/` directory, and the last committed copies of a skill.** `skills/` is now the
  only `skills` tree in the repository: nothing is distributed as a generated copy, because
  every harness reads that one tree in place through a manifest at the repository root. Two
  directories were removed with it, and each needs calling out separately:
  - **`plugins/openclaw/` — the native OpenClaw manifest** (1 manifest + an 8-file skill
    copy). A *native* OpenClaw plugin is an in-process runtime module needing
    `package.json#openclaw.extensions` plus an entry point importing the OpenClaw plugin SDK,
    a runtime dependency this zero-dependency project does not take — so the manifest could
    not be installed as what it claimed to be. What OpenClaw installs is the repository-root
    bundle (`openclaw plugins install "$PWD"`), as it always did. The skill copy under it
    existed only so the bundle assertion could resolve a skill out of that directory.
  - **`plugins/loop/` — the standalone `meerkat-loop` marketplace entry.** The marketplace
    (`.claude-plugin/marketplace.json`) now lists a single plugin, `meerkat-taskpanel` at
    `./`. `meerkat-loop` is installed by `install.sh --target claude|codex|pi`; **a
    marketplace install of the supervisor no longer exists.** A marketplace install of the
    board still brings the loop with it, since the shared tree is not filtered per entry.
- **The loop's independent version.** `meerkat-loop` no longer carries a version of its own:
  its only two carriers were the `plugins/loop` manifests, and nothing consumes a loop
  version — `board-check.mjs` enforces the *board's* interface floor, and `install.sh` writes
  no version into any unit or env file. `scripts/verify/version.mjs` has one group (the
  board, now **four** carriers), `scripts/release/bump.mjs` has one bump group, and
  `--group loop` is an unknown group rather than a silent no-op. Ruling O4 — board and loop
  version independently — is retired with them.
- **Three denormalised columns on `tasks`.** `assignee_kind`, `creator_kind` and `creator_id`
  are gone (migration `0019`): the kind belongs to the actor row, and a copy of a value that
  can now change goes stale. A card's creator **is** its reporter — `created_by` already
  mapped there — so `creator_id` was a second name for one fact and `creator_kind` a second
  copy of one kind. The wire loses `creator_kind` and `creator_id` with them.
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

- **The `install.sh --supervisor=enable` systemd case failed on any machine that exports
  `XDG_CONFIG_HOME`, which is why `check` was red in CI and green on a developer machine.** The
  test's `installEnv` helper builds the child environment as `{ ...process.env, HOME: <temp>, … }`,
  and `systemdUserDir` prefers an absolute `XDG_CONFIG_HOME` over `$HOME/.config` — correct for
  systemd, but it meant an inherited value decided where the units landed while the assertion still
  looked in `$HOME/.config`. The failure therefore reads as a broken installer
  ("`meerkat-taskpanel-poll.service` must be copied into …/.config/systemd/user") rather than as an
  environment leak, and it reproduces only where the variable is set: GitHub's `ubuntu` runner
  exports it, macOS does not, and the container image does not. The helper now pins
  `XDG_CONFIG_HOME` to the directory the suite asserts, so a case that wants the variable asks for
  it; a second case pins the XDG branch itself, so the fix cannot be "delete the variable from the
  installer".
- **`security-scan.yml` was rejected by GitHub, so the dependency scan never once ran.** Its
  daily entry was `17 3 * * 2-7`, and Actions accepts only `0-6` for day-of-week — and an
  out-of-range cron does not red a *job*, it voids the **whole workflow file**. Every run
  since the workflow landed completed with **zero jobs** and registered no status checks at
  all, which is precisely why nothing surfaced: a check that never reports looks like a check
  that was never configured, and the run page that would have explained it is one nobody had
  reason to open. The daily entry is now `0,2-6` (Sunday is 0, `1` stays the weekly Monday),
  and `scripts/security/workflow.test.mjs` now validates every cron against Actions' per-field
  bounds rather than the old `[\d,-]+`, which let the `7` through — it is what would have
  caught this on the day it was written.
- **An absent host CLI is SKIPPED even when a `PATH` entry is not a directory.**
  `scripts/verify/host-cli.mjs` treated only `ENOENT` as "this CLI is not here"; when a `PATH`
  element is a regular file rather than a directory, the bare-name lookup dies with `ENOTDIR`
  before it can report a miss, so one stray file entry turned every absent host into a **FAIL**
  instead of a SKIP — the opposite of the file's own promise that it is safe to run anywhere. The
  two errnos are now named as the single class they are, `BIN_ABSENT = {ENOENT, ENOTDIR}`;
  `EACCES` is deliberately *not* in it, because "found but not executable" is a real failure and
  must stay one. The branch had no test, so `test/install/install.test.mjs` now drives it with a
  `PATH` that is a file, and asserts the SKIP summary where it previously produced four FAILs and
  exit 1.
- **The wake glue refuses an empty target directory instead of waking a worker in the wrong
  checkout.** `wake-cwd.mjs`'s contract is "exit 0 means resolved, and the directory is the only
  thing on stdout", so an empty `$cwd` with exit 0 is an illegal state — and the glue's
  `if ! cwd=$(…)` guard could not see it, because `cd ""` **succeeds** in bash: the worker then
  started in whatever directory the scheduler happened to run in. All three wake scripts
  (`claude`, `codex`, `pi`) now test the resolved *value*, not only the exit status — an
  absolute-path check that subsumes both the empty and the relative case — and exit 3 without
  starting a worker. This is defence in depth rather than a fix for whatever makes a resolver
  answer emptily, but the outcome changes shape in a way an operator can see: a wake that used to
  start somewhere wrong now does not start at all, which is the deliberate trade (README R1 — a
  worker in the wrong checkout is worse than no worker).
- **Every entry-point guard compares canonical paths, so a symlinked path can no longer turn a
  CLI into a silent no-op.** The idiom that decides "run `main()` when executed, stay inert when
  imported" compared `import.meta.url` against `pathToFileURL(process.argv[1]).href` — and Node
  resolves the first through `realpath` while leaving the second exactly as the caller spelled
  it, so **any symlinked ancestor** made the guard false. Nothing ran, nothing was written, and
  the process still exited **0**: a no-op reported as success. Not theoretical — `script_dir()`
  in `_common.sh` prints the logical path, macOS's `/tmp` is itself a symlink to `/private/tmp`,
  and a host whose home directory is mounted elsewhere commonly has a symlinked `$HOME`. Two
  consequences were live. A `scripts/verify/*` checker reached through a symlink **reported
  success without looking at anything** (`verify:migrate:container`'s `scripts/migrate/drill.mjs`
  and `docker/migrate-in-container.sh`'s `reconcile.mjs` among them), and `wake-cwd.mjs` printed
  an empty directory that the wake glue accepted as resolved, so a woken worker ran in the wrong
  checkout. The fix is one shared `src/shared/entry-guard.mjs` (`canonicalPath` +
  `isEntryPoint`), generalising what `scripts/install/lib/{unit-path,apply,supervisor,taskd-guard}.mjs`
  had each already discovered privately, applied across all 24 in-tree entry points (the scan
  caught `scripts/verify/web-dist.mjs`, added after this work began, on the first merge); the four
  that cannot share it carry a private copy instead, for three reasons: the board skill's
  `report.mjs` and the loop skill's `board-check.mjs` ship on their own (an import reaching back
  out of their directory would dangle once copied), `web/scripts/dom-smoke.mjs` lives in a
  separate workspace with its own lockfile, and `scripts/security/scan-gate.mjs` must import
  **Node builtins only** — a security gate cannot depend on the code it exists to clear.
  `test/install/apply-guard.test.mjs` gains
  a table that runs six entry points twice, canonically and through a symlinked ancestor, and
  requires identical status, stdout and stderr, plus a source scan that fails on any
  reintroduction of the three fragile shapes. `host-runtime.mjs` goes from **22/31 to 31/31** on
  macOS; its own "ran in the mapped directory" assertion had the same defect and now compares
  canonically. One behaviour change to note on an affected host: code that had been silently
  inert starts actually running — above all the loop supervisor, which cron / launchd start by
  absolute path and which would previously have exited 0 having scanned nothing.

- **The combobox popup stopped collapsing to its content width — fixed once, for both places
  the control appears.** `.td-combo-menu`'s box was **110.19px** wide in the drawer where the
  prototype draws **383px**, and its rows were 27.5px where the prototype's are 28; the create
  dialog's menu had the same box and laid out as a block where the prototype is a flex column
  (`T-20261014-212017-7` D3/D4). The cause was a competing declaration rather than a missing
  one: the drawer's markup carries daisyUI's `menu` class — as the prototype's own
  (`ul.menu.td-combo-menu`) does — and `.menu` declares `width: fit-content`, which wins an
  absolutely positioned box over its `left: 0`. Stripping the class in the page flipped
  110.19 → 383, which is how the cause was pinned. The shared box rule now states `width:
  max(100%, 220px)` and the prototype's own metrics (`border-radius` 6px, `max-height` 232px,
  `padding` 4px, 13px/1.5 type, a flex column with `flex-wrap: nowrap`) and the row rule the
  prototype's `.menu li > button` (`min-height: 28px`, `padding: 0 8px`, `border-radius` 4px,
  `color: var(--brand-text-2)`), so **both** surfaces land the same values from the one rule
  family. The same pass adds the browser leg that had been missing — every existing gate was
  blind to this box (`ui-align`'s baseline never opened either menu, `blocks.contract.mjs`
  pins counts, and `docOverflow` reads `{0,0}` on both sides of the breakage):
  `web/scripts/combo-menu-geometry.mjs`, which re-measures the box and a row on both surfaces,
  asserts the two value sets are equal, and — as the defect's own signature — strips the
  `menu` class and requires the width not to move. It is **15/38 red** on the pre-fix tree and
  **38/38 green** after.
- **`node --test`'s `fail 0` no longer stands in for the two legs it skipped.** The bundle
  and DOM suites are held behind a `web/dist` guard and skip when there is no build — which
  is every lane worktree, and (for the DOM leg) the container too. A green suite therefore
  read the same whether or not the browser layer had run. `node scripts/verify/web-dist.mjs`
  now classifies the build on disk (`unbuilt` / `stale` / `fresh`), names each leg COVERED or
  UNCOVERED with the reason, and rebuilds first when a toolchain is present; `npm run
  verify:web-dist` is the fail-closed form. This also names the case that used to read as a
  contract violation: a build older than `web/src` fails with "these hooks are absent from
  the bundle", which is a **stale artefact**, not a broken contract. `npm run verify` runs
  the verdict and `docker/verify-in-container.sh` requires the bundle leg there, where the
  image builds the frontend itself. `web/dist` is now excluded from the build context, so a
  stale local build can no longer merge its old chunks into the image beside the fresh ones.

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
- **The committed npm cache covered one architecture, so the image would not build on the
  other.** `web/.vendor/npm-cache` held only the `linux/arm64` optional binaries
  (`@rolldown/binding-linux-arm64-gnu`, `@tailwindcss/oxide-linux-arm64-gnu`,
  `lightningcss-linux-arm64-gnu`) — correct for the machine it was vendored on, and wrong
  for `check.yml`'s `docker` job, which builds the image on `ubuntu-latest` (x86_64) with
  no exemption. The cache now carries both architectures, and
  `test/docker.test.mjs` asserts all six binaries from the cacache index.

  **The failure was quieter than it looked, which is the part worth recording.**
  `npm ci --offline` does **not** fail on the uncovered architecture: those platform
  packages are `optionalDependencies` and npm tolerates their absence. The install
  succeeds and the build dies one step later, in `vite build`, with
  `Error: Cannot find native binding` — rolldown finds no native binding and falls back to
  `@rolldown/binding-wasm32-wasi`, which a single-architecture cache does not hold either.
  So the Dockerfile's own comment ("`npm ci --offline` **hard-fails** … if the cache is
  incomplete") was wrong about the mechanism while being right about the outcome, and
  `docs/docker.md` documented the cache as arm64-only *by design* — a design that had not
  accounted for the architecture CI builds on. Both comments now say what actually happens,
  and the re-vendoring recipe runs once per architecture into the same cache (cacache is
  content-addressed, so the runs merge).

  Verified on this tree: `docker build --network=none` succeeds for `linux/arm64` and
  `linux/amd64`; the `webbuild` stage takes the offline branch on both.

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

[Unreleased]: https://github.com/tanyu216/meerkat-taskpanel/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/tanyu216/meerkat-taskpanel/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v1.0.0
