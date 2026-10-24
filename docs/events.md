# Events, the live stream, and what each surface does with them

The board has one live channel: `GET /api/v1/events`, a **cursor over
`task_activities`**. It is not an event bus and it does not hook the write paths. Every
command appends its audit row inside the same transaction as the state write, and the
stream polls that table (500 ms) and pushes rows newer than the client's revision. A
`global_revision` bump with no `task_activities` row produces **no frame**.

This document is the event catalogue: who writes each event, what it carries, which
consumer reads it, and which events are deliberately excluded from a surface.

## The vocabulary

`ACTIVITY_EVENTS` in `src/core/domain/enums.mjs` is the canonical list. Two rules are
enforced by `test/contract/activity-events.test.mjs`:

- every `activities.append({ event: "…" })` in `src/` names a declared event;
- every declared event has at least one writer (no dead vocabulary).

| Event | Writer | Task scope | `changes` | Reaches SSE |
|---|---|---|---|---|
| `project_created` | `commands/projects.mjs` | none | `project` | yes |
| `project_updated` | `commands/projects.mjs` (`updateProject`, `readmeSet`) | none | `project`, `fields` | yes |
| `task_created` | `commands/tasks.mjs` | task | `identifier`, `status`, `priority`, optional `idem`/`dictionaries`/`labels` | yes |
| `task_updated` | `commands/tasks.mjs` | task | `fields` (field **names**), optional `dictionaries`/`labels` | yes |
| `task_claimed` | `commands/tasks.mjs` | task | `from`, `to`, optional `stoleFrom`/`reason` | yes |
| `task_heartbeat` | `commands/tasks.mjs` | task | `heartbeatAt` | **no — noise** |
| `task_moved` | `commands/tasks.mjs` | task | `from`, `to`, `deliveryRound`, optional `awaitingReason`/`blockedReason` | yes |
| `task_archived` | `commands/tasks.mjs` | task | `from`, `archivedAt`, optional `labelsReleased` | yes |
| `report_written` | `commands/reports.mjs` (core only) | task | `round`, `reportId`, `deliveryRound` | yes |
| `task_delivered` | `commands/reports.mjs`, `commands/rollup.mjs` | task | `from`, `to`, `round`, `reportId`, optional `rollup`/`canceled`/`source` | yes |
| `report_waived` | `commands/reports.mjs`, `commands/tasks.mjs` | task | `from`, `to`, `round`, `reason`, `deliveryRound` | yes |
| `epic_auto_start` | `commands/rollup.mjs` | task | `from`, `to`, `child`, `source` | yes |
| `comment_added` | `commands/comments.mjs`, `commands/rollup.mjs` | task | `commentId`, `kind` | yes |
| `relation_added` | `commands/relations.mjs` | **target** | `relationId`, `type`, `source`, `target` | yes |
| `relation_removed` | `commands/relations.mjs` | **target** | `relationId`, `type`, `source`, `target` | yes |
| `label_gc` | `commands/labels.mjs` | none | `archived`, `kept`, `mismatched`, `reason`, `ttlDays` | yes |
| `session_registered` | `commands/agent-sessions.mjs` | task | `sessionId`, `seg`, `ownerKind`, `phase` | yes |
| `session_closed` | `commands/agent-sessions.mjs` | task | `sessionId`, `status` | yes |
| `progress` | historical import | task | `line`, `seq` | yes |
| `attachment_added` | `server/routes/attachments.mjs` | task | `attachmentId`, `filename`, `content_type`, `size` | yes |
| `attachment_updated` | `server/routes/attachments.mjs` (content PUT) | task | same, with the new `size` | yes |
| `attachment_removed` | `server/routes/attachments.mjs` | task | same | yes |
| `import_completed` | historical import | none | counters (`cards`, `tasks`, …) | yes |

`task_heartbeat` is the only **wire noise**: it changes nothing a board renders, so
`SSE_NOISE_EVENTS` filters it. Its cursor still advances, like every other row.

The markdown card no longer renders a `## Progress` section: its only writer was the removed
importer, so a fresh card always had an empty one. The `progress` rows that exist remain
readable through the activity route; the card file is not the trail.

