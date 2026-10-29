# Events: the activity log, the live stream and the local hub

This is a design document, not a command reference. Its subject is how the board tells every
watcher **what changed**, and why the answer is shaped the way it is. The short version: there
is no event bus. Every write leaves an audit row in `task_activities`, and the live stream is a
**cursor over that table**. Everything else — the SSE endpoint, the board's refresh routing, the
human feed, the loop's wake-up path, the local hub and the brief watcher — is a projection of
that one log.

The design stance, in five sentences:

- **The log is the state change's shadow, not a second system.** A command appends its audit row
  in the same transaction as the write it describes, so a committed change always has a row and a
  rolled-back one never does.
- **A revision is the only order.** Each row records the global revision its own insert produced;
  "what is new to me" is therefore `revision > cursor`, a range query with no write-path
  cooperation.
- **Events are signals, not payloads.** A consumer reads the row to learn *that* something
  changed and then reads the authoritative state; no surface is allowed to reconstruct the board
  from `changes` alone.
- **The vocabulary is closed and tested.** A fixed set of event names, with a static contract
  that every writer, every reader and this catalogue name every one of them.
- **Fan-out is local.** The board serves one stream per connected client; local processes share a
  single **event hub** so N consumers do not become N pollers.

## Design at a glance

| Layer | Responsibility | Invariant it upholds |
|---|---|---|
| Activity log | one append-only row per audit-worthy write | a committed state change always leaves a row |
| Revision cursor | `task_activities.revision` | `revision > cursor` is the entire read; no gap, no overlap |
| SSE endpoint | poll the log and push frames | a reconnect from any cursor replays what was missed |
| Board store | route a frame to the smallest refresh | one event costs at most one card read, debounced |
| Activity ledger | backfill once, then follow the same stream | one board-wide read, not one read per card |
| Human feed | admit a fixed set of events | machine bookkeeping never reaches a human's reading |
| Loop subscriber | classify an event as "wake" or "ignore" | a turn is a latency path, never a second dispatch source |
| Local event hub | one board connection per host | consumers share, replay and reconnect locally |
| Card watcher | refresh named brief files on a signal | the file is a projection; the event is never the payload |

## 1. The problem this design answers

A board is watched by two very different readers. A human opens a page and expects a card to move
without reloading; an agent loop wants to know when work becomes actionable. Both need the same
facts, and the board is **local-first**: one SQLite file, Node builtins only, no broker, no
external service, no network dependency.

That rules out the obvious designs:

- **An in-process event emitter.** Writes arrive through several entry points — the HTTP API, the
  CLI, the loop, an in-process test fixture — and some of them share no process with a reader.
  An emitter would have to be wired into every path, and a path that forgot would go silent
  without any test noticing.
- **Hooking the write paths.** Same problem with more surface: every mutating repository method
  would need a publish call, and the hook would be a rule enforced by discipline rather than by
  the database.
- **A WebSocket bus.** The stream is one-way, server to client. SSE gives a browser-native
  `EventSource` with reconnect and `Last-Event-ID` for free, and a plain HTTP response for every
  other client. A bidirectional protocol would add framing, auth and reconnect code for no
  capability the product uses.

The design that survives these constraints is deliberately dull: **write an audit row in the
same transaction, and poll the table.** The database already has to record the audit; the stream
is a read of that record. There is no second delivery mechanism to keep in step, and a write made
by any path — including one that never heard of the stream — is streamed exactly like one made
over HTTP.

## 2. The model

### 2.1 One log, one cursor

`task_activities` is append-only. Each row carries `id`, optional `task_id`, `actor_kind`,
`actor_id`, `event`, `changes_json`, `revision` and `created_at`.

The stream's cursor is the row's **`revision`**, not its `id`. `recordActivity` reads
`global_revision`, adds one, and inserts that number; the insert trigger bumps the counter by
exactly one, so the stored value is the revision the insert itself produced. Activity revisions
are therefore unique and strictly increasing, though **not contiguous**: any other table's write
in between advances the shared counter and leaves a gap.

A client that has seen revision *R* asks for rows with `revision > R`, in ascending revision
order. That is the whole contract. It survives a restart, a reconnect, a slow consumer and a
consumer that was never listening at all; none of them need a session, a subscription table or a
delivery receipt.

### 2.2 The write-path contract

Every command that changes board state appends its activity **inside the same transaction** as
the state write.

The consequences are the point:

- a transaction that rolls back leaves no row, so the log never announces a change that did not
  happen;
- a transaction that commits always leaves a row, so no reader can be told "nothing happened"
  when something did;
- one command may legitimately write several rows — `updateTask` can record an acceptance change,
  an acceptance prune and the patch's own `task_updated` — and each is a separate increment with
  its own order.

A row may be written **before** the state change it describes. The acceptance prune is the named
case: the schema's acceptance-immutability trigger reads the audit row, so the row must exist
first. The design still holds, because the revision is assigned at insert and is strictly
increasing; the row cannot land at or below a caught-up client's cursor.

