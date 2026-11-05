# taskctl — comments, relations, files and export

> The prose behind the command index in `../cli.md`: comments, relations, attachments, the
> report template, export and the brief watch, plus the card-editing commands. The card
> flow is `issue.md`; the frozen flag table is `../cli.md`.

### `comment`

| Command | Purpose |
|---|---|
| `comment list <ref> [--kind <kind>] [--limit <n>]` | Newest first (the CLI asks for `order=desc`, so `--limit` takes the newest N). |
| `comment add <ref> (--body <text> \| --file <path\|->) [--kind discuss\|decision\|confirm\|confirm_request\|change\|note\|defect\|question] [--ref <kind:id>]…` | Append. The body comes from `--body`, or from `--file` (`-` reads stdin); `--file` wins when both are given, and **neither is a usage error** (exit 2). `--kind` defaults to `note`. `--ref` is repeatable and stored as the comment's wire `refs` (plain strings; `kind:id` is the convention). A `question` + `awaiting` E2 is how an agent asks a human; **any human comment** on an `awaiting` card moves it back to `todo` in the same transaction, whatever its kind. |

Append-only: there is no edit and no delete, by design. A `decision` / `change` comment is what
a reviewer reads later as the explicit record; the resume itself is decided by the comment's
content, not its kind. The body is Markdown; `export md` escapes its newlines to `\n` to keep
one record per line.

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
(`meta.acceptance_derived=yes`) carries a warning on stderr. The report's conclusion and
leftovers, and an acceptance note, are Markdown; the item text stays plain (the matching key).
Evidence anchors are the
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