## Consumers

### The board store (`web/src/stores/board.js`)

One `EventSource`, started once by `initBoard`. `initBoard` reads `/meta` first and seeds
the cursor with `revision`, so the first connection is live rather than a replay of the
whole audit trail.

- **Task events** refresh the card. `task_created`/`updated`/`claimed`/`moved`/`archived`/
  `delivered`/`report_*`/`epic_auto_start` cost a `GET /tasks/:ref` (100 ms per-card
  debounce, newest response wins). An archived card is removed from the board.
- **Sub-resource events** refresh only the open drawer's affected tab:
  `comment_added` → comments; `relation_*` → relations (both endpoints, because the
  activity hangs off the target); `report_written`/`task_delivered`/`report_waived` →
  reports and the task; `session_*` → sessions; `attachment_*` → attachments; every
  task-scoped event also refreshes the drawer's activity trail. A monotonic ticket drops
  a response that lands after the drawer switched cards.
- **Waiting queue**: a `comment_added`/`task_*`/`report_waived` on an awaiting card
  invalidates its cached payload (the human comment that set `since`); an in-flight
  read is re-run, never allowed to write the pre-event answer.
- **Task-less events** (`project_created`, `project_updated`, `label_gc`,
  `import_completed`, and any unknown name) reload projects → rosters → tasks with a
  250 ms debounce. Task events schedule a 2 s trailing reload of project counts/order and
  the actor/label rosters.
- An unknown event name is logged once (`console.warn`) and takes the safe refresh path.

### The human activity feed (`web/src/lib/activity-feed.js`)

A strict allow-list, because the feed is a *human* account, not a raw log:

- admitted: `task_created`, `task_claimed`, `task_moved`, `task_archived`,
  `task_delivered`, `report_written`, `report_waived`, `comment_added`,
  `relation_added`, `relation_removed`, `epic_auto_start`, `attachment_added`,
  `attachment_removed`, and `task_updated` only for `labels`/`assigneeId`/`assigneeKind`/
  `reporterId`/`reporterKind`/`title`/`description`/`priority`/`kind`;
- excluded: `task_heartbeat`, `session_*`, `progress`, `label_gc`, `project_*`,
  `attachment_updated`, `import_completed`.

The drawer's activity tab shows every event, with a localised sentence for the known
vocabulary and a generic “recorded an event” fallback for an unknown one.

### The local event hub (`taskctl events hub`)

Every local consumer that needs the board's stream shares **one** connection: the hub. It is
a per-user, per-board process that binds `127.0.0.1`, publishes a 0600 pointer file
(`{pid, port, token, log}`) in the per-user runtime directory (`MEERKAT_HUB_DIR`, else
`$XDG_RUNTIME_DIR/meerkat-taskpanel`), and authenticates local clients with a token from that
file. It is started on demand by `taskctl events follow` or `taskctl export watch` with a
detached spawn (a new session), so it outlives the command — and the harness turn — that
started it. It exits after five idle minutes with no clients and no registrations.

