# Watch mode: stay on the human queue

A foreground, read-only cadence over the waiting register. It reads; it never writes.

It is not `loop doctor`, not `loop tick` / `loop poll` / `loop run`, not a daemon, not a
scheduler, not a second dispatcher, and not `taskctl export watch` (that refreshes one card's
brief). `events follow` may ensure the local hub on demand; that is the command's own behavior,
not something you manage, stop or restart.

The queue is the console's `questions[]` (awaiting cards plus open agent questions) and
`pending_acceptance[]` (delivered cards). `loop doctor` is not part of the watch: it stays a
one-shot read or an answer to a direct question.

## Enter

Enter on request only: "watch", "keep checking", "notify me when a card needs me".

1. Read the baseline: `taskctl loop console --json`.
2. Then follow live: `taskctl events follow --idle 10000` (no `--after` on the first stream).

Read the baseline first; follow blocks. An event that lands between the two is picked up by the
next tick, so the gap delays a report, it never loses state.

`loop console` is local and needs no identity. `events follow` needs the session's actor
identity (`--actor-kind`, or `TASKCTL_ACTOR_KIND` from the session). It is a read: never pass
`--as-human`. If no identity resolves, skip the event clock, keep reading the console, and say
the watch has no live clock.

## The session

A watch is foreground and belongs to one conversation. Prefer a dedicated session for a long
watch; while it runs, the watch owns the session.

- If the human asks for another task, suspend the watch first: let the tick in flight finish or
  time out, then start no new tick. Do the task, then resume from a fresh console read only if
  they still want the watch. A quick question about the queue is not another task: answer it and
  keep watching.
- Never talk over the human. If their message lands while a tick is in flight, finish the answer
  they are waiting for first; announce the changed set at the turn boundary afterwards. Do not
  prefix, splice or interrupt a reply with an announcement. Answer them first; the announcement
  waits.
- The watch ends with the turn or the session. It never survives as a background process.

## No delegation

Never delegate the watch to a subagent or a background script. A subagent may take one one-shot
read (`taskctl loop console --json` or `taskctl issue get <ref> --json`) and return it, but it
cannot hold the watch: it never receives the human's reply and cannot record it. `events follow`
is not a one-shot read.

Unattended notification is the supervisor's existing path: `loop patrol`, `loop subscribe` and
the SLA detectors, not this skill. Never start one of those, a daemon or a second follower: the
repository forbids a second poller.

## The tick

The tick is one `events follow` call. The console read is the baseline and the periodic safety
read, not part of every tick.

```bash
# baseline; repeat on a signal, the sixth idle tick, ~60 seconds, or a degraded read
taskctl loop console --json
# the tick: one follow per turn, capped at about 30 seconds by the runtime
taskctl events follow --after <rev> --idle 10000
```

- The idle bound must be below the hub's 15-second heartbeat: a larger value (the 45-second
  default, or 60000) never fires, because every heartbeat resets it.
- Give the command a wall-clock cap of about 30 seconds. `events follow` takes no timeout flag;
  use the runtime's command timeout, never a wrapper script. A cap is an idle tick, not a
  failure.
- `event`: debounce one beat, then re-read the console.
- `idle`: count it; re-read at least every sixth idle tick or about every 60 seconds, whichever
  comes first. A capped call counts as an idle tick.
- `shutdown` / `eof`: re-read, then restart with the last `event.id`.
- `error`, no `open`, or an unreachable hub: say the watch is degraded, fall back to the console
  re-read, and do not claim a live stream.

`event.id` is the cursor: pass it as `--after <rev>` on the next follow. If the hub cannot replay
it, the stream starts live; the next console read closes the gap.

## The changed set

Keep the last console snapshot, keyed by the identities below. On each successful read
announce:

- **new**: a key that was not in the snapshot;
- **changed**: a key whose question, reason or round changed;
- **resolved**: a key that left the queue, but only when an invalidation event for that ref, or a
  targeted `taskctl issue get <ref> --json`, confirms it left the waiting state. The console
  read is capped by `--board-limit`, so a bare disappearance is not proof.

Announce each item once, oldest first, with its ref, state and next act. Announce an empty set
once and then stay silent; do not exit because the queue emptied. One card is worked at a time
after the announcement.

**Cost.** Announce only the changed set. Never reprint the whole queue on a tick; a quiet tick
announces nothing. Keep the snapshot to the three keys, not the payloads. Each tick still costs
a tool call, so wait on the clock instead of looping the console.

**A lost snapshot.** The snapshot lives in the conversation, not a state file. After a
compaction, a new session, or any time you cannot see the last snapshot, re-read the console and
announce the current queue once, prefixed with "the watch lost its place". Rebuild the snapshot
from that read. Do not claim a resolution you did not observe, and never add a state file.

## The identities

```text
awaiting:<ref>:<awaiting_reason ?? "-">:<asked_at ?? sha1(question)>
agent-question:<ref>:<asked_at ?? sha1(question)>:<sha1(question)>
acceptance:<ref>:<delivery_round>
```

When `asked_at` is absent, key on the question text itself; do not compute a hash by hand.

- Invalidate on `task_resumed`, `task_delivered` and `report_written`.
- Re-read on `comment_added`, `task_created`, `task_moved` and any status-change event.
- `pending_acceptance[]` carries only `ref`, `title` and `priority`. On first sight of a card,
  read `taskctl issue get <ref> --json` once to learn `acceptance_mode` and `delivery_round`.
  `report_written` and `task_delivered` carry `deliveryRound`; use it to refresh the key instead
  of re-reading every tick.
- When you announce a delivered card, say whose act it is: `human` is the human's; `auto`
  closes on the loop's current-round `APPROVE`; `off` is the deliverer's. Only a `human` card
  waits on them.
- `answered_pending_release: true` means the human already answered and the director owes the
  release. It is not waiting on the human: remove it from the queue, and if it was announced
  before, say once that it no longer waits on them.

## Failures and stop

- A console read with `ok:false` or a non-empty `errors[]` is a failed read: report it, resolve
  nothing, and keep the last good snapshot.
- Three consecutive failed reads: say the watch is degraded and stop claiming it is live.
- Stop when the human says stop or changes topic, or asks for another task. Suspend before
  starting that task; resume from a fresh read only when they still want the watch. A quick
  question about the queue is answered inline and the watch continues.
- The watch is foreground: it ends when the runtime ends the turn or the session. It is not a
  daemon, it must not be backgrounded, and it is never delegated.

## Handoff

The human's reply is §3: show-then-write the exact `--as-human comment add`, plus the requeue
for an `in_progress` agent question. See [`answering.md`](answering.md).

Acceptance is §4: check the current delivery round and `acceptance_mode`, then show the exact
close. See [`acceptance.md`](acceptance.md).

A comment written in the board UI (`comment_added`) is already an answer: re-read, report the
new status, and do not duplicate it. After a write, resume the watch from a fresh read only if
the human still wants it.

## Never

Never write, accept, claim, move, heartbeat, deliver, cancel or comment on your own. Never
delegate the watch to a subagent or a background script, and never start `loop patrol`,
`loop subscribe`, a daemon or a second follower. Never manage, stop or restart a daemon or the
hub. Never run `loop tick` / `loop poll` / `loop run`. Never present a failed or degraded read
as a live queue.

## More

- Payload fields: [`console.md`](console.md).
- The board commands and flags: [`../../meerkat/references/cli.md`](../../meerkat/references/cli.md).
