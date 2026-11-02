# 0011 — Card acceptance is one word chosen at creation

**Status:** Proposed

## Context

The board carried two acceptance layers: `projects.acceptance` (`auto | off | agent |
human`) as a default, and `tasks.acceptance_mode` (`off | agent | human`) as the frozen card
snapshot. `auto` meant "the creator decides per card" on the project layer, while the card
layer had no `auto` and fell back to `agent`. The model also restricted `human` to top-level
cards.

The two layers made the rule hard to read: a card's closer depended on a value the card did
not carry, and the project row became a policy store the board otherwise avoids. The top-level
restriction had no database counterpart and existed only at three application boundaries.

## Decision

A card carries exactly one acceptance word, chosen by its creator at creation:

- `off` — no review; the deliverer may close it, and `in_progress → done` is allowed.
- `auto` — an independent review, then the loop closes it on a current-round `APPROVE`. This
  is the fallback when no word is stated.
- `human` — an independent review, then only a person closes it, after that review finishes.

Projects carry no acceptance default. A project may document its creators' selection guidance
in `docs/agents/acceptance-mode.md`; the `meerkat` skill discovers it. That document is not board
data: nothing stores or inherits it. The parent/depth restriction is removed: any card may be
any word. Existing `agent` cards migrate to `auto`.

## Why

One card, one word: the rule a writer reads is the rule the board enforces. Removing the
project layer removes a second source of truth and the "which layer wins" question, and makes
the creator's own context the only decision point. The `auto` fallback keeps review as the
default without a human or director dependency.

## Consequences

- Migration `0002` rebuilds `tasks` (widening the `CHECK`, rewriting `agent → auto`) and
  `projects` (dropping the column), recreating every index and trigger.
- `agent` is no longer a card word; external callers must send `auto`. The HTTP route ignores
  a stale `acceptance` field; the CLI rejects the retired project flag as a usage error.
- A `human` card can no longer be closed before its current-round review finishes; this is a
  deliberate tightening, and the reviewer is also refused when it would APPROVE a delivery
  the close gate could never accept.
- A deployment that used a project-level `human` default must state the mode per card, or
  document the guidance in `docs/agents/acceptance-mode.md`.
