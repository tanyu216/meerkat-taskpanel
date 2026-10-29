# Projects: the board's scope for work and numbering

A project is the board's grouping of tasks and the scope its card identifiers are numbered
in. It is **not a workspace**: it holds no directory, no member list and no lifecycle. This page is
the design of that subsystem — what a project is, how its identity and identifier prefix are
derived and protected, what it carries, how it is created and read, how the board orders the
list, and exactly where the board's responsibility ends.

The design stance, in four sentences:

- **Identity is two things, one of which is derived.** The project `id` is an opaque primary
  key; the **effective prefix** — the token every card of the project is numbered with — comes
  from a declared slot if the project has one, otherwise from the id. One function resolves it
  for both the allocator and the collision check.
- **A project carries defaults, not workflow.** It supplies a new card's acceptance mode and
  reviewer; what a card does with them is [acceptance.md](acceptance.md)'s subject.
- **The board decides the order, the client consumes it.** The `PROJECTS` list is ranked
  server-side by recent activity ([DESIGN.md](../design/DESIGN.md) §20); the browser never
  re-sorts it.
- **The directory is host-local.** Which local checkout a project's workers run in lives in a
  machine-local `projects.json`, never on the board and never on the wire.

## Design at a glance

| Component | Home | Invariant it upholds |
|---|---|---|
| **project row** | `projects` table (`src/core/storage/migrations/0001_init.sql`) | one row per scope; tasks reference it by foreign key; there is no delete surface |
| **effective prefix** | `src/foundation/ids.mjs#projectPrefix` | one derivation, read by the allocator and the collision check alike |
| **identifier allocation** | `src/core/storage/repositories/projects.mjs#allocateIdentifier` | counter read and bump happen in one transaction, so numbers never repeat |
| **use-cases** | `src/core/commands/projects.mjs` | creation refuses a taken prefix; the prefix is fixed once issued |
| **wire projection** | `src/foundation/wire.mjs#projectToWire` | camelCase → snake_case in one place; `prefix` is derived, never client-computed |
| **defaults** | `src/core/domain/acceptance-mode.mjs`, `src/core/domain/reviewer.mjs` | a project supplies values; the card's snapshot is frozen at creation |
| **ordering** | `src/foundation/project-order.mjs` | rank-normalised weights, computed at the boundary |
| **directory map** | `src/foundation/project-dir.mjs` | the map is host-local; an unregistered project is a coded stop, never a guess |

## What a project is — and is not

A project **is**:

- the owner of an identifier counter, so its cards read `PREFIX-0001`, `PREFIX-0002`, …;
- the foreign-key scope of every card, comment, label registry entry and activity row;
- the carrier of two defaults a new card inherits — the acceptance mode and the reviewer;
- a name, a free-form `meta` document, an optional `labels` set and an optional `readme`.

A project **is not**:

| Expectation | What the board does instead |
|---|---|
| a working directory | keeps it in the machine-local `projects.json` (`taskctl project map`), never on the board |
| a member or role list | actors are board-wide; a card's assignee, reporter and reviewer are card facts |
| a lifecycle or stage | cards have statuses; a project has no state machine, only an `archived_at` flag |
| a delete target | no endpoint, no CLI command; cards reference the project by foreign key |

## Identity: the id and the prefix

### The id

The project `id` is an opaque string, the table's primary key, chosen at creation and never
edited afterwards. It is either **named by the caller** — `project create --id`, `project
ensure <id>`, `PUT /api/v1/projects/:id` — or **minted by the server** when a create omits it.
The CLI path is also where the prefix comes from unless one is declared; the web create dialog
(`POST /api/v1/projects` with no `id`) gets a UUID and supplies its prefix through the dialog
field, so the UUID never appears on a card.

The `name` is the human label, freely changeable; the id is not displayed as identity anywhere
except routing and joins.

### The effective prefix

Every task identifier is `<PREFIX>-<serial>`. The prefix is resolved **once, in one function
(`projectPrefix`), in this order**:

1. the project's declared slot, `meta.prefix`, normalized at creation;
2. otherwise the project's id, normalized.

