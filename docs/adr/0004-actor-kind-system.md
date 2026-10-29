# 0004 — The board's actor kind is `system`, and acceptance is decided by evidence

- **Status:** Accepted (2026-10-30)

## Context

Every write records an actor as `(kind, id)`. `kind` named a platform (`claude`, `codex`,
`pi`, …) or the reserved `human`, and the board named itself `taskd` — the service process.
Two problems followed. A reader could not tell "the system did this" from "some agent called
taskd" (the word is a process name), and the record let the board look like one more agent
platform. Worse, the acceptance gate trusted the string: `agent`-mode cards and review cards
were closable only by `kind ∈ {human, taskd}`, while `--actor-kind taskd` is claimable by any
caller — only `human` is refused at the transport. The privilege was a convention, not a rule.

## Decision

1. The board's own writes use the kind **`system`** (the former `taskd`). It is the one kind
   that names a role rather than a platform, and that is its point: the user reads "系统" in
   the drawer where "taskd" meant nothing.
2. Acceptance authority moves off the kind and onto **evidence**: an `agent`-mode card is
   closable once a current-round review carries an `APPROVE`, and never by the actor that
   wrote that verdict. A review card follows the same rule against its own report. `human`
   mode still admits exactly one kind.
3. The loop's automated writes are `system` under the actor id **`Orchestrator`** — an id, so
   the workflow pass is neither the first worker's act nor the reviewer's.
4. A kind is **not** an authority anywhere. `system` is claimable, exactly as `taskd` was;
   it buys nothing, because every gate that used to read it now reads the evidence.

## Why

- The old rule ("`system` names no platform, so it may not be a kind") was right about the
  word and wrong about the reader: the record's job is to tell a person from an agent from
  the board, and a process name fails that job for everyone who does not run the service.
- The acceptance privilege was already forgeable. Moving the decision to the evidence removes
  the forgery instead of renaming it, and it states the property that actually matters — an
  independent review approved this card, and the reviewer did not close it.
- No schema change was needed: no SQL CHECK, trigger or invariant reads an actor kind
  (`0001_init.sql`). Historical rows keep their `taskd` as recorded; append-only triggers make
  rewriting them impossible, and history is not edited to match a new vocabulary.

## Consequences

- The delivery agent may close its own card after an independent `APPROVE`. That is entailed
  by the evidence rule: the approval, not the closer, is the gate.
- A review card with no current-round report has no verdict author to exclude, so any
  non-blank actor may close it; the loop's planner never asks for that.
- `system` is a role word in a column that otherwise names platforms. A future reader must not
  reintroduce "kind means platform" reasoning; `test/contract/actor-kind.test.mjs` bans the
  retired `taskd` alongside the vague `agent`, and `docs/events.md` §9 states the cost.
- The SLA mechanism label stays `taskd` (it names the mechanism that computed a row, not an
  actor) and is a separate constant, so renaming the kind never re-keys outstanding alerts.
