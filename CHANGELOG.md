# Changelog

All notable changes to Meerkat TaskPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-11

### Added

- **create:** one-description create surface with a three-row routing ladder
- **console:** list an external block as operator work
- **loop:** keep the director lane read-only; the director closes every open item at triage
- **domain,web:** a blocked card may move to todo, backlog or canceled
- **cli:** flatten the loop group and split board/loop status
- **reviewer:** scenario-based audit architecture with project scenarios
- **loop:** full tool access per session, with a deny list for the reviewer
- **loop:** restore the reviewer's one-shot independent review subagent
- **web:** name the review card and show its status chip in Acceptance
- **loop:** surface blocked decision holds to the human register
- **foundation:** add the cycle verdict and settled levels; the doctor reports cycle
  verdicts and failing workflow actions
- **loop:** a claim-cycle exit interrupts the turn
- **board:** one automation identity (Board, kind system)
- **loop:** name a lane by task, round and title slug
- **health:** board health, liveness probe and loop visibility
- **skills:** accept any task or plan and audit plans in three passes; file an
  out-of-scope defect as a backlog follow-up
- **web:** render drawer prose fields as Markdown
- **skills:** project epic graphs with generic-layer decoupling
- **supervisor:** open card sessions with a formatted system prompt
- **loop:** keep long-lived units up and back off a failed boot
- **events:** add `--hold` and `--event`, and hold the chat watch in the background
- **list:** server-side filters and offset pagination
- **board:** read a 500-card working set, active-first with a finish-time terminal
- **web:** assignee filter, searchable task menu and task backfill
- **drawer:** kind badge, recursive descendants and relation groups
- **loop:** the ping is the pool's single kill authority; one liveness verdict in six
  states with no startup window
- **web:** one agent per sidebar row and searchable assignee/label menus
- **web:** an Activity row opens its tab and focuses the entry

### Changed

- **install:** drop the OpenClaw target for a two-skill IM route
- **web:** remove the drawer's inert Resume control
- **supervisor:** keep the loop's state at the config root
- **tools:** one lane-tool table for adapters and the installer
- **deferrals:** expose the hold decision
- **skill:** rename `reviewer_prompt` to `reviewer_handoff`
- **prompt:** drop the team-role layer and thin the review prompts
- **reviewer:** keep the universal audit floor in SKILL.md
- **skills:** state role prompts and card-session rules as positive actions
- **skill:** route each card operation to its own scenario page; split the card schema,
  the lifecycle reference and `cli.md` by topic
- **review:** complete the review-kind refactor across the fixtures, drawer badge and CLI doc

### Fixed

- **web:** hide archived projects from the rail, switcher and create form; hide
  review-kind rows on the server-paged list
- **health:** name the operator action and the ping's read-only probe
- **create:** name who handles the work in one example only
- **skill:** keep the meerkat bundle inside its budget after the merge
- **rollup:** cite one anchor per done child and cap the epic evidence at the report limit
- **patrol:** never record an alert the transport could not deliver
- **verify:** accept a live busy verdict after EPIPE in the loop soak
- **skills:** keep the director skill's boundary positive; leave the scope-changing
  defect to the decision map
- **cli:** name the reject unit in the remaining help surfaces; honor `--if-version` on
  `issue meta`, `issue update` and `issue assign`
- **loop:** stamp the hold marker at execution time and keep the same-tick hold when the
  action cap splits the pair
- **loop:** count review rejections, not delivery rounds
- **loop:** route a landing conflict back as rework
- **loop:** settle the remaining poll failure paths
- **loop:** park a review after repeated crash recoveries; park cards after stale-claim
  recovery is exhausted
- **loop:** read a handoff round marker that carries its refs; make handoff turn
  timeouts transient
- **loop:** judge unlanded by the delivery round
- **loop:** gate the previous-manager reap on pid and start token
- **loop:** name an unclassified card before a round is spent
- **loop:** reap orphaned children, re-own live claims and bound shutdown
- **foundation:** a long-lived entry survives a closed stderr
- **supervisor:** read the reviewed round from `review_round`
- **skills:** carry the epic acceptance mode in the graph
- **patrol:** settle admission and post-claim failures at their bounds; claim and
  dispatch stale cards as the assignee
- **claim:** cover the unassigned stale_same window, defer a claim whose route moved,
  and keep the assignee's role on stale recovery
- **orchestrator:** pass the container suite on Node 22
- **orchestrator:** continue a rework in the same workspace and session
- **orchestrator:** settle a failed handoff instead of leaving a dead claim
- **web:** settle the settings focus and the prototype's dialog measurement
- **drawer:** close the people rows' edit windows