Normalization (`identifierPrefix`) is a pure, idempotent function: trim → uppercase → collapse
every run of characters that is not `A`–`Z` or `0`–`9` into a single `-` → strip leading and
trailing `-`. It is many-to-one:

| project id | identifier prefix |
|---|---|
| `meerkat-taskpanel` | `MEERKAT-TASKPANEL` |
| `demo_x`, `demo-x`, `demo.x`, `demo  x` | `DEMO-X` |
| `acme-team`, `acme_team`, `acme.team` | `ACME-TEAM` |
| `Demo`, `demo` | `DEMO` |

The stored value is re-normalized on read rather than trusted, so a row written past the
use-case (a hand-written or imported row) still resolves to what creation would have stored.
The normal path is unaffected because the function is idempotent.

**Why the slot exists.** A project created through the dialog gets a UUID id; numbering from
that would print a UUID on every card. The declared prefix is the project's *own* property,
which is also what the prototype models — the sidebar chip and the card number are the same
token (C-PREFIX-1, [project-prefix-binding.md](../design/contracts/project-prefix-binding.md);
C-RAIL-1, [side-rail-short-code.md](../design/contracts/side-rail-short-code.md)).

### The prefix is unique across projects

Two projects whose effective prefixes match hand out **the same** identifiers —
`DEMO-0007` from either would be indistinguishable on a card. Creation therefore refuses a
prefix another project already owns. The comparison is between **effective** prefixes, so it
sees both carriers: a declared `meta.prefix` of `demo` collides with a project whose id is
`demo`, because the board cannot tell their cards apart. It runs against **every** project,
archived included — archiving does not retire a prefix, because the identifiers it issued are
still on cards.

| Situation | Answer | Writes? |
|---|---|---|
| new id normalizes to a prefix another project owns | `VALIDATION_FAILED` (400), `details.field: "id"` | no |
| declared `meta.prefix` normalizes to a taken prefix | `VALIDATION_FAILED` (400), `details.field: "meta.prefix"` | no |
| declared prefix is not a string, or normalizes to nothing | `VALIDATION_FAILED` (400), `details.field: "meta.prefix"` | no |
| id equals an existing project's id | `ID_CONFLICT` (409) — the primary key, not a prefix refusal | no |
| id with no declared prefix normalizes to nothing (`--id ###`) | creation succeeds; the first card allocation fails | later |

A prefix refusal carries `details.prefix` and `details.conflictProjectId`; the message names
the owning project too. When history already contains several projects sharing a prefix, the
refusal names the same (lowest-id) one every time, so the answer is deterministic. The check
and the insert share one transaction, so a refusal leaves no row and no `project_created`
activity behind.

An undeclared prefix that normalizes to nothing is **not** a creation refusal: that guard lives
downstream, in `identifierForPrefix`, which refuses to mint for an empty prefix. The rule here
is about collisions, not emptiness. A **declared** empty prefix is refused at creation, because
storing it would create a project that can never mint a card.

### The prefix is fixed at creation

`PATCH /api/v1/projects/:id` drops any `meta.prefix` it carries and restores the stored one, so
an update can neither replace a prefix nor introduce one on a project that numbers from its id.
Other `meta` keys in the same patch still land — the key is dropped, not the update refused.
The reason is the one invariant the slot exists for: numbers already printed on cards must not
change under them.

### Numbering

`projects.next_task_number` starts at 1 and is read-and-incremented inside the creating
transaction (`BEGIN IMMEDIATE`); the identifier is `<prefix>-<serial>` with the serial padded to
four digits (`-0001`). A serial past 9999 simply grows longer — padding never truncates.

Allocating a number bumps only the counter, which is not one of the columns the revision
trigger watches, so allocation alone does **not** advance the board's global revision; the
card's own insert does.

The board itself puts no length limit on a prefix. The web dialog caps its field at four
characters (a design constraint, not a server rule), so longer prefixes arrive only through the
CLI or the HTTP API; the rail chip's 24px box and how it clips them belong to
[rail-chip-overflow.md](../design/contracts/rail-chip-overflow.md).

