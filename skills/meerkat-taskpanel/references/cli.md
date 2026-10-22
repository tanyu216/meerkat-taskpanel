# `taskctl` CLI reference

`taskctl` is an **HTTP client** for `taskd`, the local board service. The CLI holds no second
copy of the rules: a refusal is the service's, with the same code, details and repair command.

> Paths written as `src/…`, `docs/…` or `scripts/loop/…` name the taskpanel **source
> repository**. This skill ships only `SKILL.md`, `references/` and `scripts/`; everything you
> run is `taskctl`.

**Contents:** [Configuration](#configuration-env) · [Starting the board](#starting-the-board) ·
[Global options](#global-options) · [Commands](#commands) ·
[Editing a card](#editing-a-card-status-priority-description-attachments-dependencies) ·
[The delivery gate](#the-delivery-gate) ·
[`awaiting`](#the-awaiting-state--asking-a-human-a-question) ·
[`blocked`](#the-blocked-state--what-the-card-is-waiting-for) ·
[Review cards](#review-cards--the-declared-fields) ·
[`reconcile --workflow`](#reconcile---workflow--the-boards-workflow-plan) ·
[`--json`](#--json) · [Notes](#notes)

```bash
taskctl <group> <command> [options]
taskctl --help
taskctl --version
taskctl --version --json   # {"ok":true,"data":{"version":"…","schema_version":4}}
```

Every command **except `--help` / `--version`** must identify its writer. `kind` is the platform;
`--agent` is the role or person:

```bash
taskctl --actor-kind claude --agent jobs  issue list
taskctl --actor-kind claude --agent linus issue claim PROJ-7
taskctl --actor-kind claude --agent turing issue deliver PROJ-7 --report-file -
```

The taskctl shim injects both halves for an installed skill, so a session normally does not repeat
them. A human writes with `--as-human`.

`--version --json` publishes the contract's `schema_version` — a coarse generation marker for
detecting drift, readable without a board. Run `taskctl <group> --help` or
`taskctl <group> <command> --help` for the surface of one group.

## Configuration (`.env`)

One install-root file, `<program root>/.env`, is read by `taskctl` and `taskd` (the loop reads
it through its `taskctl` children). The process environment wins key by key; CLI flags win over
both.

- **Path:** `--env-file <path>` > `$MEERKAT_TASKPANEL_ENV_FILE` > `<program root>/.env`.
  A file named with `--env-file` that does not exist is an error; a missing
  `MEERKAT_TASKPANEL_ENV_FILE` target or default is "no configuration".
- **`TASKD_URL`** is the preferred address: it is probed. A dead **loopback** address falls
  through to the runtime pointer or a lazy start; a dead **remote** address is an error.
  `--url` is an explicit pin and never starts anything.
- **Token:** `--token` > `$TASKD_TOKEN` > `$TASKD_TOKEN_FILE` > the pointer's token file.
  Setting both token keys in `.env` is an error; an inline `TASKD_TOKEN` requires the file to be
  `0600`.
- **Server keys** (`TASKD_ALLOW_LIST_ENABLED`, `TASKD_ALLOW_CIDRS`,
  `TASKD_ACCEPTANCE_POLICY`, `TASKD_LABEL_GC`, `TASKD_LABEL_TTL_DAYS`) live in the same file;
  the Access panel writes them. `TASKD_HOST` / `TASKD_PORT` / `TASKD_DATA_DIR` / `TASKD_DB` /
  `TASKD_RUNTIME_POINTER` and `TASKD_NO_AUTOSTART` are also read.
- **Identity is not a `.env` key.** `TASKCTL_ACTOR_KIND` and `TASKCTL_SESSION_ID` are per agent kind /
  per invocation and are refused in the file; `TASKCTL_AGENT` / `TASKCTL_HUMAN` may be defaults.
- **Unknown keys:** a typo inside `TASKD_*` / `TASKCTL_*` / `MEERKAT_TASKPANEL_*` is an error.
  Other keys (`VITE_*`, `NODE_ENV`, …) are ignored and never merged into the child environment.
- **Grammar:** `KEY=VALUE`, `#` comments, matching quotes. No inline comments, interpolation,
  escapes or multiline values. Use absolute paths.

## Starting the board

`taskctl` resolves the board as: `--url` pin → `TASKD_URL` (probed; a dead remote address is an
error) → the runtime pointer → lazy start. If no board is running it starts one
(`node src/server/main.mjs`, detached, logging to `<dataDir>/logs/taskd.log`) and waits for
`/health`. `TASKD_NO_AUTOSTART=1` forbids the lazy start.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Print `{"ok":true,"data":…}` on stdout. Failures print `{"ok":false,"error":{code,message,http,details,hint}}` on **stdout** too, so a pipe needs one stream. |
| `--env-file <path>` | Config file. Default `<program root>/.env`; `$MEERKAT_TASKPANEL_ENV_FILE` overrides it. |
| `--url <url>` | The board to talk to, as a **pin**: never probed, never autostarted. |
| `--token <token>` | Access token. Priority: `--token` > `$TASKD_TOKEN` > `$TASKD_TOKEN_FILE` > the pointer's token file > none (loopback needs no token). Never echoed. |
| `--if-version <n>` | Optimistic concurrency: refuse the write with `VERSION_CONFLICT` if the task moved on. |
| `--actor-kind <name>` | The platform (`claude`, `codex`, `openclaw`, `pi`, `opencode`, `cursor`; automation uses `system`). **Required on every command that talks to the board** — `--help`, `--version` and the local read `status` need none. `human` is reserved and refused; use `--as-human`. |
| `--as-human` | Write as the configured human (`$TASKCTL_HUMAN`). Also satisfies the identity requirement. |
| `--session-id <id>` | Agent session identifier. Requires `--actor-kind`. |
| `--agent <name>` | The role/person recorded on writes (`jobs`, `linus`, `turing`, …). Defaults to `$TASKCTL_AGENT` / `$USER`; a team passes it per call. |
| `--version` | Print the release version and exit. |
| `-h`, `--help` | Help for the CLI, a group, or one command. |

**Exit codes:** `0` success · `1` runtime failure (including the delivery gate) · `2` usage
error · `3` `export md --check` found stale cards.

## Commands

### `status` (no group)

`taskctl status [--url <url>] [--json]` — where this `taskctl` believes the board is, and whether
it answers. A **local read**: it reads the runtime pointer and probes `/health`; it never starts a
board, never resolves a token, and needs no `--actor-kind`. `--url` is a pin — the pointer is not
consulted behind it. Output: `{runtime: {pointer, data_dir, pid, url, running, note}, version,
schema_version}`. A board that is not running is `running: false` with **exit 0** — the answer,
not a failure; `note` says why (no pointer, or a stale pid).

### `project`

| Command | Purpose |
|---|---|
| `project create --id <id> --name <n> [--review-policy required\|optional\|off] [--reviewer <agent>] [--meta k=v]… [--label <l>]… [--readme <text>]` | Create a project. The id becomes the identifier prefix (`demo` → `DEMO-0001`). `--review-policy` (default `optional`) decides whether cards created here need an independent review; `--reviewer` overrides the deployment reviewer for this project. |
| `project update <id> [--name] [--review-policy required\|optional\|off] [--reviewer <agent>] [--meta k=v]… [--label]… [--readme]` | Update it. `--meta` **merges**. A policy change affects future cards only; in-flight cards keep their `review_required` snapshot. |
| `project list [--include-archived]` | List projects. |
| `project dir <id> [--projects-json <path>]` | Print the local directory work happens in, resolved from `projects.json` (`$MEERKAT_TASKPANEL_PROJECTS_JSON` picks another map): the entry's `local_path`, else `run_dir`. An entry naming no directory succeeds and says so. Exits non-zero only when no entry is registered, or the path is relative, missing, not a directory, or blank. |
| `project readme <id>` / `project readme <id> --set <text>` / `--file <path\|->` | Print or set the readme. |

**A project carries no directory.** The map is local, beside the skill — see
[`projects-json.md`](projects-json.md). `project dir` resolves and validates it, and stops to
ask rather than guessing.

### `issue`

> The status model — every status, transition and guard — is in
> [`status-lifecycle.md`](status-lifecycle.md). This section is the command surface.

| Command | Purpose |
|---|---|
| `issue create` | Create a card. Synopsis and flag semantics: [below](#issue-create). |
| `issue list [--project] [--status <s>]… [--assignee <name>\|--assignee-id <id>] [--parent <ref>] [--kind <kind>] [--label <label>]… [--target <value>] [--meta <key>=<value>]… [--review-of <ref>] [--limit] [--include-archived] [--order board\|weight] [--order-debug]` | List cards. `--order weight` is the assignee weight order (below); the default is board order. `--review-of <ref>` returns the **review cards of** that card — not the card itself — across every round (`review_round` is on each returned card, so a caller selecting the current round filters on it). It combines with the other filters and is read-only. An unknown ref is `NOT_FOUND`; an identifier that exists in two projects is `VALIDATION_FAILED`. **The further filters are all pushed into SQL** (they hold under `--limit`): `--parent` = that card's children; `--kind` = `task\|epic\|deploy` (an unknown kind is `VALIDATION_FAILED`); `--label` repeats and every label must be present, matched against the card's **exact display name** (no normalisation, no `labels` registry); `--target` compares `meta.target` as text; `--meta k=v` repeats, every pair must hold, and the key must match `[A-Za-z0-9_.-]+`; `--assignee` resolves a free-text name through the dictionary (an unknown name matches **nothing**, not everything) and is refused together with `--assignee-id`. |
| `issue candidates --assignee <name> [--stale] [--include-unassigned] [--order board\|weight] [--order-debug]` | The claim read: `todo` cards that are auto-claimable (not an `epic`, not a `deploy`), every `depends_on` predecessor `done` (a `canceled` one also withholds). `--stale` adds the recovery pool (holder after 30 min, anyone after 6 h); `--include-unassigned` adds the public pool. Read-only; no `--limit`. |
| `issue get <id\|identifier>` | One card, plus `report_waivers[]` and `attachments[]` (`id`, `filename`, `content_type`, `size`, `kind`, `created_at`, `comment_id`). The human view prints identifier, title, status, priority, kind, labels, assignee, reporter, claimed_by, heartbeat_at, delivery_round, review_required, review_of (the reviewed card's identifier), review_round, parent, awaiting_reason, acceptance_revision, the numbered acceptance snapshot (`none (vacuous)` when empty), meta as JSON, the description and version, then a waiver row and an attachment table when present. `--json` carries the same fields: `acceptance[]` is the **frozen baseline**; `meta.acceptance` is only its seed. |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]… [--drop-acceptance <text>]… [--acceptance-revision <n>] [--review yes\|no [--reason "<why>"]]` | Patch. `--status` is refused here on purpose. `--acceptance` **appends** to the frozen baseline (`tasks.acceptance_json`) and is idempotent by criterion text; it cannot remove an item. `--drop-acceptance` is **human-only**, needs `--reason` (≥ 8 characters) and the current `--acceptance-revision`; both are audited. `--review yes` escalates a card to requiring review (any actor); `--review no` waives it and is **human-only**, needs `--reason` and no open current-round review card. |
| `issue move <ref> <status> [--allow-steal --reason "<why>"] [--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--question "<text>"] [--blocked-reason <word>]` | Move, subject to the delivery gate. `todo → in_progress` is a **claim**; a move to `done` is an **acceptance** and requires a current-round report that covers every frozen acceptance criterion — for an **epic**, a current-round rollup (`ROLLUP_REQUIRED` / `ROLLUP_STALE`). `done`/`canceled → todo` is the audited **reopen** and needs `--reason` (prefer `issue reopen`). `--awaiting-reason` is required for `awaiting`; an agent entering `awaiting` must also supply `--question` (or already have an unanswered `question` comment). `--blocked-reason` is optional. |
| `issue reopen <ref> --reason "<why>"` | **Reopen a `done`/`canceled` card to `todo`.** Audited: the reason is required (≥ 8 characters) and recorded as `task_reopened`. Starts a new delivery round, clears the archive and releases the idem key. A review card is refused — reopen the original; the loop issues the next round's review. |
| `issue claim <ref> [--check-blockers] [--allow-steal --reason "<why>"]` | **Claim, re-claim or take over.** On `todo` it behaves like `move … in_progress`; on `in_progress` it is the only recovery path. The holder may re-claim after 10 min; anyone may take over after 6 h. A fresh claim by another actor is `EXECUTION_ACTIVE`. `--check-blockers` is opt-in: the board re-reads the card's `blocks` predecessors and refuses with `BLOCKED_BY_PREDECESSOR` (details carry the open predecessors) when one is not `done`. Claim does **not** re-check by default — the poll (`issue candidates`) already withholds blocked cards, and `issue move … in_progress` remains the caller's own responsibility. |
| `issue heartbeat <ref>` | Pulse a claim you hold. Refreshes `heartbeat_at` and nothing else; holder only; `in_progress` only; takes no flags of its own. |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--reporter-id <id>] [--force-create]` | Assign. |
| `issue archive <ref> [--days <n>]` | Archive finished work (done/canceled; 7-day window by default). |
| `issue meta <ref> --meta <k>=<v>…` | Merge metadata keys into a card, leaving other keys intact. The read-modify-write form with `--if-version` CAS. |
| `issue deliver <ref> --report-file <file\|-> [--no-report --reason "<why>"] [--seg <seg>]` | **Write the report and move to `in_review`, in one transaction.** The two report forms are mutually exclusive. No `--to`; it always lands in `in_review`. On an **epic** the report is its rollup: it must name every live child by `ref` (`ROLLUP_STALE` otherwise) and is stored with `is_rollup = 1`; `--no-report` is refused for an epic (`ROLLUP_REQUIRED`). |
| `issue reconcile [--dry-run] [--workflow] [--reviewer <agent>] [--auto-accept-reviews yes\|no] [--review-aging-ms <n>] [--max-actions <n>] [--board-limit <n>]` | Without `--workflow`: replay the epic rules over every non-terminal container. With it: return the board's workflow plan (see below). `--dry-run` writes nothing. Idempotent. |

#### `issue create`

```bash
taskctl issue create --project <id> --title <t> [flags]
```

| Flag | Meaning |
|---|---|
| `--project <id>` | **Required.** The project; its id is the identifier prefix. |
| `--title <t>` | **Required.** The one-line summary. |
| `--review yes\|no` | Whether the card needs an independent review. In a `required` project it must be `yes` (omitting it means yes); in an `off` project it must be `no` (omitting it means no); in an `optional` project an **agent** must state it, while a human/UI caller may omit it and gets `no`. |
| `--acceptance <text>` | One acceptance item; repeat for each. |
| `--assignee <text>` / `--assignee-id <id>` / `--assignee-kind <agent\|human>` | Route the card. `--assignee-id` bypasses the dictionary. |
| `--reporter <text>` / `--reporter-id <id>` / `--reporter-kind <agent\|human>` | Set the reporter. |
| `--description <md>` | The markdown description. |
| `--priority <low\|medium\|high\|urgent>` | Urgency; a card with none reads as `medium`. |
| `--kind task\|epic\|deploy` | The card's role; default `task`. |
| `--label <l>` / `--meta k=v` | Repeatable labels and metadata. |
| `--target <t>` | An opaque per-card value; it is not a directory. |
| `--parent <ref>` | Fills the idempotency key's source slot; it **links nothing** — use `relation add --type parent`. |
| `--status <s>` | Initial status; see [`status-lifecycle.md` §8](status-lifecycle.md#8-creating-a-card-in-a-status). |
| `--idem <key>` | Creation idempotency key; a match returns the existing card, keeping its review decision. |
| `--allow-dup` / `--force-create` | Skip the duplicate guard / the fuzzy dictionary step. |
| `--review-of <ref> [--review-round <n>]` | Create a review card for that original and round. |

### The weight order (`--order weight`)

Opt-in ranking for `issue list` and `issue candidates`: a hard **tier** (can I move this card
at all?), then a weighted score (priority, time in status, age, SLA pressure, how many cards
this unblocks), then a deterministic tie-break ending on the identifier. A tier is never
traded against a score. Inside `issue candidates` the claimability bucket stays the first key;
the weight order only refines within a bucket. `--order-debug` adds
`{id, identifier, order, tier, tier_name, score, factors}` to reconcile a rank by hand.

### Claiming: only the assignee may claim

`issue move <ref> in_progress` on a `todo` card takes the execution lock
(`claimed_by` / `claimed_at` / `heartbeat_at`). The **assignee** is who the card is routed to;
the **claimer** is who is doing it now.

- **Unassigned** cards are an open pool: any actor may claim them.
- An **`epic`** can never be claimed (`not_claimable`); `backlog` is not claimable either.
- A **`deploy`** card can be claimed, but `issue candidates` never offers one — dispatch it
  explicitly.
- A card routed to somebody else is refused on the first claim with `not_assignee`.
  `--allow-steal --reason "<why>"` (reason ≥ 8 characters) is the audited override, valid on
  that first claim only; it records a `task_claimed` activity and a `kind: change` comment.

| Heartbeat age | The holder | Anyone else |
|---|---|---|
| `≤ 10 min` (fresh) | reuses the claim, nothing reset | refused — `EXECUTION_ACTIVE` |
| `10 min … 6 h` | re-claims it, resetting the lock | refused — `EXECUTION_ACTIVE` |
| `> 6 h`, or no heartbeat | may take it | may take it — an audited takeover |

A **rework** (`in_review`/`blocked → in_progress`) is not a claim: it keeps the existing
executor and their lock. The claim is held in `in_progress`, `awaiting`, `in_review` and
`blocked`, and released by the write that moves the card to `todo`, `backlog`, `done` or
`canceled`. The board runs **no background pulse**; keeping it fresh is the holder's job.

### Deployment cards: never auto-claimed

`--kind deploy` marks work that runs against a live instance (rebuild, restart, full install).
`issue candidates` never offers a `deploy` card in any pool — it is dispatched explicitly. It
is still claimable like any other card. When an expected card is missing, `issue get <ref>`
shows whether `kind: deploy` is why.

### Promoting an existing card to an epic

`kind` is patchable, and a card filed from the web UI is always a `task`:

```bash
taskctl issue update PROJ-0007 --kind epic
taskctl relation add PROJ-0007 --type parent --target PROJ-0008
```

Only an `epic` may be a parent (`VALIDATION_FAILED`, `details.field: kind`, until promoted).
Neither end of a `parent` edge may be a review card (`VALIDATION_FAILED`,
`details.field: source|target`), even with `--force`. An epic cannot be claimed, so a card
that must end up `in_progress` is claimed first and promoted after. `todo → in_review` is the
epic's own edge. The promotion is an ordinary patch — status, claim, heartbeat and delivery
round stay put — and leaves no comment, so write the split down yourself. An epic that still
has children cannot be downgraded to `task`. The board
starts and closes the container; see
[`status-lifecycle.md`](status-lifecycle.md#6-containers-epic).

### `comment`

| Command | Purpose |
|---|---|
| `comment list <ref> [--kind <kind>] [--limit <n>]` | Oldest first. |
| `comment add <ref> --body <text> [--kind discuss\|decision\|confirm\|confirm_request\|change\|note\|defect\|question] [--file <path\|->]` | Append. A `question` + `awaiting` E2 is how an agent asks a human; a human's `decision`/`confirm`/`change` on an `awaiting` card moves it back to `todo` in the same transaction. |

Append-only: there is no edit and no delete, by design. A `decision` / `change` comment is what
a reviewer reads later.

### `relation`

| Command | Purpose |
|---|---|
| `relation add <ref> --type parent\|blocks\|related --target <ref> [--force]` | Add an edge. For `parent`, **the task you name is the parent**, and only an `epic` may be one. |
| `relation remove <ref> <relation-id>` | Remove it (the id from `relation list`). |
| `relation list <ref>` | Edges, children, ancestors, blockers. |

Guards: a task may not relate to itself (`SELF_REFERENCE`); the same `(type, source, target)`
triple cannot repeat; a `parent` edge that would close a cycle is `RELATION_CYCLE`. `blocks`
additionally refuses a dependency loop and a card depending on its own ancestor or descendant
(siblings are legal) — the database triggers enforce all of these; `--force` skips only the
app-layer checks.

### `attachment`

| Command | Purpose |
|---|---|
| `attachment add <ref> --file <path> [--name <filename>] [--content-type <type>]` | Upload a file: metadata row first, then bytes. |
| `attachment list <ref>` | `id`, `filename`, `size`, `type`. Empty reads `no attachments`. |
| `attachment download <attachment-id> --out <file>` | Write the stored bytes to `--out` (parent must exist). |
| `attachment remove <attachment-id>` | Remove a file **for good**: row and bytes, one transaction. |

`add` reads the file from your disk (`CLI_IO` when it cannot) and refuses one over **64 MiB**
(`ATTACHMENT_TOO_LARGE`) before opening a socket. The content type is a closed set; a type
outside it is `ATTACHMENT_TYPE_UNSUPPORTED`. An unknown extension becomes
`application/octet-stream`. `download` carries the same identity as every other command and
writes the bytes verbatim; a missing parent directory is `CLI_USAGE`, and an attachment with
no stored bytes is the board's `NOT_FOUND`.

### `session`

| Command | Purpose |
|---|---|
| `session set <ref> --seg <seg> --owner-kind <name> [--owner] [--phase] [--pid] [--goal <text>] [--meta k=v]… [--session <id>]` | Register a session (the id is derived from `task, owner, seg`, so a resume keeps it). `--owner-kind` is the owner's platform kind (e.g. `claude`, `codex`); `--goal` is one sentence saying what this session is for. Omit `--goal` on a re-registration to keep the recorded sentence. `--meta` is opaque host metadata (harness, thread id, log path, …); a re-registration **merges** the supplied keys into the recorded object. |
| `session id <ref> --seg <seg> [--owner <name>] [--session <task-id>]` | Print the deterministic session id **without registering a session**. It is the value `session set` would write for the same `(task, owner, seg)`, so it can be handed to an agent before it starts. `--owner` defaults to the caller's actor id, exactly as `session set` does; `--session` replaces the task fed to the derivation. It always derives — a global `--session-id` is ignored. Read-only: no session row and no card change; it still resolves the ref through the board, so `ensureBoard` may start `taskd` (use the script below, or `TASKD_NO_AUTOSTART=1`, for a strict offline read). |
| `session close <ref> [<session-id>] [--seg <seg>] [--owner <name>] [--failed]` | Close it by row id, or by the natural key `(task, seg, owner)` with `--seg` (owner defaults to the acting actor). Exactly one identity is required. |
| `session list [<ref>] [--owner <name>] [--owner-kind <kind>] [--status running\|closed\|failed] [--limit <n>]` | With a ref: a card's sessions (oldest first), including each `goal` and `meta`. Without a ref: the board-wide read, newest first, bounded by `--limit` (default 200); it requires at least one of `--owner` / `--owner-kind` / `--status`, and refuses an unbounded scan. |

For a derivation that never touches the board, the skill ships
[`scripts/session-id.mjs`](../scripts/session-id.mjs):
`node scripts/session-id.mjs --task-id <uuid> --owner <name> --seg <seg>` prints the same id
and does not start `taskd`. It cannot resolve an identifier to a UUID — pass the **resolved**
`data.task.id` from `issue get <ref> --json`, not `PROJ-0007`; hashing the identifier produces
an id `session set` will not match.

### `actors list` / `labels list`

| Command | Purpose |
|---|---|
| `actors list [--query <text>] [--limit <n>]` | Read-only actor dictionary; every row carries `display_name` and `id`. |
| `labels list [--query <text>] [--limit <n>]` | Read-only label registry. |

There is **no** `actors add`, `actors remove`, `labels add` or `labels rename`: the
dictionaries grow when a card names somebody or a label. Names resolve in the same transaction
as the task write: an exact or unique prefix match is reused; several matches are refused with
`DICTIONARY_AMBIGUOUS` and the candidates listed; `--force-create` skips the fuzzy step;
`--assignee-id` bypasses the dictionary entirely.

### `report`

| Command | Purpose |
|---|---|
| `report list <ref> [--round <n>]` | A card's reports (round, author, conclusion), newest last. This is how a reviewer reads the report it audits. |
| `report template <ref> [--commit <sha>] [--path <p>]… [--command <cmd:exit>]… [--coverage <pct[@scope]>]…` | Print a report to fill in. On an **epic** the template is a rollup: it reads the card's children and emits one `ref`-carrying item per child (`done` → `not_met` until you confirm it, `canceled` → `not_applicable` with a TODO note), and reports `acceptance_source: "children (rollup)"`. |

The template is built from the card's **frozen baseline** (`tasks.acceptance_json`, printed as
`acceptance_source: "acceptance_json"`), then — for a grandfathered card whose snapshot is
empty — `meta.acceptance`, then an imported card's `meta.acceptance_legacy`, then an empty
list with a warning. Every item starts **`not_met`** — a ticked box on an imported card is
the author's intent, not this delivery's evidence. A derived list
(`meta.acceptance_derived=yes`) carries a warning on stderr. Evidence anchors are the
explicit flags first, then a read-only `git rev-parse HEAD`, then the task's `source_path`,
then a placeholder.

### `export`

| Command | Purpose |
|---|---|
| `export md [<ref>] [--out <dir\|file.md>] [--project <id>] [--check] [--md]` | Write markdown cards: every identifier into a directory, or only `<ref>` (id or identifier). With `<ref>`, a `--out` ending in `.md` that is not an existing directory names the file itself; otherwise it is a directory and the card lands at `<dir>/<ID>.md`. `--project` cannot be combined with `<ref>` (usage error, exit 2). |

`--check` writes nothing and exits **3** when a card is missing or differs; with `<ref>` it
checks only that card. A single-file target must already have a parent directory (exit 2 in
both write and check mode). The service renders and the CLI writes; `POST /api/v1/export`
never touches a caller-named path. Before overwriting an existing non-empty file the CLI
applies the same `MD_GROWTH_FACTOR` (4×) guard as the core exporter: a rewrite that would grow
the file past it is refused with `MD_GROWTH_GUARD` rather than silently replacing it — inspect
the file and remove or rename it to accept the rewrite. The `## Acceptance` section renders
the frozen snapshot as plain bullets (a snapshot that is empty while `meta.acceptance` is not
renders the seed with a `(seed; no frozen baseline)` note); an imported card's checkbox list
is the fallback, and its tick marks are dropped — the snapshot keeps texts, not check state.
The frontmatter also carries `target` (from `meta.target`), and — only when set —
`delivery_round` (>1), `awaiting_reason`, `review_of` / `review_round`,
`acceptance_revision` (>0), the report-waiver keys and `archived_at`. A card with attachments also carries an `## Attachments` section between `## Sessions`
and `## Report` (one metadata line per file; the bytes stay on the board). The product is the card **store mirror** (frontmatter plus
sections) used for round-tripping and CI checks, not a human-readable card detail: use
`issue get <ref>` for prose and `issue get <ref> --json` for machines. The implicit spelling
`export --md <ref>` cannot carry a ref; use `export md <ref>`. The file format is in
[`card-schema.md`](card-schema.md).

### `token`

| Command | Purpose |
|---|---|
| `token rotate [--show]` | Rotate the access token. **Loopback only** (403 `loopback_only` otherwise). |

Prints `td_****` and the token file; `--show` prints the value and says what it just did.

### `sla`

The board's computed SLA rows (`docs/sla.md`): one alert tuple per open wait, with its
tier (`warn` / `overdue` / `escalate`), elapsed working minutes and threshold. Read-only;
it moves no card.

| Command | Purpose |
|---|---|
| `sla list [--period <sec>] [--leader <id>] [--limit <n>] [--trail-limit <n>]` | Every open SLA row on the board. |
| `sla get <id\|identifier> [--period <sec>] [--leader <id>]` | One card's rows — the pre-emit re-read before a notification. |

`--period` sets the mechanism's measurement period for this call (`warn = L − P`); it
defaults to the board's `TASKD_SLA_PERIOD_SECONDS` (300). `--leader` names the actor id
the leader writes under; the default is the board's human decision authority. The
published table is visible at `GET /api/v1/sla` and under `/meta` → `capabilities.sla`.

### `events`

The board's live activity stream — a cursor over `task_activities`, not an event bus.
Read-only; it moves no card.

| Command | Purpose |
|---|---|
| `events tail [--after <rev>] [--idle <ms>]` | Stream activities as **newline-delimited JSON** until the stream ends. |

`--after` replays activities newer than that board revision, then streams (the resume
cursor). `--idle` ends the stream after that many milliseconds with no bytes; the default is
45000 (three missed heartbeats), and `0` disables the timer. The server's heartbeat is 15 s.

**This is the one command whose output is not the `{ok,data}` envelope.** Each line is one
JSON object:

```json
{"type":"open"}
{"type":"event","id":12,"data":{"event":"task_created","task_id":"…","revision":12,…}}
{"type":"idle","data":{"idle_ms":45000}}
{"type":"shutdown","data":{"reason":"server_shutdown"}}
{"type":"eof"}
{"type":"error","data":{"code":"CLI_IO","message":"…"}}
```

`open` is written once the board has answered; `event.id` is the cursor to pass back as
`--after`. `idle`, `shutdown` and `eof` exit 0; `error` exits 1. A failure **before** the
stream opens (unreachable board, auth refusal, a bad `--after`) is still the normal
`{ok,false}` error document with a nonzero exit — no `open` line is written.

## Editing a card: status, priority, description, attachments, dependencies

The drawer's five edits do not share one shape: two are a single flag, one is a **move**, one
is a **two-request upload**, and one is an indirection through relations.

| Capability | Board (HTTP API) | `taskctl` |
|---|---|---|
| **`status`** | a **move** — `PATCH {status}` is refused (`INVALID_TRANSITION`) | `issue move <ref> <status>`; `issue update` has no `--status` |
| **`priority`** | `PATCH /api/v1/tasks/:ref {"priority": …}` | `issue update <ref> --priority <p>` |
| **`description`** (markdown) | `PATCH {"description": …}`, opaque text | `issue update <ref> --description <md>` |
| **attachments** | rows plus bytes | `attachment add` / `list` / `download` / `remove` |
| **`depends_on`** | carried by a `blocks` relation | `relation add` / `remove` / `list`, direction reversed |

### `status` — a move, never a patch

```bash
taskctl issue move PROJ-0007 blocked
taskctl issue move PROJ-0007 in_progress         # todo → in_progress is the claim
taskctl issue deliver PROJ-0007 --report-file -  # report + move to in_review
```

The move path carries the state machine, the delivery gate and the claim lock, so a status
write cannot side-step any of them. `issue update --status` is a usage error (exit 2). A move
can still be refused by the service — `INVALID_TRANSITION` (with `details.allowed`),
`REPORT_REQUIRED` (with the fixing `issue deliver` hint), or a locally refused `awaiting` move
(exit 2). `issue create --status <s>` sets the initial status; the creation table is in
[`status-lifecycle.md`](status-lifecycle.md#8-creating-a-card-in-a-status).

### `priority` — one flag, one closed set

`low`, `medium`, `high`, `urgent`, matched case-insensitively. Anything else is
`VALIDATION_FAILED` (`details.field` = `priority`). A card with no priority reads as `medium`.

### `description` — markdown as opaque text

The board stores and returns the string **byte for byte**; it does not parse or render it —
the web client does. There is no length cap and no `--file` form:

```bash
taskctl issue update PROJ-0007 --description "$(cat findings.md)"
taskctl issue update PROJ-0007 --description ""    # clears the field
```

### attachments — two requests, and a hard delete

```bash
taskctl attachment add PROJ-0007 --file ./shot.png
taskctl attachment list PROJ-0007
# In a loop task, downloads belong in the card's process directory:
taskctl attachment download 3f1c9a2e-… --out .meerkat/PROJ-0007/shot.png
taskctl attachment remove 3f1c9a2e-…               # the id `list` prints
```

Upload mints the metadata row, then stores the bytes — a row whose `PUT` never arrives answers
an honest `404` on download. Removal deletes the row and the bytes in one transaction; it is
**not recoverable**. An attachment id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
`--meta attachments=…` stores literal text, not an array; it is not a channel into this table.
Loop convention: `card.md` and every downloaded attachment for a task live under
`.meerkat/<identifier>/`; see the loop skill's card-brief section.

### `depends_on` — a `blocks` edge, written the other way round

`depends_on` is **not** a field on the card: "this card depends on X" is a `blocks` relation
whose **source is X**. So adding a dependency names the blocker first:

```bash
taskctl relation add PROJ-0003 --type blocks --target PROJ-0007   # PROJ-0007 depends on PROJ-0003
taskctl relation list PROJ-0007                                    # reads blocked_by[]
taskctl relation remove PROJ-0007 41                               # the relation id is required
```

`--type depends_on` is refused (`VALIDATION_FAILED`); there is no alias, only a direction. An
unfinished dependency is what keeps a card out of `issue candidates`. On the wire:
`POST /api/v1/tasks/<blocker>/relations` with `{"type":"blocks","target":"<card>"}`,
`GET …/relations` for `blocked_by[]`, `DELETE …/relations/<relationId>`.

### The acceptance list

`issue create --acceptance` seeds the frozen baseline (`tasks.acceptance_json`); after that,
`issue update --acceptance` **appends** and never replaces. `meta.acceptance` is a seed, not
the authority — the gate reads the snapshot. A human may remove an item with
`issue update --drop-acceptance <text> --reason "<why>" --acceptance-revision <n>`; the
`acceptance-revision` is the value returned by `issue get`/the last write. Imported cards
carry `meta.acceptance_legacy` instead (its `checked` state is never evidence).
`meta.acceptance_derived=yes` is a marker, not policy: it records that an agent derived the
list because the card had none, and `report template` warns when it sees it.

## The delivery gate

A card may not enter `in_review` without a report **for the current delivery round**; leaving
`in_review` (except to `done`) starts the next round.

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
```

The compliant path is the short one: `issue deliver` writes the report and performs the move
atomically, and `report template` prints a report `deliver` accepts without editing. The
second line is the **audited waiver** (reason ≥ 8 characters, stamped on the task row and
recorded as a `report_waived` activity). The round table is in
[`status-lifecycle.md`](status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round).

## The `awaiting` state — asking a human a question

A card that needs an answer from a person is **`awaiting`**, not `blocked` and not a chat
message. It is an overlay on a running card: entering or leaving it does not start a delivery
round.

`in_progress → awaiting` is the **only** entry, and it must name the question class:

```bash
taskctl issue move PROJ-0007 awaiting --awaiting-reason E3
```

| Code | The question is about |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

Without the flag the CLI refuses as a usage error (exit 2); the service refuses an unusable
value with `VALIDATION_FAILED` (`details.field` = `awaiting_reason`). The reason is stamped on
the card while it is `awaiting` and cleared on exit. `awaiting → in_progress` means a human
replied — a resume, not a rework; `awaiting → canceled` is allowed; `blocked`/`in_review`/
`done` are not. Read the set with `issue list --status awaiting`; the web board's **waiting**
view is the same set.

## The `blocked` state — what the card is waiting for

`blocked` is the other stop: the card cannot proceed, but nobody has been asked a question.
`--blocked-reason` says **what** it waits for so a reader need not open the comment trail.

```bash
taskctl issue move PROJ-0007 blocked --blocked-reason dependency
```

Unlike `--awaiting-reason` it is **optional**; an unset value reads as `clarify`. The value is
one of eight literals — `clarify`, `decision`, `dependency`, `out_of_bounds`, `defect`,
`external`, `resource`, `unknown` — trimmed, never free text (`VALIDATION_FAILED` otherwise).
`unknown` is not the spelling of "no reason": it is a writer saying there is a block they
cannot classify. The reason is stamped while `blocked` and cleared on exit; the card's
`task_moved` activity keeps it afterwards. The table and import rules are in
[`card-schema.md`](card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).

## Review cards — the declared fields

A review card names the original it audits through the **declared** create fields:

```bash
taskctl issue create --project PROJ --title "Review PROJ-0007" \
  --assignee <reviewer> --assignee-kind agent --label review \
  --review-of PROJ-0007 --review-round 1 --meta flow=B
```

`--review-of` takes an identifier or an id; `--review-round` is a positive integer and requires
`--review-of`. When given, `--review-round` must equal the original's **current**
`delivery_round`; omit it only for a legacy round-agnostic review. The board resolves both,
stores `review_of_id` / `review_round`, and mirrors `meta.review_of` / `meta.review_round`
itself. One review card per `(original, delivery round)`; the loop's idempotency key is
`loop-review|<ref>|r<round>`.

Four creation invariants (`VALIDATION_FAILED`): `review_of` must name a card that is
`in_review` (deliver the original first); `review_of` may not name another review card;
`review_round` may not be stale or future; and a review card must be `kind=task` (an epic
cannot be claimed, so an epic review card would never be woken). Detection is structural —
`review_of_id` first, `meta.review_of` only as the legacy fallback — never the `review` label.
A review card in `in_review` cannot be moved directly to `canceled`; cancel it with
`in_review → in_progress → canceled`.

## reconcile --workflow — the board's workflow plan

```bash
taskctl issue reconcile --workflow --reviewer jobs --auto-accept-reviews yes \
  --review-aging-ms 3600000 --max-actions 20 --board-limit 500 --json
```

`--json` returns `{dry_run, scanned, actions, workflow}`, where `workflow` is
`{alerts, actions, changes, summary}` in snake_case. `--board-limit` bounds the snapshot; a
truncated snapshot still applies outcomes but dispatches nothing. The actions
(`create_review`, `approve`, `approve_hold`, `reject_task`, `reject_epic`,
`reject_task_finish`, `close_review`, `cancel_review`) are decisions — the board writes none of
them; the loop executes them and closes the review card last. A `cancel_review` on a review
card still in `in_review` is a two-hop move (`in_review → in_progress → canceled`), never
`done`. The rules are in
[`status-lifecycle.md`](status-lifecycle.md#11-the-boards-workflow-decisions).

## `--json`

Wire names are `snake_case`. A task looks like:

```json
{
  "ok": true,
  "data": {
    "task": {
      "id": "…uuid…", "identifier": "PROJ-0007", "project_id": "proj", "title": "…",
      "status": "in_review", "awaiting_reason": null, "priority": "high", "labels": [],
      "version": 4, "delivery_round": 1, "report_latest_id": 3, "report_waiver": null,
      "status_changed_at": "2026-10-09T…Z",
      "assignee": { "id": "…", "display_name": "linus", "kind": "agent" },
      "reporter": { "id": "…", "display_name": "elon", "kind": "human" }
    },
    "report_waivers": [],
    "token_source": "file"
  }
}
```

An actor always carries `display_name` **and** `id`. `token_source` names the source used
(`flag`, `env`, `file`, `none`) and never carries a value. Errors are the domain error
verbatim:

```json
{ "ok": false, "error": { "code": "REPORT_REQUIRED", "message": "…", "http": 422,
                          "details": { "round": 1, "existingRounds": [] },
                          "hint": { "command": "taskctl issue deliver PROJ-0007 --report-file -" } } }
```

Bind scripts to `error.code` and `error.hint.command`, never to the prose.

`events tail` is the exception: it writes newline-delimited records (see [`events`](#events)),
not this envelope. Every other command, including `sla list`, answers one document.

## Notes

- Everything is **local**: no network beyond loopback to your own board.
- Every state-mutating write is safe under concurrent agents — transactions and
  compare-and-swap are the service's guarantee, not the CLI's.
- Data lives in `<dataDir>/board.sqlite` (default `<repo>/.data`), overridable with
  `TASKD_DATA_DIR` / `TASKD_DB`.