## [0.2.1] - 2026-11-03

### Added

- **loop:** sign the director lane as Director
- **web:** restrict status editing to the human-facing subset
- **web:** an Activity row opens its tab and focuses the entry

### Fixed

- **docker:** give taskd a writable data volume on a fresh checkout
- **web:** align the list's left edge with the filter bar
- **web:** keep the filter bar's height beside an overflowing view
- **state:** fsync durable json and record process start tokens

## [0.2.0] - 2026-11-03

### Added

- **worktree:** project-owned branch rules and a session lifecycle
- **setup-meerkat:** split setup into six rounds and delegate the instruction entry
- **skill:** keep the watch out of the conversation
- **loop:** remove subagent capability
- **skill:** watch the human queue on an event clock
- **loop:** split card-session failure, status and doctor by lane
- **loop:** run every review card in its own session
- **storage:** drop the project reviewer column
- **project:** remove the project reviewer override
- **install:** remove the deployment reviewer config
- **loop:** resolve the review assignee from the role catalog
- **loop:** make a review card's assignee authoritative
- **install:** place team skills on the primary agent kind
- **skill:** review any delivered card, with shape floors as refinements
- **loop:** route roles by the install kind order and publish a local catalog
- **loop:** load the role skill inline on Codex and Pi
- **loop:** load the lane skill at session open and slim the handoff
- **acceptance:** one card word, off | auto | human
- **setup:** initialize the team contract with the task entry
- **loop:** let the director consume an accepted handoff
- **loop:** bound every cycle and park what cannot advance
- **skill:** audit every card shape with a floor, not a ceiling
- **loop:** hold a worker for the ladder and settle on the release
- **skill:** split the human console out of the director
- **team:** roles are skills, the director decides, installation routes
- **loop:** run each card in its own worker session and resume it by id
- **doctor:** report deferred admission and stale workspaces
- **doctor:** report the cards that keep looping
- **export:** carry the landing markers a card is accepted with
- **doctor:** list the done cards whose lane never landed
- **doctor:** name the acceptances the board refused
- **loop:** manual mode is a human session agenda
- **loop:** expose doctor on the CLI surface and in the docs
- **loop:** add a read-only daily-inspection doctor command
- **crash:** one process-level crash boundary for the loop entries
- **setup-meerkat:** propose which platform runs which role
- **install:** run one loop supervisor per machine by default
- **setup-meerkat:** plan and write the CI job that closes a security arm
- **scripts:** add the loop-acceptance comment repair
- **deliver:** refuse an unanchored `met` before the report is written
- **loop:** add a bounded routing fallback for a card left unowned
- **loop:** report a todo card no scan can claim, and make a team assignee-only
- **skill:** route a team card at creation from the ownership guide
- **security:** add a free security toolchain, CI gates and a reviewer checklist
- **setup-meerkat:** route a session's own work through the team's ownership guide
- **web:** the Acceptance tab can accept or send back
- **cli:** close the tokenizer's switch set and gate --as-human
- **loop:** one worktree per card, and acceptance lands the branch
- **delivery:** a path anchor must name its commit
- **web:** a waiting row opens the drawer on the tab its reason names
- **create:** a human's card names its reporter
- **cli:** add --prefix to project create/ensure and make --id optional
- **web:** guide the create-project prefix and name the 1-4 refusal
- **waiting:** a row states the action and the ask, not only the state
- **prefix:** enforce a 1-4 [A-Z0-9] project prefix on every create path
- **skill:** record a standard technical specification at docs/tech-spec.md
- **acceptance:** review every card; the mode selects the closer
- **skill:** create queues the card, and a plan travels as plan.md
- **order:** make the assignee weight order the only task-list order
- **setup-meerkat:** ask the card scope and own the task entry
- **meerkat:** decide a card's language from the conversation
- **cli:** let issue get include the trail, reports, edges and sessions
- **review:** make a review prove its claims instead of asserting them
- **projects:** keep one local map at the config root, managed by taskctl
- **setup-meerkat:** ship an ownership guide instead of a team decision policy
- **config:** move the per-kind config to the taskctl program root

### Changed

- **loop:** remove the board-interface gate
- **actor:** retire the taskd kind — the board writes as system, acceptance by evidence
- **team:** scope the roles and make the self-check prove its claims
- **team:** keep role workflows to task process and quality
- **roles:** make the loop policy authoritative and load ownership.md
- **skills:** rename the board skill to meerkat
- **roles:** drop the stale stateDir parameter type

### Fixed

