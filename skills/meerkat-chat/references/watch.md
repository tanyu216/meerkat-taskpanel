# Watch mode: stay on the human queue

A read-only wait on the board's event clock over the waiting register. It reads; it never writes.

It is not `loop doctor`, not `loop tick` / `loop poll` / `loop run`, not a daemon, not a
scheduler, not a second dispatcher, and not `taskctl export watch` (that refreshes one card's
brief). `events follow` may ensure the local hub on demand; that is the command's own behavior,
not something you manage, stop or restart.

The queue is the console's `questions[]` (awaiting cards, open agent questions, and blocked
`decision` holds) and `pending_acceptance[]` (delivered cards). `loop doctor` is not part of the
watch: it stays a one-shot read or an answer to a direct question.

## Enter

Enter on request only: "watch", "keep checking", "notify me when a card needs me".

1. Read the baseline: `taskctl loop console --json`.
2. Then start the hold: `taskctl events follow --hold 600000 --event …` (no `--after` on the
   first hold).

Read the baseline first; the hold blocks until a matching event or the bound. An event that lands
between the two is picked up by the next hold, so the gap delays a report, it never loses state.

`loop console` is local and needs no identity. `events follow` needs the session's actor
identity (`--actor-kind`, or `TASKCTL_ACTOR_KIND` from the session). It is a read: never pass
`--as-human`. If no identity resolves, skip the event clock, keep reading the console, and say
the watch has no live clock.

## The session

A watch belongs to one conversation. Prefer a dedicated session for a long watch; while it runs,
the watch owns the session.

- **One hold at a time.** Run the hold in the runtime's background execution when it has one, so
  the conversation stays live; otherwise run it in the foreground — it bounds itself. Never start
  a second hold while one is running: that is a second follower.
- If the human asks for another task, suspend the watch first: stop the hold, do the task, then
  resume from a fresh console read only if they still want the watch. A quick question about the
  queue is not another task: answer it and keep watching.
- Never talk over the human. A hold may be running while their message lands: answer them first;
  announce the changed set at the turn boundary afterwards. Do not prefix, splice or interrupt a
  reply with an announcement.
- Stopping the watch stops the running hold. A hold never outlives the watch it belongs to.

## No delegation

Never delegate the watch to a subagent or a background script. A subagent may take one one-shot
read (`taskctl loop console --json` or `taskctl issue get <ref> --json`) and return it, but it
cannot hold the watch: it never receives the human's reply and cannot record it. `events follow`
is not a one-shot read.

Running **one** `events follow --hold` in the runtime's background execution is not delegation:
it is the same single follower, it ends by itself, and its output comes back to this
conversation. What is forbidden is a second follower: a script, a daemon, `loop patrol`,
`loop subscribe`, the SLA detectors. Never start one of those, and never start a second hold
while another is running.

## The hold

One wait is one command. The console read is the baseline and the safety read, never part of the
hold.

```bash
# baseline; repeat after every hold and after a degraded read
taskctl loop console --json
# one hold: the first matching event ends it, or ten minutes with none
taskctl events follow --after <rev> --hold 600000 \
  --event task_moved:changes.to=awaiting \
  --event comment_added:changes.kind=question \
  --event task_delivered
```

- `--hold` is a one-shot wait, not a silence bound: the first emitted event ends the command, or
  the bound does. It starts at `open`, so hub start-up is not charged to it. `--idle` cannot
  express this: the hub's 15-second heartbeat resets its clock, so any value at or above 15
  seconds never fires.
- `--event` is a client-side filter and repeated flags OR together. The three above are the
  whole "waiting on you" set: `task_moved` to `awaiting` parks a card on the human's rung;
  `comment_added` with `kind=question` is a worker that stopped to ask; `task_delivered` is a
  delivery, which the filter cannot classify further.
- `event`: read the console, announce the changed set, then start the next hold with
  `--after <event.id>`. On a `task_delivered` record, read the card's `acceptance_mode` before
  calling it the human's.
- `idle`: the bound passed with no matching event. Read the console (the safety read), announce
  the changed set if any, then start the next hold.
- `shutdown` / `eof`: re-read, then restart with the last `event.id`.
- `error`, no `open`, or an unreachable hub: say the watch is degraded, fall back to the console
  re-read, and do not claim a live stream.
- A hold the runtime killed early is a tick, not a failure: re-read and start the next one.

`event.id` is the cursor: pass it as `--after <rev>` on the next hold. If the hub cannot replay
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

**Cost.** Announce only the changed set. Never reprint the whole queue; a quiet hold announces
nothing. Keep the snapshot to the three keys, not the payloads. Each hold costs one command, so
wait on the clock instead of looping the console.

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
  of re-reading every hold.
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
- The watch ends when the human says stop or the session ends. Stopping it stops the running
  hold. It is not a daemon and it is never delegated.

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
`loop subscribe`, a daemon or a second follower. Never run two holds at once. Never manage, stop
or restart a daemon or the hub. Never run `loop tick` / `loop poll` / `loop run`. Never present a
failed or degraded read as a live queue.

## More

- Payload fields: [`console.md`](console.md).
- The board commands and flags: [`../../meerkat/references/cli.md`](../../meerkat/references/cli.md).