### Pre-existing collisions are read, not repaired

A board can already contain projects that collide — rows imported before this rule existed, or
written straight through the storage layer. The board reads them normally: nothing is renamed,
no command fails, startup is not blocked. The rule applies to **new** creations, so a new
project that joins an existing collision is refused and told which project it clashes with. To
resolve a collision, give the project a distinct id; archiving does not free the prefix.

## What a project carries

| Field | Wire name | Mutable | Notes |
|---|---|---|---|
| `id` | `id` | no | primary key; the routing segment and the FK target |
| `name` | `name` | yes | required and trimmed at creation; rename does not affect the prefix |
| `meta.prefix` | inside `meta` | no | reserved; normalized once at creation |
| effective prefix | `prefix` | no | derived per read by `projectPrefix`; not stored separately |
| `next_task_number` | — | internal | the identifier counter; not on the wire |
| `labels` | `labels` | yes | a stored label set; see the note below |
| `meta` | `meta` | yes | free-form JSON; PATCH merges at the HTTP surface |
| `readme` | `readme` | yes | a whole document, replaced by `PUT …/readme` |
| `acceptance` | `acceptance` | yes | `auto` (default), `off`, `agent`, `human` |
| `reviewer` | `reviewer` | yes | optional override; `null` falls back to the deployment reviewer |
| `archived_at` | `archived_at` | storage only | no product command sets it |
| `created_at`, `updated_at` | same | system | ISO-8601 UTC, millisecond precision |

The wire additionally carries `task_count`, a **computed** per-request number (below), never a
stored column.

### The two defaults a project supplies

- **`acceptance`** — the default mode for cards created in the project. `auto` means "the
  creator decides per card" and is never stored on a card; `off`, `agent` and `human` are
  concrete defaults. Resolution at creation, the `human`-is-top-level-only rule and the
  `agent` fallback are [acceptance.md](acceptance.md)'s subject. Changing the project value
  affects **future cards only** — a card's mode is frozen when it is created.
- **`reviewer`** — an optional override naming the agent that reviews the project's cards. A
  blank or absent value means "use the deployment-level reviewer". The board has no agent
  dictionary to validate against, so the value is trimmed and stored verbatim; only a
  non-string is refused. The loop merges every project reviewer into its scan and wake set.

### `meta`

Free-form JSON for anything a deployment wants to attach to a project. At the HTTP surface a
`PATCH` `meta` is a **merge delta** (`{...current, ...delta}`); the use-case beneath replaces the
document, which is why the route merges first. One key is reserved: `prefix`, which only
creation may write.

### `readme`

A free-text document about the project, not board state that anything derives from.
`GET /api/v1/projects/:id/readme` returns the raw string (`null` when unset);
`PUT /api/v1/projects/:id/readme` replaces the whole document. The CLI wraps both as
`project readme <id> [--set <text> | --file <path|->]`. No browser surface renders it today.

### Project labels

A project row also stores a `labels` array, accepted via `--label` on create/update and served
on the wire. It is distinct from the **label registry** (`labels` table), which is keyed by
project and grows from card use. Nothing in the current surfaces reads `project.labels` — treat
it as reserved metadata rather than a feature.

### Archived projects

`archived_at` exists and the read paths honour it: `project list` and `GET /api/v1/projects`
exclude archived projects unless `--include-archived` / `include_archived=1` is passed, and
when included they are pinned to the **bottom** of the ranked list. No command or endpoint
archives a project, so the column is there for rows that arrive archived from outside the
use-cases; an archived project keeps its prefix reserved and its cards keep their identifiers.

## Lifecycle and surfaces

| Operation | HTTP | CLI | Web |
|---|---|---|---|
| create | `POST /api/v1/projects` (id optional) | `project create --id <id> --name <name>` | create-project dialog |
| create if absent | `PUT /api/v1/projects/:id` → `{project, created}` | `project ensure <id>` | — |
| update | `PATCH /api/v1/projects/:id` | `project update <id>` | — |
| read | `GET /api/v1/projects/:id` (null on a miss) | `project dir <id>` (existence check, then the map) | project switch |
| list | `GET /api/v1/projects[?include_archived&order_debug]` | `project list [--include-archived]` | sidebar load |
| readme | `GET`/`PUT /api/v1/projects/:id/readme` | `project readme` | — |
| directory (host-local) | — | `project map list\|show\|set\|remove` | — |