The reverse failure is the one to guard: a **`global_revision` bump with no `task_activities` row
produces no frame**. Anything a client can observe must be represented by a row. That is why
attachments and sessions write their own events instead of relying on their table's revision
trigger.

### 2.3 Append-only is the cursor's integrity

The schema refuses `UPDATE` and `DELETE` on `task_activities` (`ACTIVITY_APPEND_ONLY`).

This is not tidiness; it is what makes the cursor meaningful. An edit would rewrite history a
client has already received, and the client has no way to know that the row it saw has changed.
A delete would remove a fact the cursor can never replay: a client that had not yet seen the row
would skip past its revision and never learn what happened. A wrong row is corrected by writing
the next row, never by mutating the old one.

### 2.4 Signals, not payloads

`changes_json` is an **audit description**, not a serialised state. It records what the writer
thought was worth saying — `from`/`to`, field names, ids — and consumers use it to choose *what
to re-read*. The board refreshes a card with `GET /tasks/:ref`; the feed derives a sentence from
the row plus the task index; the loop only asks "does this event make work dispatchable?" and
then rescans board state.

Two rules follow, and they are applied consistently:

- **A consumer never trusts `changes` as current state.** The row may name the new value of a
  field, but the row is a historical fact about a write, not a live snapshot.
- **A surface that cannot derive a truthful sentence says less, not something invented.** The
  human feed, for example, shows `Assignee · jobs` from `changes.dictionaries` rather than
  fabricating an `old → new` transition the audit row does not carry.

### 2.5 Unknown names are tolerated, not errors

