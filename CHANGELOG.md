# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-27

First public release.

### Added

- **The board engine** — the domain model, state machine and a single-file SQLite store
  (`node:sqlite`) with append-only numbered migrations. Core invariants — claimability,
  the dependency DAG, the delivery gate and the append-only trail — are enforced by
  database triggers as well as by the application layer.
- **`taskctl`** — the command surface for projects, issues, comments, reports, sessions,
  events, export/watch and the loop. Every write carries an actor kind and a session id,
  and every command can answer `--json`.
- **`taskd`** — the loopback HTTP/SSE service behind the board UI and remote callers, with
  a single-writer lock, token and CIDR access control, bounded write contention
  (`503 DB_BUSY` with `Retry-After`) and a graceful, bounded shutdown that ends SSE
  streams with a named `shutdown` frame.
- **The board UI** — a read-only kanban over the same state: the board, the task drawer
  (details, comments, reports, activity and attachments), question answering, and epic
  roll-up visibility. The only human write paths are comments and answers.
- **Dependencies and epics** — `depends_on` DAG edges for parallel and blocked work,
  parent edges for epic roll-up, and `--check-blockers` on claim. An epic is accepted
  through its roll-up report, which must name every child and be current.
- **The delivery gate** — `in_review` requires a report for the current delivery round;
  the one waiver (`--no-report --reason …`) is recorded as `report_waived`. `done` checks
  the report against the card's frozen acceptance baseline, with one acceptance mode and a
  direct-accept path (`deliver --to done`) for cards whose mode allows it.
- **Review cards** — review is an ordinary `kind=task` card carrying an immutable
  `review_of_id` / `review_round` identity, with a card-derived lifecycle policy,
  per-project review policy and auto-accept, a reviewer lane, and refusal of reopen,
  parent/child and review-of-review writes.
- **Questions and re-queue** — a blocked agent leaves a `question`; any human comment
  resumes the card for a fresh worker, with a decision-driven re-queue and a time
  contract.
- **Sessions and continuity** — deterministic session ids derived from
  `task + owner + segment`, opaque session metadata, natural-key close, and a global
  session list.
- **The append-only record** — comments, reports and activities cannot be edited or
  deleted, with a board-wide activity cursor, lossless paging and `Last-Event-ID` replay
  over SSE.
- **One local event hub per board** — `taskctl events hub` owns the host's single SSE
  connection and fans it out to watchers and the loop subscriber. `export watch` keeps a
  card brief fresh, registers with the hub, stops when every card is done, and is bounded
  by `--ttl` (default 120 minutes).
- **The `.meerkat/<identifier>/` process directory** — an exported card brief, kept fresh
  by the hub watch, plus per-task notes and downloaded attachments.
- **`meerkat-loop`** — the external scheduler: a free 60-second ping, a bounded
  600-second continue turn (SLA patrol → workflow → poll), a resident session pool with a
  configurable concurrency cap, a reviewer lane, and event-driven dispatch. It speaks only
  `taskctl` and declares `task-interface v1` compatibility (`taskctl loop compat`).
- **SLA and workflow alerts** — SLA thresholds configured from `.env` and published on the
  API; a notify-only patrol; de-duplicated workflow alerts with a ledger.
- **Installers and distribution** — `install.sh` targets `claude`, `openclaw`, `codex`,
  `pi`, `server` and `all` (every agent kind plus the server), merge-style and
  idempotent, with `--prefix`, `--link`, `--force`, `--dry-run`, `--no-automation`,
  `--skip-node-check`, and supervisor `enable` / `status` / `disable`.
- **npm/npx distribution** — `npx meerkat-taskpanel` installs the server, `taskctl` and
  every agent skill; the tarball carries the built `web/dist`, so the install needs no
  build step and no network.
- **`setup-meerkat`** — installation detection and repair, plus an optional team setup
  (role workflows, native agent definitions, plan-file conventions) built around an
  adversarial decision round.
- **Markdown export** — `taskctl export md` writes one canonical card per task, with
  modern acceptance criteria.

### Changed

- The platform concept is consistently called an **actor kind**; *host* now means the
  machine, throughout the CLI, board and docs.
- Configuration is **one `.env` at the install root**, read by both `taskctl` and `taskd`
  (the process environment wins key by key, CLI flags win over both, and `--env-file` /
  `MEERKAT_TASKPANEL_ENV_FILE` selects another file). **Breaking:** `<dataDir>/taskd.env`
  is no longer read.
- `--target all` now means every agent kind **plus** the server; `--no-server` keeps an
  agent-only install.
- Identity is required on every command that talks to the board (`--actor-kind`,
  `--agent`); the local read `taskctl status` reads the runtime pointer instead.
- The loop's live transport is the local event hub rather than a direct stream, and its
  poll registers the card brief **before** the claim.
- Logging is leveled (`debug` / `info` / `warn` / `error`) with a logfmt text line;
  `taskd` owns and rotates `<dataDir>/logs/taskd.log`.
- The board skill no longer carries periodic reporting or statistics: the append-only
  record is the history, and reporting is a client-side consumer of
  `issue list --json --include-archived`.
- Review is a marker on an ordinary task card, not a card kind; the separate deploy kind
  is retired in favour of one acceptance mode.

### Removed

- OpenCode and Cursor support.
- The legacy one-shot wake glue and the review compatibility layer.
- The `ready` / `failed` status aliases and the writerless `## Progress` section in
  Markdown export.
- References to external protocol documents.

### Fixed

- A reviewer's verdict is read at the review card's own round, and a closed review no
  longer hides the original card.
- Review-card creation invariants (the original must be `in_review`) and relation writes
  that would make a review card a parent or a child.
- SLA patrol correctness gaps, and a truncated `original_unseen` verdict is marked
  undecidable instead of silently passing.
- The activity cursor is lossless and indexed; the event hub preserves deferred
  registrations and promotes detached reuse.
- Drawer lists are newest-first with precise relative times, an awaiting card opens where
  the answer is written, and the create dialog's status value is left-aligned.
- `issue get` shows the card title.
- The subscriber unit points at the event hub instead of a direct stream.

[Unreleased]: https://github.com/tanyu216/meerkat-taskpanel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.1.0
