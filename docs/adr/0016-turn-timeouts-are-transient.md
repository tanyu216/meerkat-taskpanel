# 0016 — A turn timeout is transient, never an execution hold

- **Status:** Accepted
- **Context:** A handoff turn that exceeded `--session-turn-timeout` was counted
  against the card's attempt budget; three consecutive timeouts parked the card
  `blocked/resource`. The loop could not restart a legitimate long turn without a
  human move, and a skill-opener timeout — an optional prelude, not the card's work —
  spent the same budget. A 30-minute turn also collided with the board's 30-minute
  stale-claim window, so a working agent could be reported stale mid-turn. The owner
  decided: a 60-minute turn, transient retries, and a loop-side heartbeat.
- **Decision:** Treat a handoff-turn timeout (and the clean exit an interrupted turn
  leaves behind) as a **transient** failure with its own counter:
  - the queue row carries `timeouts`, counted apart from `attempts` and `recoveries`;
    the backoff is 2/4/8 minutes;
  - after the third timeout the card is re-read and, still `in_progress`, moved back
    to `todo` with a `note` — a timeout never produces `blocked`;
  - an `awaiting`, `in_review` or delivered card is never moved by the timeout path,
    and an unreadable board leaves the claim to the ordinary stale-claim recovery;
  - a timed-out skill opener reopens a fresh session, skips the opener, and sends the
    card prompt with the `Role skill:` fallback; it spends no attempt;
  - the loop pulses the claimed card's heartbeat as its holder every 5 minutes while
    the turn runs, and stops on the first refusal;
  - `sendDeadlineMs` covers the turn plus the 10-minute opener plus the wedge margin,
    so a legal long tick is not killed by ping.
- **Why:** A timeout is an environment/turn-runner fact, not a card defect. Retrying
  it is safe (the card is re-read before any release), visible (`timeouts` in the
  doctor and `retry_at` in the queue) and bounded (three tries, growing backoff). The
  real execution holds — dispatch failure, an unrestorable worker session, crash
  recovery — keep ADR 0009's meaning; this record only removes the timeout from it.
  The heartbeat exception is the only loop-side board write made for liveness, and it
  stops rather than escalate.
- **Consequences:** A repeatedly timing-out card forms a visible ~3-hour cycle
  (three 60-minute turns plus backoff) instead of a hold; a human can still stop it
  by moving it. Heartbeat writes bump the card `version`, so a worker using
  `--if-version` may need its already-required re-read once more often. The loop
  touches the board during a turn only for `issue heartbeat`; a refusal is logged at
  debug and never changes the turn's outcome.
