# 0008 — A worker holds for the ladder; the director settles by releasing

## Status

Accepted — 2026-11-01.

## Context

ADR 0006 gave every card its own worker session, resumed by id in the same round. That made
continuity possible, but a worker that asked a question still **ended its turn** and was
re-dispatched only when the next `poll` ran. The question lane rode the 10-minute continue
clock, `comment_added` and `task_resumed` were in `IGNORED_EVENTS`, and the director's own
release was suppressed as an own write — so each leg of a question round trip could take ten
minutes, and a round could take twenty to thirty. Worse, `routeQuestions` treated the
director turn's exit code as proof of settlement: a `note` without the release completed the
row, the question never came back, and the worker was never resumed.

The requirement is the ladder's: a worker holds while the **director** can decide; when the
director escalates to a **human**, the worker stops and the same session resumes after the
human answers. Nothing may silently park.

## Decision

- **The settle is the release, not the prose.** A question is open while the card is
  `in_progress` and `status_changed_at` does not follow `question.created_at`.
  `releasedAfterQuestion` / `questionOpen` / `classifyQuestionOutcome` live in
  `src/foundation/question-settle.mjs` (the orchestrator may import only foundation) and are
  shared by the question lane, the director verification, the console, the SLA and the CLI.
  A human answer alone does not settle an unreleased card; the director still owes the release.
- **The director turn is verified, and retried in place.** After a turn exits 0, the pool
  re-reads the card through `readQuestionOutcome`; an unsettled row is requeued with a 30 s
  backoff (two director turns per question), so a note-only first turn is corrected inside
  the worker's bounded wait instead of waiting for the next poll. The retry prompt says: an
  existing answer means *release the card*, never answer again.
- **The question lane has its own clock.** The dispatch tick is single-flight and awaits
  every worker turn, so routing questions from it serialized the answer behind the very
  worker turn it was meant to unblock. `runSession` runs a second, independent interval that
  calls `routeQuestionsNow`; the dispatch tick never awaits a director turn. The queue's
  read-modify-write mutators are synchronous, so the two intervals do not interleave.
- **The loop hears the ladder.** `task_resumed` is a dispatch event; `comment_added` wakes on
  `kind: "question"` (even from an own worker) or a human actor; an own
  `in_progress → todo` move wakes as the director's release. A move to `awaiting` does not
  wake — the worker is parked for a human.
- **The worker holds in-turn, and only a release answers.** `taskctl issue wait <ref>
  --question <id>` is a bounded, read-only wait (default 110 s — under a common 120 s tool
  timeout — max 540 s, 2 s poll) that pulses the caller's own heartbeat. `answered` means
  the card **left `in_progress`** (including a released-then-reclaimed card); a newer note or
  human comment is shown to the worker but does not end the wait: the settle is the release,
  not the author (corrected 2026-11-04 — the Director now signs as `Director`; the decision
  and status are unchanged). `escalated`
  (the card is `awaiting`), `moved`, `timeout` and `error` end the call; the worker may
  re-invoke one more bounded wait when the runtime allows it, then parks and the same worker
  session is resumed by id when the release lands. A non-zero exit is a result, not a failure.
  The question cursor is read with the comments API's `kind=question` and `after=<created_at>`
  filters, so a long card cannot push the question or its answer out of a fixed window.
- **Escalation has no worker-side timeout.** The human may take hours; the worker is not
  running and holds no process. The analogue of a timeout is a **question age alert**:
  `question_stale` covers an unreleased `in_progress` question and an `awaiting` card. The
  heartbeat-stale alert remains (it is the truthful post-park liveness signal).
- **The reviewer is unchanged.** It never asks and never enters `awaiting`; a `REJECT` is its
  communication.

## Why

- The board is the only portable channel: Claude's worker allowlist has no `SendMessage`, and
  Codex/Pi resume is parent-conditional (ADR 0006). A direct session-to-session channel could
  not be the guaranteed path; the board comment trail is auditable, replayable and already
  carries the round and the version.
- A release is a board fact, while a note is only prose. Verifying the release closes the
  permanent-stall failure mode without inventing a second workflow.
- The bounded wait keeps the worker's own context for the common case (a director answer in
  about a minute) and degrades to the already-proven park/resume path for every other case.
- Event wake turns each leg from ten minutes into about one; the continue clock remains the
  fallback when the subscriber is not installed.

## Considered options

- **Keep the 10-minute poll and the stop-and-resume only.** Rejected: the worker cannot be
  said to hold, and a director note could still complete a row without a release.
- **A direct worker ↔ director message channel.** Rejected: platform-conditional and not
  auditable; it would bypass the claim and the board's one resume rule.
- **A worker-side timeout while a human decides.** Rejected: it would turn a valid late answer
  into a lost or duplicated session, and it frees no slot — the worker is already parked.
- **An in-turn wait with no bound.** Rejected: every actor runtime has tool and turn bounds;
  an unbounded call would be killed and misread as a failure. The bound is a budget, not the
  correctness mechanism.

## Consequences

- `CONDITIONAL_EVENTS` (`task_updated`, `comment_added`) is a new event-consumer category; the
  contract test must name it, and `docs/events.md` carries the dispatch rules.
- A held worker occupies a worker-session slot (`busy`, not evictable); `--max-concurrency`
  must exceed the expected number of concurrent holds. The director lane draws no worker slot,
  so a board full of holds cannot deadlock the ladder.
- A parked-question `in_progress` card is a dormant claim **for the supervisor's poll**:
  the poll filters it out of `issue candidates --stale` (and fails closed for any
  `in_progress` candidate when the question read fails), and a `patrolLlm` patrol turn is not
  started for it. The core command itself remains question-agnostic; a human or another
  skill that runs the raw command can still claim the card, and closing that hole is a
  separate core change.
- The CLI gains `issue wait`; the frozen snapshot, `skills/meerkat/references/cli.md` and the
  worker handoff/skills change together.
- The SLA table gains `question_stale` (60/1440, `trail_event`); `.env.example` and the install
  template carry its two keys.
- The decision/skill prompts say "hold", not "stop"; ADR 0006's park/resume path is now the
  fallback and is unchanged.