**Create.** `name` is required (stored trimmed, non-blank); `id` is optional and a UUID is
minted when absent. `acceptance` is validated against the four project values and `reviewer`
normalized; the prefix is resolved and checked as described above. The write emits a
`project_created` activity carrying the project, the acceptance and (when set) the reviewer.
The web dialog sends `{name, meta: {prefix}, acceptance, reviewer}` — never an id — and reports
the server's own refusals in the app's words, with the dialog still open.

**Ensure.** `PUT` is the idempotent form: create if the id is absent, otherwise return the
existing row **untouched** — an existing project's name, labels, meta, readme, acceptance and
reviewer are the caller's earlier decisions, not this call's. A race that loses to another
writer is read back as "already existed" rather than surfaced as a conflict.

**Update.** A partial patch; an empty one is refused. `meta` merges, `acceptance` and
`reviewer` are normalized, `meta.prefix` is protected. A missing project is `NOT_FOUND`.

**Read.** `GET /api/v1/projects/:id` answers `{project: null}` for an unknown id rather than
404, so a caller can tell "no such project" from a failed read. `GET /api/v1/projects` returns
the ranked list, and `PUT` / `GET :id` carry the same `task_count` as the list so the two
surfaces cannot disagree. `POST` and `PATCH` do not count tasks, so their `task_count` is
`null` — "not asked for", never a fabricated `0`.

**No removal.** There is no `DELETE`, no cascade and no archive command. Cards reference the
project, so the row is permanent by construction.

## Ordering: the `PROJECTS` list

The authority is [DESIGN.md](../design/DESIGN.md) §20; the implementation is the pure
`src/foundation/project-order.mjs`, and the server is the only computer of the order. The
browser consumes the array as served — re-sorting it would be exactly the client-side rule the
design forbids.

Three factors, each **rank-normalised** so scale cannot drown a small project:

| Factor | Meaning | Weight |
|---|---|---|
| `A7` | activity in the trailing 7 days | 0.5 |
| `A30` | activity in the trailing 30 days | 0.3 |
| `C` | creation recency (newer ranks higher) | 0.2 |

With N participating projects, a value's rank (1 = largest; ties share the best rank) becomes
`s = (N − rank + 1) / N`, and `total = 0.5·A7 + 0.3·A30 + 0.2·C`. Ties resolve by most recent
activity (descending), then project name (ascending).

- **Activity** is the number of `task_activities` rows in the window belonging to a task of the
  project, **excluding pure heartbeats** — a heartbeat bumps the revision but changes no board
  state. Rows with no task (`project_created`, the label GC's own entries) belong to no project
  and count for none.
- **A project with no activity in either window** has `a7 = 0`, `a30 = 0`, `lastActivityAt = null`.
- **`task_count` is not a ranking factor.** It is the project's total task count (every status,
  archived tasks included), computed per request and served with each entry — the sidebar
  badge's number, independent of the order.
- **Archived projects** are excluded from the default list; with `include_archived=1` they are
  fixed to the bottom of the ranking.
- **`order_debug=1`** is the diagnostic escape hatch: off by default, it returns each project's
  raw factors, per-factor rank and score, the total and `last_activity_at`, so an order can be
  reconciled by hand. It is not board state.

## Where the board's responsibility ends: `projects.json`

The one question a project cannot answer on the board is "which local directory does its work
happen in?". That is a **host-local fact**, kept in one `projects.json` per installation at the
config root — `MEERKAT_TASKPANEL_CONFIG_DIR` (resolved against the current directory) when set,
else the program root. It is never sent to
`taskd`, never stored in the database, and two machines may legitimately hold different maps.

