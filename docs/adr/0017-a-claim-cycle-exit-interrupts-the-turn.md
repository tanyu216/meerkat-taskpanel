# 0017 — Leaving the claim cycle interrupts the turn and the next claim is fresh

- **Status:** Proposed
- **Context:** The resident pool keeps one worker/reviewer conversation per card and resumes it
  by id. A card could leave the work while its turn was still running — the director released
  it (`in_progress → todo`), a human answered an `awaiting` question, a person canceled it, the
  loop canceled a review card, a timeout released it after three tries. None of those stopped
  the turn: the pulse's refusal only stopped the heartbeat timer, and the turn ran to the
  provider/timeout bound (ADR 0016). The next dispatch then resumed the same conversation, so a
  released card could keep executing against a claim it no longer held, and an answered
  question could be answered again from stale context.
- **Decision:** One predicate, `leavesClaimCycle(from, to) = holdsClaim(from) && !holdsClaim(to)`,
  where the claim-holding statuses are `in_progress`, `awaiting`, `in_review`, `blocked`. On any
  move it matches:
  - the pool interrupts the live turn through the adapter's own `interrupt()` and then a
    **bounded** `close()`; it never signals a pid or a shared process (Codex's app-server is
    shared by every thread);
  - the queue row becomes `interrupted`, a terminal state that spends no attempt, timeout or
    recovery;
  - the worker session record **and** its replay transcript are deleted, so the next
    `planWorkerOpen` returns `fresh`;
  - the writers are cross-process: the subscriber, the workflow pass and a refused card pulse
    write `stateDir/interrupts/<target>.json`; the pool consumes the directory on its own 1 s
    clock. Matching is `task_id` first, then the card identifier, and requires
    `row.enqueuedAt <= request.requestedAt`, so a handoff enqueued after the move is a new
    attempt and is never killed by a stale tombstone;
  - the board remains the only card authority: the markers are requests, every step is
    retryable, and a queue-write failure keeps the marker for the next tick.
  - `in_progress → backlog` and `in_review → canceled` join the whitelist so the exit does not
    have to pass through another claimed status; `in_review → canceled` is terminal and does
    not bump the delivery round.
- **Why:** The claim is a lock on one attempt. Once the lock is released, the turn is executing
  against a fact the board no longer holds. Interrupting it is the honest state; deleting the
  conversation is what makes "the next claim is a new attempt" true rather than decorative. The
  file channel keeps the pool's process boundary (it never talks to the board) and survives a
  restart; the adapter seam avoids the one thing that cannot be made safe — killing a shared
  Codex process.
- **Consequences:**
  - **Partial supersession.** This record replaces the "a released card resumes the same
    session" half of ADR 0006 (first-class worker sessions) and ADR 0008 (a worker holds for
    the ladder), and the "a refused pulse never changes the turn's outcome" sentence of ADR
    0016. Rework, unblock and crash recovery still resume inside the claim.
  - A released or answered worker starts over from the card and the comments; context that was
    only in the old conversation is gone (the replay transcript is deleted, not replayed).
  - An `awaiting → todo` answer is read by a new worker; the board's answer text is the
    durable record, and the new worker must judge completeness from it.
  - The terminal moves out of the cycle (`in_review → done`, an `off` card's
    `in_progress → done`) also match. That is benign: there is no live turn, and the effect is
    forgetting a finished session. `interrupted` is therefore terminal on the queue, not a
    claim that work failed.
  - A marker with no matching row (the handoff row was already pruned) cannot name the
    session to forget; the refused-pulse backstop covers the case while a pool is live, and a
    stopped pool has no turn. Recorded as a known edge, not solved with a schema change.
  - Without any writer (no subscriber, no workflow pass, no pulse) a same-round resume is still
    possible. A claim generation column would close that, at the cost of a schema change; this
    record accepts the edge.
  - Codex can only soft-interrupt once a turn id exists; before that, the bounded `close()`
    after settlement is the only lever. The shared process is never signaled.
  - The review-card cascade is loop timing, not instant: the original's cancel is immediate,
    the review card is canceled on the next workflow pass (seconds with a subscriber, up to
    600 s without one), and its verdict is void once the review card is canceled.