The hub reconnects to the board with the loop's 1 s→30 s ladder, resuming from the last
revision it saw. A bounded ring of recent events lets a reconnecting follower replay the gap;
a cursor older than the ring starts live (the loop's rescan is the fallback). A board restart
is **transparent** to local consumers: the hub does not forward the board's `shutdown` frame;
it reconnects and keeps the local streams open. It also re-renders every watch registration
after a reconnect, so a card changed while the board was away is not left stale.

Local protocol: newline-delimited JSON over the loopback socket. `follow` receives the same
records `events tail` writes (`open`, `event`, `idle`, `shutdown`, `eof`, `error`); `watch`
registers explicit refs and receives `open`, `refresh`, `done`, `ttl`, `shutdown`, `error`.
`watch-status` and `watch-stop` are one-answer requests. Detached registrations are persisted
in the runtime directory and resume when a new hub starts. The hub's key is the **resolved
board URL** (plus a token fingerprint): if taskd comes back on a different address, the next
client starts a new hub, and a detached registration for the old address must be created
again.

### The loop subscriber (`scripts/loop/subscribe.mjs`)

Optional, launchd/systemd only. It consumes `taskctl events follow` (NDJSON from the hub) and
turns a **signal** into one continue turn (enqueued for the resident control session when a
pool is live, a one-shot turn otherwise); it never claims, moves or wakes by itself. That
keeps replay and duplicate frames harmless — the continue turn rescans board state, the claim
CAS decides the winner, and the card queue plus the subagent ledger are the dispatch
authorities. The local `streamCli` reconnect ladder remains; it now guards the hub connection
rather than a board connection.

Dispatch whitelist: `task_created`, `task_updated` (only when `fields` intersects
`assigneeId`, `assigneeKind`, `kind`, `labels`, `meta`), `task_moved`, `task_delivered`,
`report_written`, `report_waived`, `epic_auto_start`, `relation_added`,
`relation_removed`, `import_completed`.

Suppression is by **actor identity**, not by a role word:

- a `human` event is never suppressed;
- events authored by the board itself (`actor_id = taskd`) are ignored;
- events authored by this loop's own agents (`actor_id ∈ --agent`, non-human) are ignored,
  which covers claims and the workflow pass.

`import_completed` (a historical import's row) is authored by `taskd`/`md-import`, so it
passes and wakes the loop.

Coalescing: 300 ms debounce, at most 2 s wait, at most one event-triggered continue turn
per minute; a turn refused by the continue lock is retried after 5 s.

### The card watcher (`taskctl export watch`)

`export watch` is the consumer for one or more **explicitly named** cards. By default it
registers them with the hub; `--standalone` runs the original direct-SSE watcher. Either way
it maps each `task_id` (UUID) to the `<dir>/.meerkat/<identifier>/card.md` it exported; an
event naming a watched task marks that card for a refresh, and an event with no `task_id` (a
project-level change) refreshes every watched card. An unknown UUID refreshes nothing. The
refresh is a full re-render through `POST /api/v1/export` (`{ref: task_id}`), written
atomically — the event is the signal, never the payload.

It shares the loop's cadence — 300 ms debounce, 2 s maximum wait, `CARD_REFRESH_MIN_MS`
(5 s) between batches — and refreshes are serial. Per-card failures are reported in the
NDJSON stream and keep the previous file. `done` is terminal: a card that reaches it is
written once and dropped; when the last one is done the registration ends and a foreground
stream writes `done`; a card that is already done at registration never causes a connection
to open. `--ttl <ms>` bounds a registration (120 minutes by default, `0` disables it) and
writes `ttl` when it expires.

`--detach` is the worker form: it registers, prints the handle and exits; the hub keeps the
file fresh, so no client process has to survive the harness. The registration is persisted
and resumes after a hub restart. A foreground stream via the hub inherits the hub's
transparent reconnect; the `--standalone` watcher does not reconnect (on
`idle`/`shutdown`/`eof`/`done`/`ttl` it exits 0, and on a stream error it exits 1, resumable
with the last `refresh.revision` as `--after`).

## What is *not* an event

These change server state but have no activity row, by design:

- **migrations** run at startup, before any client is connected.
- **access policy and token rotation** are files, not board state; the Access panel
  re-reads on open.
- **time-based conditions** (stale claim, heartbeat age, review aging, SLA tiers) are
  thresholds, not discrete writes. They stay on the continue/patrol clock; an event-driven
  design cannot replace that clock.

`dictionary_upsert` and `anomaly` were declared but never written; they are no longer part
of the vocabulary. Actor/label dictionary growth is reflected by the `dictionaries`/
`labels` fields a task event already carries, and the store reloads the rosters on a
trailing debounce.

## Actor kinds

`actor_kind` is an **open string**. The only value with built-in meaning is `human`; the
board's own writes use the concrete platform name `taskd` (`BOARD_ACTOR`). An actor kind names
itself (`claude`, `codex`, `pi`, `opencode`, …). `system` and `agent` are not kinds we
write: `test/contract/actor-kind.test.mjs` scans source for them. Historical rows that
carried `system` are kept as recorded; consumers classify by actor **id**, so they still
work.