The schema, the failure codes and the operating rules are the `meerkat` skill's
([projects-json.md](../skills/meerkat/references/projects-json.md)); the design points are:

- **Two keys may name the directory**, in one order: `dir = local_path ?? run_dir`. `??`, not
  `||`: a key that is *given* but blank is a failure to report, never a reason to fall through
  to the other one. `base_ref` and `merge_ref` are loop-only keys the board never reads.
- **A supplied path is validated**: absolute, exists, and is a directory. Any failure is an
  answer (`PROJECT_DIR_NOT_ABSOLUTE`, `PROJECT_DIR_MISSING`, `PROJECT_DIR_NOT_A_DIRECTORY`),
  never a fallback.
- **Three answers stay distinguishable**: a usable directory; `dir: null` for an entry that
  names no directory (a complete answer for an operations project); `PROJECT_DIR_UNMAPPED` for
  no entry at all — the "stop and ask the user" answer. A wake (`project dir --require-dir`)
  refuses both of the last two, because a worker must start somewhere.
- **No reverse lookup.** `run_dir` can be a generic inbox, so a directory does not resolve to a
  project; that question is for the user.
- **Only `taskctl project map` writes the map.** Writes are atomic (temp file + rename), preserve
  the file's mode and the document's unknown keys, and never overwrite a file they could not
  parse.

## Events

Two events are project-scoped and task-less, and each names its project:

| Event | Writer | Payload |
|---|---|---|
| `project_created` | `createProject` | `project`, `acceptance`, optional `reviewer` |
| `project_updated` | `updateProject`, `readmeSet` | `project`, `fields` (the patched field names) |

Both are **task-less** events: the web board answers any task-less event by reloading projects →
rosters → tasks (debounced), and the loop's subscriber watches them. The full catalogue is
[events.md](events.md).

## Contracts and gates

| Rule | Frozen by | Checked by |
|---|---|---|
| the seven routes, their declared request schemas and the project wire fields | `test/fixtures/contract/api.snapshot.json` | `node scripts/verify/contract.mjs` |
| the `project` CLI group — commands, positionals, flags | `test/fixtures/contract/cli.snapshot.json` | `node scripts/verify/cli-contract.mjs` |
| a route's declared request equals what its handler reads | the handler source | `node scripts/verify/route-request.mjs` |
| the prefix slot ↔ card number binding | [project-prefix-binding.md](../design/contracts/project-prefix-binding.md) | `test/core/commands/project-prefix*.test.mjs`, `test/server/project-prefix-binding.test.mjs` |
| the rail chip is the effective prefix | [side-rail-short-code.md](../design/contracts/side-rail-short-code.md) | `test/web/blocks.contract.mjs`, `web/scripts/rail-chip-overflow.mjs` |
| the ordering algorithm | DESIGN.md §20 | `test/server/project-order.test.mjs` |
| no directory ever reaches the wire | — | `test/server/routes.test.mjs` (asserts no `workspace_path`, and that `current` is no longer a route) |

Two storage-level facts back these: the `projects` table is `STRICT`, with `next_task_number >= 1`
and an `acceptance IN (…)` check; and the revision trigger covers `name, labels, meta_json,
readme, archived_at, updated_at, reviewer, acceptance` — deliberately not `next_task_number`.

## Known edges

Recorded because they are behaviour, not intent:

- `project.labels` is stored and served but read by nothing.
- `archived_at` is honoured by the list and the ranking, but no surface sets it.
- A `PATCH` `name` is stored as sent; only creation trims and refuses a blank name.
- The board does not cap prefix length; the dialog's four-character field is a UI rule, so a
  CLI-created project can carry a longer prefix than the dialog can type.

## What this page does not own

Task lifecycle, claims, heartbeats, delivery and review cards are the
[`meerkat`](../skills/meerkat/SKILL.md) skill's. Who may close a card is
[acceptance.md](acceptance.md). Dispatch and the loop are [scheduling.md](scheduling.md). The
directory map's operating procedure is
[projects-json.md](../skills/meerkat/references/projects-json.md). This page describes the
project as the board stores it and the surfaces that read it.