`ACTIVITY_EVENTS` in `src/core/domain/enums.mjs` is the canonical vocabulary. The write path does
**not** validate against it at runtime; it requires a non-empty string. The guarantee is made by
tests instead (see [§10](#10-how-the-design-is-enforced)).

The runtime tolerance is deliberate. A consumer running against a *newer* board may meet a name
it has never heard of. It must ignore it — never throw, never close the stream, never treat the
board as broken. A throw in the loop's subscriber would kill it and reconnect-loop it against a
working board; a throw in the board store would take down the page. Unknown names take the
consumer's safe path and are logged once.

## 3. Storage

The schema is one baseline file (`0001_init.sql`); there is no pre-0.1.0 history to reason about.
The relevant pieces:

- `task_activities` is `STRICT`, with `event` and `created_at` required and `changes_json`
  defaulting to `'{}'`.
- `revision` is nullable in the schema. A row written through `recordActivity` always fills it.
  A hand-written row with no revision is readable through the per-task route but is **never
  replayed** by the stream — the stream's read is `revision > ?`, and `NULL` satisfies nothing.
- `ix_activities_revision` makes the stream's read an index scan in cursor order.
- `ix_activities_task` serves the per-card trail.
- The `tr_rev_*` triggers bump `global_revision` on every tracked table. The activity trigger is
  how the recorded revision and the post-insert counter agree.
- `tr_activities_no_update` / `tr_activities_no_delete` raise `ACTIVITY_APPEND_ONLY`.

Reads:

- `GET /api/v1/tasks/:ref/activities` — one card's trail, `id` order by default, bounded
  `?after=<revision>` and `?limit=`.
- `GET /api/v1/activities` — the same rows board-wide; the activity ledger's single backfill.
  It carries every project's rows; the client scopes them to its own task set at derivation.
  `?order=desc` with `?limit=` returns the newest N.

## 4. The wire

### 4.1 The endpoint and its frames

`GET /api/v1/events` is an SSE response, behind the board's normal auth like every other route.
A frame is:

```
id: <revision>
data: {"id":…,"task_id":…,"actor_kind":…,"actor_id":…,"event":…,"changes":{…},"revision":…,"created_at":…}

```

The `event:` field is **deliberately absent** on activity frames. A named SSE frame is delivered
only to `addEventListener("<name>")`, and the common browser client is an `onmessage` handler.
The activity's own name travels inside the JSON. `id:` is the revision, so a native `EventSource`
reconnects with `Last-Event-ID` without the client doing anything.

The one **named** frame is `shutdown`, sent when the server is ending the stream on purpose. It
carries no `id:`, so it can never move a cursor past events the client has not seen. A client that
does not listen for it is unaffected; a client that does can tell "`taskd` is restarting" from
"the network broke" and restart its reconnect ladder instead of climbing it.

Two comment lines keep intermediaries and peers honest: `retry: <ms>` tells an `EventSource` how
long to wait before its own retry, and a `: ping` comment goes out every 15 seconds so a dead peer
is noticed even on a quiet board.

### 4.2 Reconnect and replay

`?after=<revision>` or the `Last-Event-ID` header (the query wins) sets the cursor. With neither,
the stream starts at the **current** revision — a live subscription, not a replay of the whole
trail. That is why the board reads `/meta.revision` before it connects: a new page must not
replay every activity the board has ever recorded.

Replay is paged at 500 rows per query and loops until the log is exhausted, yielding to the event
loop between pages so a long catch-up does not block other requests. A page that makes no cursor
progress stops the loop rather than spinning.

A malformed `after` is a `VALIDATION_FAILED` with the offending value in `details`; it is not
silently ignored, because ignoring it would replay from the beginning.

### 4.3 Noise is a projection rule

`task_heartbeat` bumps `revision` and touches `heartbeat_at`, but nothing a board renders changes.
It is filtered out of the stream (`SSE_NOISE_EVENTS`) while **still advancing the cursor**. The
row remains in the log; this is a projection decision, not a storage one.

The same exclusion is reused where a heartbeat would otherwise inflate a human-facing count: the
project activity windows (`a7`/`a30`) join the log and exclude the noise set.

### 4.4 Backpressure and shutdown

The stream writes with `res.write`; a `false` return means the socket buffer is full, so the
stream pauses and resumes on `drain`. Only one flush runs at a time, so the poll timer and an
initial replay cannot interleave frames. Timers are `unref`'d: they never keep a Node process
alive on their own.

A **client-initiated** end writes nothing. A **read failure** closes silently — a `shutdown` frame
would reset the client's backoff and turn a broken board into a hot reconnect loop. A
**server-initiated** stop writes the named `shutdown` frame and then ends the socket. The server
keeps its open streams in a registry and closes them itself on stop, so a graceful `taskd` stop
does not leave half-open connections behind.

### 4.5 Delivery semantics

The stream is **resumable and at-least-once**, not exactly-once:

- a consumer that reconnects from its last revision sees every row after it;
- a consumer that reconnects from an *older* revision may see rows it has already seen;
- a consumer that never records a cursor re-reads from wherever it starts.

Every consumer is therefore written to be **idempotent and signal-shaped**: the board re-reads a
task, the ledger dedupes by activity id, the loop's continue turn rescans, and the watcher
re-exports a whole card. None of them applies an increment to local state on the strength of one
frame.

Ordering is total by revision. Rows within one transaction keep their insert order; the stream
delivers them in that order. There is no causal ordering between separate transactions beyond the
global revision, and no consumer needs one.

## 5. Consumers

The consumers are independent on purpose: the board is a Vue package, the loop is a separate
supervisor process, and the hub is a CLI process. They cannot share a module, so each names its
own decisions and the contract tests keep the decisions exhaustive.

### 5.1 The board store (`web/src/stores/board.js`)

One `EventSource`, started once by `initBoard` after `/meta` seeds the cursor. The client owns its
reconnect: 1 s, doubling, held at 30 s. It **closes the socket itself** before re-opening, because
the browser's built-in retry is a fixed interval that repeats forever. The ladder resets on
`open` and on the server's `shutdown` frame; a `close()` reports `closed`, a waiting reconnect
still reports `connecting`.

Routing is "the smallest refresh that keeps every surface honest":

- **Task-scoped events** refresh the card through `GET /tasks/:ref` (100 ms per-card debounce,
  newest response wins). The same response patches an open drawer's task head, so one event still
  costs one read; a monotonic ticket drops a response that lands after the drawer switched cards.
  `task_created`/`updated`/`claimed`/`moved`/`reopened`/`resumed`/`archived`/`delivered`/
  `report_*`/`epic_auto_start`/`acceptance_*` take this path. An archived card leaves the board.
- **Sub-resource events** refresh only the open drawer's affected tab: `comment_added` → comments;
  `relation_*` → relations, **both endpoints**, because the activity hangs off the target;
  `report_*` → reports and the task; `session_*` → sessions; `attachment_*` → attachments; every
  task-scoped event also refreshes the activity trail.
- **Waiting-queue invalidation**: a comment or status event on an awaiting card drops the cached
  payload and re-runs an in-flight read, so the pre-event answer can never overwrite the new one.
- **Task-less events** (`project_created`, `project_updated`, `label_gc`, `import_completed`)
  reload projects → rosters → tasks on a 250 ms trailing debounce. Task events schedule a 2 s
  trailing reload of project counts/order and the rosters.
- **Unknown names** warn once; a task-scoped one refreshes the card, a task-less one reloads the
  shared lists — never a silent drop.

The board also exposes a manual `resync()`, which reconnects from the current cursor so missed
frames replay without a page reload.

The store also exposes the stream to other stores (`onActivityStream`). That seam is why the
activity ledger has no second connection.

### 5.2 The activity ledger (`web/src/stores/activity.js`)

The ledger backfills with **one** board-wide `GET /activities?limit=1000&order=desc`, instead of
one read per card. The response is board-wide; the feed scopes it to the current project's task
set when it derives rows. Live rows arrive through the board store's stream subscription and are
merged by activity id. A project switch invalidates the read, not a per-card pool. Unread state is
a browser-local `seenAt` cursor, not a server fact.

### 5.3 The human activity feed (`web/src/lib/activity-feed.js`)

The audit trail is machine-shaped: heartbeats, session lifecycle, label GC, acceptance
bookkeeping. The feed is a **human account**, so admission is an allow-list, not a deny-list. A
new event is invisible to the feed until someone adds it, which is the intended direction of
failure.

- Admitted: `task_created`, `task_claimed`, `task_moved`, `task_reopened`, `task_archived`,
  `task_delivered`, `report_written`, `report_waived`, `comment_added`, `relation_added`,
  `relation_removed`, `epic_auto_start`, `attachment_added`, `attachment_removed`, and
  `task_updated` **only** when its `fields` name a human-visible change (`labels`,
  `assigneeId`/`assigneeKind`, `reporterId`/`reporterKind`, `title`, `description`, `priority`,
  `kind`).
- Excluded (`FEED_EXCLUDED_EVENTS`): `task_heartbeat`, `session_*`, `progress`, `label_gc`,
  `project_*`, `attachment_updated`, `import_completed`, `task_resumed`, `acceptance_changed`,
  `acceptance_pruned`, `acceptance_override`.

`task_resumed` is a real status transition and the drawer renders it, but the feed does not
surface the automatic `awaiting → todo` return. That is a named product decision, not a default.
The acceptance/review rows are machine-side bookkeeping. `attachment_updated` is a content
replace, not a new file.

The feed also folds a burst — same actor, same task, same field-edit family, inside five minutes —
into one lighter row, and counts what the reader can see. The drawer's activity tab, by contrast,
shows every event with a localised sentence for the known vocabulary and a generic fallback for an
unknown name.

### 5.4 The loop subscriber (`taskctl loop subscribe`)

Included in every launchd/systemd supervisor; cron cannot host a long-lived process. It consumes
`taskctl events follow` — NDJSON from the local hub — and never speaks the board's HTTP API. Board
discovery, the token and the stream all stay behind `taskctl`. A **live-session (manual) turn**
does not start the subscriber; it checks the board and runs the same control passes itself.

The subscriber turns a **signal** into one continue turn, enqueued for the resident control
session. It never claims, moves or wakes by itself. That is what keeps replay and duplicate frames
harmless: the continue turn rescans board state, the claim CAS decides the winner, and the card
queue plus the subagent ledger are the dispatch authorities.

**Dispatch** (`DISPATCH_EVENTS`): `task_created`, `task_moved`, `task_reopened`, `task_delivered`,
`report_written`, `report_waived`, `relation_added`, `relation_removed`, `import_completed`, plus
`task_updated` only when `fields` intersects `assigneeId`, `assigneeKind`, `kind`, `labels`,
`meta`.

Everything else is named in `IGNORED_EVENTS`. Two entries are worth their reasons:

- `epic_auto_start` is board-authored (`taskd`), which actor suppression already ignores; listing
  it as a dispatch was a contradiction, not a behaviour.
- `task_resumed` is ignored on purpose: the human's `comment_added` already refreshes the brief,
  and the next continue clock picks the returned card up. Whether it should wake a turn
  immediately is a product decision.

A name neither list knows is a newer board and is ignored, never an error.

**Suppression is by actor identity, not by a role word:**

- a `human` event is never suppressed;
- events authored by the board itself (`actor_id = taskd`) are ignored;
- events authored by this loop's own agents (`actor_id ∈ --agent`, non-human) are ignored, which
  covers claims and the workflow pass.

Coalescing: 300 ms debounce, at most 2 s wait, at most one event-triggered continue turn per
minute; a turn refused by the continue lock is retried after 5 s, not dropped.

An event-triggered turn requires a **live resident pool**. With none, poll could not dispatch
anything, so the event path logs and skips and the continue timer remains the patrol and workflow
path. Brief refreshes belong to the hub registrations, not to this process: the subscriber's only
output is a continue turn.

The subscriber keeps its own reconnect ladder for the **local** stream (1 s doubling to 30 s),
resuming with `--after <last revision>`; the hub, not this process, owns the board connection and
its ladder. The process publishes `subscribe.state.json` beside the other loop state, and
`--supervisor=status` reads it to report `streaming`, `reconnecting`, `starting` or `not running`.

### 5.5 The card watcher (`taskctl export watch`)

`export watch` is the consumer for one or more **explicitly named** cards. By default it registers
them with the hub; `--standalone` runs the original direct-SSE watcher. Either way it maps each
`task_id` to the `<dir>/.meerkat/<identifier>/card.md` it exported; an event naming a watched task
marks that card for a refresh, and an event with no `task_id` (a project-level change) refreshes
every watched card. An unknown UUID refreshes nothing.

The refresh is a **full re-render** through `POST /api/v1/export` (`{ref: task_id}`), written
atomically. The event is the signal, never the payload — which is also why a missed frame is
harmless: the next refresh reads the whole current card.

The hub writes the first snapshot before it answers `registered`. That ordering is what lets the
loop register a card's brief **before** it claims the card, and still hold the rule that a claimed
card has a brief.

The UUID map is **board-export sourced**, so it does not follow `review_of`; the export payload
has no review link. The loop therefore registers a review card and its original as two `cards[]`
entries in the same registration, each with its own path. The protocol is
`cards: [{ref, out}, …]`; the CLI's `--out` / `--dir` spellings remain for one card and for a
directory of cards.

Refreshes share the loop's cadence — 300 ms debounce, 2 s maximum wait, a 5 s floor between
batches — and are serial. Per-card failures are reported on the NDJSON stream and keep the
previous file. `done` and `canceled` are terminal: a card that reaches either is written once and
dropped; when the last one is terminal the registration ends and a foreground stream writes
`done`; a card that is already terminal at registration never causes a connection to open.
`--ttl <ms>` bounds a registration (120 minutes by default, `0` disables it) and writes `ttl` when
it expires. The loop's registrations pass `0`, because their ending is the card's terminal state,
not a timer.

`--detach` is the worker form: it registers, prints the handle and exits; the hub keeps the file
fresh, so no client process has to survive the harness turn. The registration is persisted and
resumes after a hub restart. A foreground stream via the hub inherits the hub's transparent
reconnect; the `--standalone` watcher does not reconnect (on `idle`/`shutdown`/`eof`/`done`/`ttl`
it exits 0, and on a stream error it exits 1, resumable with the last `refresh.revision` as
`--after`).

## 6. The local event hub

### 6.1 Why it exists

The board endpoint is a 500 ms poll of the activity table. Each connected client is therefore a
poller, and a host that runs a loop subscriber plus several card watchers would multiply that
load for no benefit: they all want the same rows. The hub owns **one** board connection per board
and fans it out locally.

It is a **fan-out cache, not a message broker**. It does not decide workflow, move cards or wake
agents; it forwards events and writes files. Its local replay ring is bounded, and its fallback
when a cursor is too old is to start live — the consumer's own rescan is the durable recovery.

### 6.2 Identity and lifecycle

The hub is per-user and per-board. Its coordinate is a pointer file in the per-user runtime
directory (`MEERKAT_HUB_DIR`, else `$XDG_RUNTIME_DIR/meerkat-taskpanel`; on Windows
`$LOCALAPPDATA/meerkat-taskpanel/run`; else `~/.meerkat-taskpanel/run`):

```
{version, protocol, key, pid, port, token, log, startedAt}
```

The directory and the pointer are owner-only (`0600`). The key is a hash of the **resolved board
URL plus a token fingerprint** — never the token itself. A rotated token therefore starts, and
finds, a different hub rather than silently reusing a stream authenticated as the old one; a board
that comes back on a different address is likewise a new hub, and a detached registration made for
the old address is not resumed under the new key — it must be registered again.

It is started on demand by `taskctl events follow` or `taskctl export watch`, through a detached
spawn. The token reaches the child in its **environment**, never in `argv`, where `ps` could read
it. An owner lock makes the start a mutex: several workers may notice the absence at once, but one
spawns and the rest poll for the pointer; a lock held by a dead starter is reclaimed. A pointer is
trusted only after an authenticated `ping` answers, so a fossil left by a crash is replaced rather
than used. `taskctl events tail` is the direct diagnostic client; `events follow` is the path
every local consumer takes.

It exits after five idle minutes with no clients and no registrations. A persisted detached
registration keeps it alive, which is the point: the registration outlives the CLI that asked for
it.

### 6.3 One board connection

The hub connects to `/api/v1/events` and reconnects on the loop's ladder — 1 s doubling to 30 s —
resuming from the last revision it saw.

A board restart is **transparent** to local consumers: the hub does not forward the board's
`shutdown` frame. It reconnects and keeps the local streams open. It also re-renders every watch
registration after a reconnect, so a card that changed while the board was away is not left stale.
The gap is covered twice: the board replays from the hub's cursor, and each registration gets one
all-refresh on reopen.

A bounded ring (4 096 frames) lets a reconnecting local follower replay its gap. A cursor older
than the ring starts live rather than pretending to replay. The ring is a latency optimisation;
the correct answer to "I was away too long" is always a state rescan.

### 6.4 The local protocol

Newline-delimited JSON over a loopback TCP socket on `127.0.0.1`, authenticated by the pointer's
token. The socket protocol has a generation number (`HUB_PROTOCOL`); a client with another number
is refused rather than half-understood.

After `hello`, two shapes exist:

- **streams** — `follow` receives the same records `events tail` writes (`open`, `event`, `idle`,
  `shutdown`, `eof`, `error`); `watch` registers explicit refs and receives `open`, `refresh`,
  `done`, `ttl`, `shutdown`, `error`.
- **one-answer requests** — `watch-status`, `watch-stop`, `ping`.

A 15 s `heartbeat` record keeps an idle local stream honest. A session that never says `hello` is
closed after 10 s; a line over 1 MB closes the session. A `follow` request can carry an idle
bound: with no record for that long the hub writes `idle` and ends the session, and `--idle 0`
disables the bound. The subscriber and the direct `events tail` both default it to 45 s.

### 6.5 Registrations: owner, viewer, covered

A registration is a request to keep one or more card files fresh. It has a TTL and a lifetime
tied to the card's terminal state. Three relationship rules keep ownership honest:

- **Owner.** A foreground registration belongs to the session that created it; its disconnect
  ends the watcher. A detached registration has no owner.
- **Viewer.** A second foreground client asking for a card that is already registered becomes a
  viewer: it receives refreshes but cannot retire the registration by disconnecting.
- **Covered.** A review admission usually asks for a card that is already watched: the original's
  brief belongs to the live `ttl_ms: 0` registration made when its own worker was dispatched, and
  `in_review` is not terminal. A per-card `cards[]` request with `detach: true` therefore drops a
  card already covered by a **live detached** registration and registers the rest. If nothing
  remains, the hub creates no registration and answers
  `{type:"registered", registration_id:null, reused:true, running:true, reason:"covered"}`.

A **foreground** registration holding the original still refuses: a foreground watcher ends when
its client disconnects, so it does not promise a fresh brief until the card is terminal. Reuse,
cover and terminal answers are not owned by the caller; only a registration this request created
is unregistered again when its claim is refused.

A registration validates its targets before writing anything: every path is absolute, none is a
directory where a file is meant, and no ref or path is named twice; `cards[]` cannot be combined
with `out`/`dir`, so a path is never derived two ways in one request.

A registration's `refs` narrow to the cards it actually holds, so `findRegistration` by ref cannot
address the wrong registration. Registration itself is serialised through one promise chain:
refs resolve with board reads, and two concurrent `watch` requests could otherwise both pass the
duplicate check before either indexes.

### 6.6 Persistence and recovery

Detached registrations are persisted in the runtime directory (`version: 2`), with their refs,
targets, TTL, creation and expiry, and per-card paths. On start the hub rehydrates them:

- a registration whose card is already terminal is written once and dropped;
- a **permanent** failure (the card no longer exists, the entry is unusable) is dropped;
- a **transient** failure (board restart, network, local write) is deferred and retried on the
  next hub start, not dropped.

`stop()` preserves detached registrations for the next process and finishes every foreground one
with a `shutdown` record. The pointer is removed only if this process still owns it — a newer hub
may have replaced it while this one was stopping.

### 6.7 Trust boundary

The hub binds loopback only, authenticates with a per-process token from an owner-only file, and
never exposes a board token on a command line or in a log line. It is a local IPC surface, not a
second API: it has no write operation on board state, and its only writes to a project directory
are the briefs it was explicitly asked to keep fresh.

## 7. The event catalogue

Every current event, its writer, its task scope, the `changes` it carries, and whether it reaches
the SSE stream. `progress` and `import_completed` are **historical**: their writer (the markdown
importer) is gone; they remain declared so rows it already wrote stay readable, and no surface
should expect a new one.

| Event | Writer | Task scope | `changes` | Reaches SSE |
|---|---|---|---|---|
| `project_created` | `commands/projects.mjs` | none | `project`, `acceptance`, optional `reviewer` | yes |
| `project_updated` | `commands/projects.mjs` (`updateProject`, `readmeSet`) | none | `project`, `fields` | yes |
| `task_created` | `commands/tasks.mjs` | task | `identifier`, `status`, `priority`, `acceptance_mode`, optional `idem`/`dictionaries`/`labels` | yes |
| `task_updated` | `commands/tasks.mjs` | task | `fields` (field **names**), optional `dictionaries`/`labels` | yes |
| `task_claimed` | `commands/tasks.mjs` | task | `from`, `to`, optional `stoleFrom`/`reason` | yes |
| `task_heartbeat` | `commands/tasks.mjs` | task | `heartbeatAt` | **no — noise** |
| `task_moved` | `commands/tasks.mjs` | task | `from`, `to`, `deliveryRound`, optional `awaitingReason`/`blockedReason`/`questionCommentId` | yes |
| `task_reopened` | `commands/tasks.mjs` | task | `from`, `to`, `reason`, `deliveryRound` | yes |
| `task_resumed` | `commands/comments.mjs` | task | `commentId`, `from`, `to` | yes |
| `task_archived` | `commands/tasks.mjs` | task | `from`, `archivedAt`, optional `labelsReleased` | yes |
| `report_written` | `commands/reports.mjs` (core only) | task | `round`, `reportId`, `deliveryRound` | yes |
| `task_delivered` | `commands/reports.mjs`, `commands/rollup.mjs` | task | `from`, `to`, `round`, `reportId`, optional `rollup`/`canceled`/`source` | yes |
| `report_waived` | `commands/reports.mjs`, `commands/tasks.mjs` | task | `from`, `to`, `round`, `reason`, `deliveryRound` | yes |
| `acceptance_changed` | `commands/tasks.mjs` (`updateTask`) | task | `added`, `revision` | yes |
| `acceptance_pruned` | `commands/tasks.mjs` (`updateTask`, before the state write) | task | `reason`, `removed` | yes |
| `acceptance_override` | `commands/tasks.mjs` (`updateTask`) | task | `from`, `to`, optional `reason` | yes |
| `epic_auto_start` | `commands/rollup.mjs` | task | `from`, `to`, `child`, `source` | yes |
| `comment_added` | `commands/comments.mjs`, `commands/rollup.mjs` | task | `commentId`, `kind` | yes |
| `relation_added` | `commands/relations.mjs` | **target** | `relationId`, `type`, `source`, `target` | yes |
| `relation_removed` | `commands/relations.mjs` | **target** | `relationId`, `type`, `source`, `target` | yes |
| `label_gc` | `commands/labels.mjs` | none | `archived`, `kept`, `mismatched`, `reason`, `ttlDays` | yes |
| `session_registered` | `commands/agent-sessions.mjs` | task | `sessionId`, `seg`, `ownerKind`, `phase` | yes |
| `session_closed` | `commands/agent-sessions.mjs` | task | `sessionId`, `status` | yes |
| `progress` | historical import | task | `line`, `seq` | yes |
| `attachment_added` | `commands/attachments.mjs` | task | `attachmentId`, `filename`, `content_type`, `size` | yes |
| `attachment_updated` | `commands/attachments.mjs` (content PUT) | task | same, with the new `size` | yes |
| `attachment_removed` | `commands/attachments.mjs` | task | same | yes |
| `import_completed` | historical import | none | counters (`cards`, `tasks`, …) | yes |

Notes that the table cannot carry:

- `task_heartbeat` is the only **wire noise**. Its row still advances the cursor like any other;
  only the frame is suppressed.
- `progress` has no renderer on the card. The markdown brief no longer has a `## Progress`
  section — its only writer was the removed importer — and the card file is not the trail. The
  rows remain readable through the activity routes.
- `import_completed` is what a historical importer wrote at the end of a whole-directory import.
  The loop still classifies it as a dispatch (an import is work to discover) for boards that carry
  such rows; `taskd`/`md-import` authorship is what lets it through the board-write suppression.
- A `task_updated` row carries the patched **field names** plus the new dictionary/label values
  it resolved; it is not a diff of the patched fields. Consumers that need the old value read the
  state, not the row.
- A relation's activity hangs off the **target**, so a reader that wants the source card refreshed
  must do so explicitly. The board store does; that is why both endpoints refresh.

## 8. What is *not* an event

These change server state or operational reality but have no activity row, by design:

- **Migrations** run at startup, before any client is connected.
- **Access policy and token rotation** are files, not board state; the Access panel re-reads on
  open.
- **Time-based conditions** — stale claim, heartbeat age, review aging, SLA tiers — are thresholds,
  not discrete writes. They stay on the continue/patrol clock; an event-driven design cannot
  replace that clock, because nothing fires at the moment a threshold is crossed.
- **Dictionary and label counters** (`use_count`, `last_seen_at`) move with the task event that
  named them; they are not rows of their own. The rosters reload on a trailing debounce.
- **An idempotent create's reuse, a same-actor re-claim, and a no-op review change** are not new
  facts and write nothing.

Two names were declared once and never written — `dictionary_upsert` and `anomaly`. They are no
longer part of the vocabulary. Dictionary growth is reflected by the `dictionaries`/`labels`
fields a task event already carries; there is no separate dictionary event to subscribe to.

## 9. Actor identity

`actor_kind` is an **open string** at the schema level. The only value with built-in meaning is
`human`. The board's own writes use the concrete platform name `taskd`. An actor kind otherwise
names the platform it runs on (`claude`, `codex`, `pi`, …).

Two words are deliberately **not** kinds we write: `system` names no platform, and `agent` names a
category ("not the human") rather than a writer. `test/contract/actor-kind.test.mjs` scans source
for them. Historical rows that carried either are kept as recorded; the UI classifies by kind and
the loop by id, so such a row simply reads as a non-human writer rather than breaking a surface.

This matters to the stream because suppression is by actor, not by a role word:

- the loop ignores its own agents' writes and the board's housekeeping by `actor_id`;
- a human's write is never suppressed;
- an unknown actor kind is still a valid actor: it simply is not `human` and not `taskd`.

## 10. How the design is enforced

The write path does not validate the vocabulary at runtime, so the guarantees have to live
somewhere durable. They live in three static contracts and one schema:

- **`test/contract/activity-events.test.mjs`** — every `activities.append({ event: "…" })` in
  `src/` names a declared event; every declared event has a writer (except the historical pair);
  a historical event gains no new writer; and every mutating repository call in
  `src/core/commands/` sits in a function that appends an activity. The helpers that hand their
  audit to the caller (`resolveOrCreate`, `resolveActorId`, `resolveLabels`,
  `insertDeliveryReport`) are a named exemption table that fails when it goes stale. Repository
  methods are classified as read or write by hand, so a new method cannot silently escape the
  pairing check.
- **`test/contract/activity-consumers.test.mjs`** — every declared event is an explicit decision
  at each reader: the board's known-event set and refresh routing, the human feed's admit/exclude
  lists, the loop's dispatch/ignore lists, the wire noise filter, and **this document**. It parses
  the catalogue table above, so an event missing from it is a red test and a row naming a
  non-event is a red test too.
- **`test/contract/actor-kind.test.mjs`** — source writes never spell a vague role word.
- **The schema** — append-only triggers, the revision trigger, and the acceptance-immutability
  trigger that reads the audit row. An app-layer-only rule would be walked past by a raw writer;
  the database is where an invariant that must hold for every writer lives.

The API and CLI snapshots do not freeze event names (the wire field is a string), but they do
freeze the routes and commands that expose the log and the stream. A change to
`GET /api/v1/events`, the activity routes or the `events`/`export watch` CLI surface updates
`test/fixtures/contract/api.snapshot.json` or `cli.snapshot.json` in the usual way.

## 11. Decisions and costs

| Decision | Why | What it costs |
|---|---|---|
| Poll a table instead of publishing | any writer is visible, with no cooperation and no second system | up to 500 ms added latency, and a query per connection per poll |
| Assign the revision at insert | a cursor that survives reconnects with no subscription state | gaps in the revision sequence; a consumer must not assume +1 |
| Append-only, schema-enforced | a cursor can always replay; no client sees history rewritten | corrections are new rows; the table only grows |
| Signal, not payload | correctness under replay and partial rows | one authoritative read per event (debounced at every consumer) |
| Closed vocabulary + static readers | no event can be silently forgotten by a consumer | adding an event means editing every reader and this page |
| Allow-list human feed | machine bookkeeping never reaches a human | a genuinely human-relevant new event is invisible until admitted |
| Suppression by actor id | the loop does not wake itself on its own writes | an agent's write that another agent needs still never wakes the loop |
| Socket in `node:net`, NDJSON | zero dependencies; debuggable with `nc`; one protocol for streams and requests | hand-rolled framing, auth and backpressure; a 1 MB line cap |
| Per-board hub keyed by URL + token fingerprint | one connection per host, and a rotated token cannot reuse a stale authenticated stream | an extra process and a pointer/lock lifecycle; a new address needs a new registration |
| Bounded replay ring, live fallback | bounded memory; no pretend-replay | a local consumer away too long gets latency, not history |
| Time conditions stay on the clock | thresholds have no write to hang an event on | the loop must still poll; the event stream is latency, not liveness |

## 12. Extending the vocabulary

Adding an event is a cross-cutting change, not a one-line enum edit. The order that keeps the
contract tests meaningful:

1. **Declare** the name in `ACTIVITY_EVENTS` (`src/core/domain/enums.mjs`).
2. **Write** it through `activities.append` in the same transaction as the state change, with an
   `actorKind`/`actorId` and a `changes` object that says what happened — never a bare revision
   tick.
3. **Decide** at every reader: the board's known-event set (and whether it refreshes the task or
   a sub-resource), the human feed (admit with a kind/group or exclude with a reason), the loop
   (dispatch or ignore, with a reason), and the wire noise filter if the event is machine-only.
4. **Document** it as a row in [§7](#7-the-event-catalogue). The consumer contract parses the
   table, so this is not optional prose.
5. **Test** the behaviour, not just the vocabulary: a new event should have a test that proves
   the consumer's smallest correct refresh, and — where the rule is an invariant — a DB-level
   trigger and a `test/contract/` test against it.
6. **Update the snapshots** only if the surface changed (a route, a CLI flag, a wire field). The
   event name itself is not a frozen field.

A historical event is different: it stays declared, gains no writer, and is covered by
`HISTORICAL_ACTIVITY_EVENTS` so a second writer cannot appear.

## 13. Known edges and non-goals

- **No exactly-once delivery.** Replay is at-least-once by design. Every consumer is idempotent;
  a consumer that is not would be a bug in that consumer, not in the stream.
- **No durable local queue.** The hub's ring is bounded, and the hub is not a broker. The durable
  answer to "what did I miss" is always a board rescan, never a hub replay guarantee.
- **No per-consumer filtering on the board SSE.** Every connected client receives every row
  (minus wire noise). Filtering is a client-side projection — the feed's allow-list, the loop's
  classifier — not a server subscription language.
- **No event schema versioning.** A row is `event` + `changes`; there is no version field. New
  information is a new key (tolerated by consumers) or a new event name (classified explicitly).
- **No cross-board stream.** One board, one log. The hub is scoped to one resolved board URL.
- **No retention policy in this design.** The log is the audit trail and the stream's source; it
  grows with the board. Compaction, if it ever exists, must preserve the append-only cursor
  contract or be a separate archival surface.
- **The event path is latency, not liveness.** Nothing in this design notices a threshold being
  crossed. Stale claims, aging reviews and SLA tiers are the patrol's job; the stream only tells a
  consumer that a write already happened.
