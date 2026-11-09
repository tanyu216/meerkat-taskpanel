# 0006 — A worker is its own session, resumed by id in the same round

## Status

Accepted — 2026-10-31.

> **Note (2026-10-31):** the reviewer lane's session key now includes the actor kind that carries the reviewer role (ADR 0007); its per-directory, subagent-spawning shape is unchanged. The worker-session decision is unchanged.
>
> **Note (2026-11-01):** ADR 0008 adds the bounded in-turn `issue wait` hold. The same-round resume/replay path here is unchanged and remains the fallback for `escalated`/`timeout`/`moved`/`error`.
>
> **Note (2026-11-05):** **Superseded in part by ADR 0017.** A re-dispatch still resumes inside the claim (a rework, a crash), but a card that leaves the claim cycle — a release, a cancel, an answer to `awaiting`, a terminal move — has its turn interrupted and its session and transcript discarded; the next claim is fresh. The `escalated`/`timeout`/`moved`/`error` fallback remains true only while the card keeps its claim.

## Context

A worker wake used to be a **subagent** of a project session: poll claimed the card, a project
session received a batch, and it spawned one subagent per card. That made the worker's
conversation parent-mediated. All three agent kinds resume a **top-level** session by id
(`claude --resume`, `codex thread/resume` / `exec resume`, `pi --session-id`), but their
subagent mechanisms differ and are conditional (Claude `SendMessage`, Codex `resume_agent` after
a loaded parent, Pi `subagent resume` with the same parent and a persisted run). A worker that
asked a human, or whose turn ended, was therefore dispatched again as a **new** worker; its
context was reconstructed from the board and `card.md`, never resumed.

The design assumed that: `docs/scheduling.md` said subagents do not resume,
`docs/lifecycle.md` said the asking subagent "is a one-shot and is gone", and `GLOSSARY.md` said
the handoff is "deliberately built new each time rather than resumed". The human decision (E5) is
that a same-round re-dispatch must resume the original worker wherever the platform can do it,
and must preserve continuity even when the native session is gone.

## Decision

- Each worker card runs in its own **top-level pooled session**, keyed deterministically
  `worker:<card>:r<round>` and stored in `sessions.state.json` under that key. The session's
  `cwd` is the card's admitted worktree. Reviewers keep the existing batch/subagent lane.
- A same-round re-dispatch — awaiting answer, same-round rework, crash recovery — reopens the
  stored session id and sends a **resume** prompt carrying the answer/reason. The round does not
  move, and the worktree must match; a round bump or a recreated worktree starts a new
  generation and retires the old record.
- When the native session is unavailable (CLI store gone, expiry, failed resume), the loop
  replays a **bounded, loop-owned transcript** into a fresh session in the same worktree and
  marks the record `resumed_by_replay`. If replay also fails, the record is `stale`/`blocked`,
  the queue row fails, and the doctor surfaces it. The loop never silently starts a second
  worker.
- Worker turns do not write a **live** ledger row: the processing queue row is the concurrency
  slot, and a terminal `type: "worker-session"` ledger row is the audit record. `sessionPoolMax`
  bounds orchestrator lanes only; open worker sessions are bounded by `max-concurrency`.

This reverses the three statements above. `skills/meerkat-loop/` and the docs named in
Consequences carry the new rule.

## Considered options

- **Keep subagents and reattach the child on every dispatch.** Rejected: reattach is
  parent-mediated and platform-conditional, the Pi adapter does not capture the real `runId`,
  and Claude's worker allowlist does not include `SendMessage`. It cannot be the guaranteed path.
- **Replay only, never native.** Rejected: it discards a live session and its exact context even
  when the CLI can resume it.
- **One-shot worker wakes with a resume id.** Rejected: a one-shot has no live project context
  for questions, and Codex child resume requires the parent to be loaded.

## Consequences

- `cards.queue.json` rows carry `worker_key`; a new round supersedes a pending row in place and
  never replaces a processing one. `sessions.state.json` moves to version 3 with a `worker:`
  namespace; older files are read as before.
- The pool persists the session id before the turn and recovers processing worker rows on start
  without counting an attempt. `recoverStaleCards` leaves a resumable worker row to that path.
- The doctor reports worker counts, `resumed_by_replay`, blocked/stale records and missing
  worktrees; the human `status` prints a workers line.
- Docs updated: `docs/scheduling.md` (pool, resume, capacity, continuity, state tree),
  `docs/lifecycle.md` (awaiting is a same-attempt resume), `docs/events.md` (`task_resumed` stays
  a board fact; loop resume emits no board event), `GLOSSARY.md` (worker session, replay,
  handoff), `README.md` / `docs/ops/install.md` (state inventory), and the loop skill.
- A native session the CLI has deleted cannot be restored; replay is the deliberate fallback,
  and it is visible as `resumed_by_replay`, never disguised as a native resume.