- **verify:** skip real-git worktree cases in the git-less image
- **loop:** claim an assigned card as its assignee
- **loop:** keep the resident pool alive on an idle board
- **loop:** keep worker sessions out of the lane pool count
- **loop:** land a human-closed lane under the project's merge target
- **loop:** read the wire's project_id in the director lanes
- **loop:** make the worker hold real and settle only on release
- **loop:** count admission deferrals and escalate a looping card
- **admission:** reconcile stale workspaces and refuse a doomed review target
- **workspace:** repair a worktree instead of re-deferring
- **workspace:** probe a rework base instead of trusting it
- **verify:** rebuild the frontend stage on every gate run
- **install:** stop the local hub before the taskd guard restarts the board
- **loop:** one supervisor log at the config root, tagged with actor_kind
- **hub:** replace a hub from another protocol generation and stop it on install
- **loop:** say when an acceptance has no lane to land
- **loop:** route a refused acceptance back as a new round
- **acceptance:** refuse an APPROVE the board can never act on
- **install:** restart the services an install just made stale
- **loop:** settle what is knowable before asking the human
- **loop:** escalate a workflow action that keeps failing
- **loop:** a stand-down is a completed handoff, and history rows are terminal
- **loop:** a container is not a stale worker
- **loop:** cap each log line in the doctor digest
- **loop:** report in_review as facts, not as aged review cards
- **taskd:** close on a failed pointer write and on a server error; derive the shutdown exit code
- **session:** a failed pool start is a recorded return, not an unhandled rejection
- **install:** retry a bootstrap refused while the old job is going away
- **install:** enable reloads a unit whose loaded definition changed
- **install:** keep the recorded human name across a forced reinstall
- **loop:** make every action's note retry-idempotent
- **scripts:** use the canonical entry-point guard in the repair
- **loop:** make the approve action retry-idempotent
- **install:** let the loop's scan set come from the per-kind config, not a unit flag
- **core:** record the claimant as assignee when claiming from the public pool
- **cli:** drain a large --json payload before exiting
- **install:** detect pi-subagents in pi 1.x's npm layout
- **verify:** give install-e2e a command anchor the delivery gate accepts
- **loop:** landing honours the project's declared integration branch
- **loop:** the card brief cannot block its worktree's cleanup
- **web:** the acceptance empty copy names verdicts only
- **web:** board filters must not narrow the waiting queue
- **loop:** admit review cards when the original brief is already watched
- **web:** split the drawer's acceptance criteria from delivery verdicts
- **loop:** let the control turn run the command its prompt names
- **install:** keep the mode when stripping the retired project-map key
- **install:** leave a symlinked legacy skill alone
- **install:** force replaces the installer's files, not the operator's
- **roles:** drop the loop state directory as a roles root
- **ci:** drop the invalid setup-node input
- **release:** hand npm an absolute tarball path

## [0.1.2] - 2026-10-27

### Added

- **An interactive install wizard.** `install.sh`, `npx meerkat-taskpanel` and the global
  npm install now share one wizard. Run it on a terminal with no options (or pass `-i`)
  and it asks for the install root, the install mode (full / skills only / server only),
  the agent kinds, your board name, link-or-copy, and the claim, workflow and optional
  supervisor policies. `--yes`, piped input and `--dry-run` never prompt.
- **A human name for the board.** The wizard records it as `TASKCTL_HUMAN` in the server
  tree's `.env`, and `taskd` uses it as the default actor for requests that carry no
  `X-Taskctl-Actor` header — the browser UI and `curl`.

### Changed

- Fresh installs default the agent name to `Worker` and the reviewer lane to `Reviewer`.
- Published packages now carry an npm provenance attestation: the release pipeline runs
  the full container suite on the tagged tree, builds and installs the tarball, then
  publishes over OIDC trusted publishing.

### Fixed

- `src/foundation/constants.mjs` is bumped with the other manifests, so `taskctl --version`,
  `/health` and `/meta` cannot report a stale version after a release.

## [0.1.1] - 2026-10-27

### Fixed

- The `taskd` keepalive guard now writes its launchd/systemd units under the install root
  (`<home>/.meerkat-taskpanel/scheduling/`) instead of a stray `<home>/taskpanel`
  directory beside it.
- The guard is no longer loaded when a board is already answering `/health` at the runtime
  pointer's address. A second `taskd` on that port only restarted into `EADDRINUSE`; the
  install now leaves the running board alone and reports what it found.

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

[0.1.1]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.1.1
[0.1.2]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.1.2
[0.2.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.2.0
[0.2.1]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.2.1
[0.3.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.3.0
[Unreleased]: https://github.com/tanyu216/meerkat-taskpanel/compare/v0.3.0...HEAD
[0.1.0]: https://github.com/tanyu216/meerkat-taskpanel/releases/tag/v0.1.0
