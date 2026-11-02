# taskctl — cards, delivery and review

> The prose behind the command index in `../cli.md`: the issue group, create, claiming,
> promotion, comments, relations, attachments, reports, export, editing, the delivery gate,
> awaiting/blocked and review-card fields. The frozen flag table is `../cli.md`.

### `issue`

> The status model — every status, transition and guard — is in
> [`lifecycle/transitions.md`](../lifecycle/transitions.md). This section is the command surface.

| Command | Purpose |
|---|---|
| `issue create` | Create a card. Synopsis and flag semantics: [below](#issue-create). |
| `issue list [--project] [--status <s>]… [--assignee <name>\|--assignee-id <id>] [--parent <ref>] [--kind <kind>] [--label <label>]… [--target <value>] [--meta <key>=<value>]… [--review-of <ref>] [--limit] [--include-archived] [--order-debug]` | List cards. Archived cards are hidden unless `--include-archived` is set. The order is always the assignee weight order (below); there is no sort flag. `--review-of <ref>` returns the **review cards of** that card — not the card itself — across every round (`review_round` is on each returned card, so a caller selecting the current round filters on it). It combines with the other filters and is read-only. An unknown ref is `NOT_FOUND`; an identifier that exists in two projects is `VALIDATION_FAILED`. **The further filters are all pushed into SQL** (they hold under `--limit`): `--parent` = that card's children; `--kind` = `task\|epic`, or `review` for the cards that carry the review marker (`review_of_id`) — a review card is still an ordinary task, so `--kind task` keeps returning it and `review` only narrows further (an unknown kind is `VALIDATION_FAILED`); `--label` repeats and every label must be present, matched against the card's **exact display name** (no normalisation, no `labels` registry); `--target` compares `meta.target` as text; `--meta k=v` repeats, every pair must hold, and the key must match `[A-Za-z0-9_.-]+`; `--assignee` resolves a free-text name through the dictionary (an unknown name matches **nothing**, not everything) and is refused together with `--assignee-id`. |
| `issue candidates --assignee <name> [--stale] [--include-unassigned] [--order-debug]` | The claim read: `todo` cards that are auto-claimable (not an `epic`), every `depends_on` predecessor `done` (a `canceled` one also withholds). `--stale` adds the recovery pool (holder after 30 min, anyone after 6 h); `--include-unassigned` adds the public pool. Read-only; no `--limit`. |
| `issue get <id\|identifier> [--include comments\|reports\|relations\|sessions]… [--limit <n>]` | One card, plus `report_waivers[]` and `attachments[]` (`id`, `filename`, `content_type`, `size`, `kind`, `created_at`, `comment_id`). The human view prints identifier, title, status, priority, kind, labels, assignee, reporter, claimed_by, heartbeat_at, delivery_round, acceptance_mode, review_of (the reviewed card's identifier), review_round, parent, awaiting_reason, acceptance_revision, the numbered acceptance snapshot (`none (vacuous)` when empty), meta as JSON, the description and version, then a waiver row and an attachment table when present. `--json` carries the same fields: `acceptance[]` is the **frozen baseline**; `meta.acceptance` is only its seed; `role` is the derived word (`task\|epic\|review`) — `kind` stays `task` on a review card, so read `role`, not `kind`, to ask what the card is for. `--include <section>` (repeatable) adds, under the section's own name in `data`, exactly what that command returns: `comments` → `data.comments[]` (newest first; `--limit <n>` caps it, default **50**, `0` = no cap), `reports` → `data.reports[]` (every round), `relations` → `data.relations` (`relation list`'s payload minus `task_id`), `sessions` → `data.sessions[]`. Without `--include` the payload is unchanged. An unknown section, or `--limit` without the `comments` section, is a usage error (exit 2) — never a silent no-op. |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]… [--drop-acceptance <text>]… [--acceptance-revision <n>] [--acceptance-mode off\|auto\|human [--reason "<why>"]]` | Patch. `--status` is refused here on purpose. `--acceptance` **appends** to the frozen baseline (`tasks.acceptance_json`) and is idempotent by criterion text; it cannot remove it. `--drop-acceptance` is **human-only**, needs `--reason` (≥ 8 characters) and the current `--acceptance-revision`; both are audited. `--acceptance-mode` is the single acceptance decision (`off` = no review/direct done, `auto` = independent review then the loop closes on APPROVE, `human` = human-only close after the review finishes); an agent may only tighten `off → auto|human`, and leaving `auto` needs `--reason` and no open current-round review card. |
| `issue move <ref> <status> [--allow-steal --reason "<why>"] [--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--question "<text>"] [--blocked-reason <word>]` | Move, subject to the delivery gate. `todo → in_progress` is a **claim**; a move to `done` is an **acceptance** and requires a current-round report that covers every frozen acceptance criterion — for an **epic**, a current-round rollup (`ROLLUP_REQUIRED` / `ROLLUP_STALE`). `done`/`canceled → todo` is the audited **reopen** and needs `--reason` (prefer `issue reopen`). `--awaiting-reason` is required for `awaiting`; an agent entering `awaiting` must also supply `--question` (or already have an unanswered `question` comment). `--blocked-reason` is optional. |
| `issue reopen <ref> --reason "<why>"` | **Reopen a `done`/`canceled` card to `todo`.** Audited: the reason is required (≥ 8 characters) and recorded as `task_reopened`. Starts a new delivery round, clears the archive and releases the idem key. A review card is refused — reopen the original; the loop issues the next round's review. |
| `issue claim <ref> [--check-blockers] [--allow-steal --reason "<why>"]` | **Claim, re-claim or take over.** On `todo` it behaves like `move … in_progress`; on `in_progress` it is the only recovery path. The holder may re-claim after 10 min; anyone may take over after 6 h. A fresh claim by another actor is `EXECUTION_ACTIVE`. `--check-blockers` is opt-in: the board re-reads the card's `blocks` predecessors and refuses with `BLOCKED_BY_PREDECESSOR` (details carry the open predecessors) when one is not `done`. Claim does **not** re-check by default — the poll (`issue candidates`) already withholds blocked cards, and `issue move … in_progress` remains the caller's own responsibility. |
| `issue heartbeat <ref>` | Pulse a claim you hold. Refreshes `heartbeat_at` and nothing else; holder only; `in_progress` only; takes no flags of its own. |
| `issue wait <ref> [--question <comment-id>] [--timeout <ms>] [--interval <ms>] [--heartbeat <sec>]` | The worker's bounded in-turn hold after it writes an agent `question`. Reads the card and the trail after the question every `--interval` (default 2000 ms); it never claims, moves or comments. `answered` (exit 0) **only** when the card was **released** (`todo`, or a status change after the question, including a released-then-reclaimed card); a `note` — the director's or the worker's own — does not end the hold, because the two share one board identity. `answer` still carries the bounded newer trail. `escalated` (exit 3) when the card is `awaiting`: park; a human answer resumes the session by id. `moved` (exit 3) when the card left the work states or another actor owns the claim. `timeout` (exit 3) after `--timeout` (default 110000, max 540000): re-invoke once when the runtime allows it, then park; the loop resumes the session when the release lands. `error` (exit 1) after three unreadable reads. While waiting it pulses the caller's own heartbeat every `--heartbeat` seconds (default 240; `0` disables) so the claim stays fresh. A non-zero exit is a **result**, not a failure: read `outcome` from `--json`. |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--reporter-id <id>] [--force-create]` | Assign. |
| `issue archive <ref> [--days <n>]` | Archive finished work (done/canceled; 7-day window by default). |
| `issue meta <ref> --meta <k>=<v>…` | Merge metadata keys into a card, leaving other keys intact. The read-modify-write form with `--if-version` CAS. |
| `issue deliver <ref> --report-file <file\|-> [--to done] [--no-report --reason "<why>"] [--seg <seg>]` | **Write the report and move, in one transaction.** The default destination is `in_review`; `--to done` is the `off` card's **direct acceptance** (any other `--to`, and a waiver with `--to done`, are usage errors). The two report forms are mutually exclusive. On an **epic** the report is its rollup: it must name every live child by `ref` (`ROLLUP_STALE` otherwise) and is stored with `is_rollup = 1`; `--no-report` is refused for an epic (`ROLLUP_REQUIRED`). |
| `issue reconcile [--dry-run] [--workflow] [--reviewer <agent>] [--review-aging-ms <n>] [--rework-max-rounds <n>] [--max-actions <n>] [--board-limit <n>]` | Without `--workflow`: replay the epic rules over every non-terminal container. With it: return the board's workflow plan (see below). `--dry-run` writes nothing. `--rework-max-rounds` bounds the delivery rounds before a loop hold. Idempotent. |

#### `issue create`

```bash
taskctl issue create --project <id> --title <t> [flags]
```

| Flag | Meaning |
|---|---|
| `--project <id>` | **Required.** The project that issues the card; the card is numbered with that project's identifier prefix (declared or id-derived). |
| `--title <t>` | **Required.** The one-line summary. |
| `--acceptance-mode off\|auto\|human` | The card's acceptance decision. `off`: no review; the deliverer may close it directly (`in_progress → done`). `auto`: an independent review card must APPROVE before the loop closes it; this is the fallback when the mode is omitted. `human`: a human closes it after the current-round review finishes. Any explicit value is the whole decision — there is no project default; a project may document its selection guidance in `docs/agents/acceptance-mode.md`, which this skill discovers at creation. A review card is always `off`. |
| `--acceptance <text>` | One acceptance item; repeat for each. |
| `--assignee <text>` / `--assignee-id <id>` / `--assignee-kind <agent\|human>` | Route the card. `--assignee-id` bypasses the dictionary. |
| `--reporter <text>` / `--reporter-id <id>` / `--reporter-kind <agent\|human>` | Set the reporter. |
| `--description <md>` | The markdown description. |
| `--priority <low\|medium\|high\|urgent>` | Urgency; a card with none reads as `medium`. |
| `--kind task\|epic` | The card's role; default `task`. |
| `--label <l>` / `--meta k=v` | Repeatable labels and metadata. |
| `--target <t>` | An opaque per-card value; it is not a directory. |
| `--parent <ref>` | Fills the idempotency key's source slot; it **links nothing** — use `relation add --type parent`. |
| `--status <s>` | Initial status; see [`lifecycle/transitions.md` §8](../lifecycle/transitions.md#8-creating-a-card-in-a-status). |
| `--idem <key>` | Creation idempotency key; a match returns the existing card, keeping its acceptance mode. |
| `--allow-dup` / `--force-create` | Skip the duplicate guard / the fuzzy dictionary step. |
| `--review-of <ref> [--review-round <n>]` | Create a review card for that original and round. |

**Routing is the handoff.** In a team project `--assignee` is part of the create, not a later
step: the supervisor scans the role skills it discovers plus `MEERKAT_TASKPANEL_AGENTS`, so a
card assigned to a name nobody scans is never claimed. Read the role skill whose shapes fit
the work and pass that one accountable role (`--assignee <role> --assignee-kind agent`) in the
same call. An unassigned card is claimed as `Worker`, or routed by `meerkat-director`; never
invent a role name.

### The weight order (every task list)

`issue list` and `issue candidates` are **always weight-ordered**: a hard **tier** (can I move
this card at all?), then a weighted score (priority, time in status, age, SLA pressure, how
many cards this unblocks), then a deterministic tie-break ending on the identifier. A tier is
never traded against a score. There is no sort flag — the order is not optional. Inside
`issue candidates` the claimability bucket stays the first key; the weight order only refines
within a bucket. `--order-debug` adds
`{id, identifier, order, tier, tier_name, score, factors}` to reconcile a rank by hand; the
projection is opt-in and does not change the order.

### Claiming: only the assignee may claim

`issue move <ref> in_progress` on a `todo` card takes the execution lock
(`claimed_by` / `claimed_at` / `heartbeat_at`). The **assignee** is who the card is routed to;
the **claimer** is who is doing it now.

- **Unassigned** cards are an open pool: any actor may claim them.
- An **`epic`** can never be claimed (`not_claimable`); `backlog` is not claimable either.
- A card routed to somebody else is refused on the first claim with `not_assignee`.
  `--allow-steal --reason "<why>"` (reason ≥ 8 characters) is the audited override, valid on
  that first claim only; it records a `task_claimed` activity and a `kind: change` comment.

The holder may re-claim after **10 minutes**; anyone may take over after **6 hours**. The full
threshold table, including the 30-minute stale pool, is in
[`lifecycle/claims.md` §5](../lifecycle/claims.md#5-claims-and-heartbeats).

A **rework** (`in_review`/`blocked → in_progress`) is not a claim: it keeps the existing
executor and their lock. The claim is held in `in_progress`, `awaiting`, `in_review` and
`blocked`, and released by the write that moves the card to `todo`, `backlog`, `done` or
`canceled`. The board runs **no background pulse**; keeping it fresh is the holder's job.

### Promoting an existing card to an epic

`kind` is patchable, and a card filed from the web UI is always a `task`:

```bash
taskctl issue update PROJ-0007 --kind epic
taskctl relation add PROJ-0007 --type parent --target PROJ-0008
```

Only an `epic` may be a parent (`VALIDATION_FAILED`, `details.field: kind`, until promoted).
Neither end of a `parent` edge may be a review card (`VALIDATION_FAILED`,
`details.field: source|target`), even with `--force`. `todo → in_review` is the epic's own
edge. The promotion is an ordinary patch — status, claim, heartbeat and delivery round stay
put — and leaves no comment, so write the split down yourself. An epic that still has children
cannot be downgraded to `task`. The board starts and closes the container; see
[`lifecycle/containers.md`](../lifecycle/containers.md#6-containers-epic).

### `comment`

| Command | Purpose |
|---|---|
| `comment list <ref> [--kind <kind>] [--limit <n>]` | Newest first (the CLI asks for `order=desc`, so `--limit` takes the newest N). |
| `comment add <ref> (--body <text> \| --file <path\|->) [--kind discuss\|decision\|confirm\|confirm_request\|change\|note\|defect\|question] [--ref <kind:id>]…` | Append. The body comes from `--body`, or from `--file` (`-` reads stdin); `--file` wins when both are given, and **neither is a usage error** (exit 2). `--kind` defaults to `note`. `--ref` is repeatable and stored as the comment's wire `refs` (plain strings; `kind:id` is the convention). A `question` + `awaiting` E2 is how an agent asks a human; **any human comment** on an `awaiting` card moves it back to `todo` in the same transaction, whatever its kind. |

Append-only: there is no edit and no delete, by design. A `decision` / `change` comment is what
a reviewer reads later as the explicit record; the resume itself is decided by the comment's
content, not its kind.

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
explicit flags first, then a read-only `git rev-parse HEAD` **on a clean tree** (an empty
`git status --porcelain`), then the task's `source_path`, then a placeholder. A dirty tree
never stamps HEAD — the previous commit does not contain the work — so the template warns and
leaves a path anchor that the delivery gate refuses (`DELIVERY_NEEDS_COMMIT`) until the work
is committed and `--commit <sha>` is passed.

### `export`

| Command | Purpose |
|---|---|
| `export md [<ref>] [--out <dir\|file.md>] [--project <id>] [--check] [--md] [--watch]` | Write markdown cards: every identifier into a directory, or only `<ref>` (id or identifier). `--out` defaults to the current directory. With `<ref>`, a `--out` ending in `.md` that is not an existing directory names the file itself; otherwise it is a directory and the card lands at `<dir>/<ID>.md`. `--project` cannot be combined with `<ref>` (usage error, exit 2). `--watch` registers the same detached brief watch as `export watch --detach` for one ref + one `.md` file; the hub writes the first snapshot before returning, and it cannot be combined with `--check` or `--project`. |
| `export watch [<ref>] [--ref <ref>]… [--dir <dir>\|--out <file>] [--after <rev>] [--idle <ms>] [--ttl <ms>] [--once] [--detach] [--watch-status] [--stop] [--standalone]` | Keep a card brief fresh through the local event hub (or directly with `--standalone`). `--dir` names the `.meerkat/<identifier>/card.md` sugar; `--out` names one exact file for one ref (the path is authoritative and its parent is created). The two are mutually exclusive. Explicit refs only; there is no `.meerkat/` discovery. A registration ends at `done` or `canceled`. |

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
[`schema/records.md`](../schema/records.md).

#### `export watch`

`export watch` keeps a card brief fresh. By default it **registers with the local event
hub** (`events hub`), which owns the host's single SSE connection for this board; the command
itself only talks to the hub over loopback. `--standalone` keeps the original direct-SSE
implementation for a sandbox or a differential check.

```text
taskctl export watch <ref> --dir <project>                 # foreground NDJSON stream
taskctl export watch <ref> --dir <project> --detach        # register and return
taskctl export watch <ref> --dir <project> --watch-status  # is it running?
taskctl export watch <ref> --dir <project> --stop          # unregister
taskctl export watch <ref> --dir <project> --once          # one export, no watcher
taskctl export watch <ref> --dir <project> --standalone    # direct SSE (fallback)
taskctl export watch <ref> --out <file> --detach           # one exact file (the path is authoritative)
taskctl export md    <ref> --out <file.md> --watch         # the same watch, the export spelling
```

The positional ref and each repeatable `--ref` are unioned; at least one is required.
With `--dir` (default cwd) the target is `<dir>/.meerkat/<identifier>/card.md`; with
`--out` it is exactly the file named, one ref only, and the hub creates its parent
directory. `--out` and `--dir` are mutually exclusive. The first export
is written before `open`; a bad ref is a normal `{ok:false}` document and creates nothing.
Writes are atomic (a unique temp file in the same directory plus a rename; a byte-identical
render is left alone, so mtime does not churn), and the 4× `MD_GROWTH_FACTOR` guard does
**not** apply — a brief legitimately grows when comments or a report land. Refreshes are
coalesced on the loop's cadence — 300 ms debounce, 2 s maximum wait, 5 s minimum interval
between batches — and never overlap.

Foreground output is newline-delimited JSON, like `events tail`:

```json
{"type":"open"}
{"type":"refresh","task_id":"…","identifier":"PROJ-0007","path":"/repo/.meerkat/PROJ-0007/card.md","changed":true,"status":"in_progress"}
{"type":"done"}
```

`refresh` carries `changed:false` when the file was already current, `status` from the
board, and an `error` object (the usual `{code,message,…}`) when one card could not be
re-read; that failure is not fatal. Terminal lines are `done`, `ttl`, `idle`, `shutdown`,
`eof` (exit 0) or `error` (exit 1), and always follow the last `refresh`.

**`--detach` is the worker form.** It writes the first brief, registers the card with the
hub, prints `{ok:true,data:{registration_id,running,cards,expires_at}}` and exits — no client
process has to survive the harness's command boundary. The hub keeps the registration (and
its single board connection) until the card reaches `done`, `--ttl` expires, or `--stop`
removes it. A detached registration is written to the hub's state file and resumes after a
hub restart; `--watch-status` reports `{running,registration_id,cards,expires_at}` and does
not start a hub just to answer. `--stop` unregisters (starting the hub if needed, so a
persisted registration cannot resume). Repeating `--detach` for the same card is idempotent
and returns the existing registration.

**`done` and `canceled` are terminal.** A card that reaches either is written once with its
final brief and dropped; when the last card is terminal the registration ends and a
foreground stream writes `{"type":"done"}`. If every named card is already terminal at
registration, the briefs are written and the registration immediately reports
`running:false, reason:"terminal"` — no SSE connection is opened. A terminal card that is
later reopened (`issue reopen`) is no longer watched: run a new `--detach`.

`--ttl <ms>` bounds a registration (default **120 minutes**; `0` disables it). A
registration is also bounded by its card's terminal status, which is the normal ending for
the loop's `--ttl 0` registrations. `--once` exports once and exits without a watcher.
`--after` and `--idle` are accepted for compatibility but belong to the direct stream:
under the hub the hub owns the cursor and liveness; `--standalone` is where those flags take
effect.

One watcher per card is enough. The loop's poll registers each dispatched card's brief with
the hub (the review card and its original as one registration), so a loop-dispatched worker
must not start a second watcher for the same file.

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
[`lifecycle/transitions.md`](../lifecycle/transitions.md#8-creating-a-card-in-a-status).

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

A file that already exists when the card is created — a plan, a third-party spec, a vendor's
PDF, a screenshot — is uploaded immediately after `issue create`: the create has no `--file`,
so `attachment add` is the second call, and the card's brief lists it from then on. Any type the
board accepts can ride on a card — a plan is the common case, not a restriction.

A **plan** is stored under the fixed name `plan.md` (`--name`), whatever the file is called on
disk: that is the name the worker and the reviewer look for, and a random export name is not.
Every other document keeps its own name, and a plan that is not Markdown keeps its extension —
`--name` also decides the stored `content_type` when the extension names one.

Upload mints the metadata row, then stores the bytes — a row whose `PUT` never arrives answers
an honest `404` on download. Removal deletes the row and the bytes in one transaction; it is
**not recoverable**. An attachment id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
`--meta attachments=…` stores literal text, not an array; it is not a channel into this table.
Loop convention: `card.md` and every downloaded attachment for a task live under
`.meerkat/<identifier>/`; see `meerkat-director/references/operation.md` §Card briefs.

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

`issue create --acceptance` seeds the frozen baseline; `issue update --acceptance` **appends**
and never replaces; a human may remove an item with `--drop-acceptance <text> --reason "<why>"
--acceptance-revision <n>`. Imported cards carry `meta.acceptance_legacy` (its `checked` state
is never evidence). The gate, the snapshot rule and the derivation rule:
[`lifecycle/delivery.md` §4a](../lifecycle/delivery.md#4a-the-acceptance-baseline).

## The delivery gate

A refusal looks like this:

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
```

`issue deliver` writes the report and performs the move atomically; `report template` prints a
report `deliver` accepts without editing. The second line is the **audited waiver** (reason
≥ 8 characters, stamped on the task row and recorded as a `report_waived` activity). The gate
rule and the round table:
[`lifecycle/delivery.md` §4](../lifecycle/delivery.md#4-the-delivery-gate-and-the-delivery-round).

On an **`agent`** card each `met` item's `note` must cite an anchor from the report's own
`evidence[]`, written `evidence[n]` (1-based). The template seeds the note with
`evidence[1]`, so filling it in is "say what you saw". A `met` with no reference
(`no_anchor`) or one past the end of the list (`dangling_anchor`) is
`ACCEPTANCE_INCOMPLETE` with `details.unsupported`; an empty evidence list makes every
reference dangle. An `off` or `human` card is not held to this rule. An APPROVE on a review
card additionally needs a `{kind: "command", cmd, exit_code}` anchor — the reviewer runs the
gate it records.

The same rule bites **at delivery**: `issue deliver` refuses an anchored-`met` violation the
way `done` would (`ACCEPTANCE_INCOMPLETE`, `details.source = "delivery"`), because a report is
bound to its round and cannot be amended afterwards. Fix the note — or report the item as
`not_met`/`partial` — and deliver again; nothing is written on a refusal.

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
the card while it is `awaiting` and cleared on exit. An agent must also ask the question
(`--question`, or an already-unanswered `question` comment) — `QUESTION_REQUIRED` otherwise.
Read the set with `issue list --status awaiting`; the web board's **waiting** view is the same
set. Entry, exits and the resume rule: [`lifecycle/transitions.md` §1](../lifecycle/transitions.md#1-the-vocabulary).

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
[`schema/blocked-reason.md`](../schema/blocked-reason.md#blocked_reason--what-a-blocked-card-is-waiting-for).

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
cannot be claimed, so an epic review card would never be woken). A review card in `in_review`
cannot be moved directly to `canceled`; cancel it with
`in_review → in_progress → canceled`. Detection and the two-round model:
[`review-workflow.md`](../review-workflow.md).
