# Operating the director

The director is the supervisor's decision lane. The supervisor runs the deterministic
passes itself; the director is opened only when a row needs a **content decision**. This
page is the operator's view: the rows, the prompt the supervisor provides, manual mode and
the process directory.

## The rows

The supervisor enqueues one row per decision:

| `queue_kind` | Source | Your move |
|---|---|---|
| `question` | a worker wrote an agent `question` and holds (`issue wait`) | a `note` + move to `todo`, or escalate |
| `route` | an unassigned/ambiguous `todo` card past 30 minutes | `issue assign` the role the table names |

A question row is capped at two attempts; a route row is enqueued once per window. Neither
is a card handoff: a row is never claimed, never opens a reviewer lane and never consumes a
worker slot. Rows are grouped by project directory into one director lane.

## The generated prompt

The supervisor builds the prompt; you do not re-derive the board state from scratch.

- the routing table, generated from every discovered role's `shapes`;
- the decision-policy path and the frontier/decision-round rules;
- the exact `taskctl` commands and the identity flags to use;
- the card, the question text and its age, or the unowned card's shape.

A human can run `/meerkat-director` in a live session. That is **manual mode**; the
supervisor keeps its clocks and remains the only dispatcher.

## Manual mode: the agenda

1. **Open the board once.** `taskctl loop doctor --json` is the health read;
   `taskctl loop console --json` is the work read (`questions`, `pending_acceptance`,
   `supervisor`). Each `questions[]` entry carries `age_ms` and
   `answered_pending_release`: an answered-but-unreleased question is yours to release,
   not a human's to answer again. Report one digest before any write.
2. **Waiting on me — one card at a time.** Read the card back, ask that card's **frontier**
   as one numbered block (Q1..Qn, each with a recommendation), and record the answer as a
   human comment (`--as-human`, per the `meerkat` board skill) after showing the exact
   body. A board-UI answer counts too — do not duplicate it. `awaiting → todo` is the
   board's own requeue; do not move it again.
   - An **agent question** is your rung: decide it with an agent `note` and the ladder's
     move, or escalate E1–E5 to `awaiting` with the question.
   - Only a human comment resumes `awaiting`, whatever its kind.
3. **Health and blocks.** From the doctor report: verdict, `attention_reasons`,
   `stuck_cards`, `looping`, `workers`, `waiting.in_review`, `queue`, `board.truncated`.
   List the `blocked` cards through the `meerkat` board skill with their
   `blocked_reason`, age and assignee. Report only; never unblock one behind the human's
   back.
4. **Backlog release.** `backlog → todo` is the only forward edge; `in_progress` is a
   claimed state. Assign an owner only when the human names one. An epic is released but
   never claimed; its children are.
5. **Card management.** Every other write is the `meerkat` board skill's command; show it
   before writing it.

Every write is shown first, verbatim. A "yes" to a recommendation is recorded as that
recommendation plus yes, never paraphrased.

## Card briefs and task process directories

The supervisor gives each dispatched card one directory under the project's working
directory (the resolved `target_dir`):

```text
.meerkat/<identifier>/
  card.md          exported by the supervisor; read-only to agents
  plan.md          the worker's plan: goals, steps, risks, acceptance mapping
  …                notes, logs, evidence, report drafts, downloaded attachments
```

**Register before claim.** Poll resolves the project directory, registers the card with the
local event hub, naming `<target_dir>/.meerkat/<identifier>/card.md` (and the original's
brief for a review card). The hub writes the first snapshot before it answers `registered`,
then keeps the file fresh until the card is `done` or `canceled`. A failed registration
defers the card unclaimed.

**The brief is authoritative.** The handoff names the relative path, says to read it first
and never to edit it. The live card stays in the handoff for status and the `version` a
write needs. A resumed session re-reads the brief before continuing.

**The plan file.** Workers maintain `plan.md` beside the brief; the reviewer reads it and
treats an unexplained deviation as grounds for `VERDICT: REJECT`. A missing plan is not
itself a failure — the reviewer falls back to the description and the frozen acceptance.

## Questions and decision rights

A worker decides nothing on its own. It writes an agent `question` on the `in_progress`
card, keeps it `in_progress` and **holds** with `taskctl issue wait`; the supervisor enqueues
the question row. You answer with an agent `note` and **release the card to `todo`**, or
escalate E1–E5 (scope, acceptance, design/aesthetic, security/data, architecture) with
`issue move <ref> awaiting --awaiting-reason E1..E5 --question "..."`. The release is the
settle: a note without the move is retried, and a card that already has a later answer is
released without a second answer.

The board's one hard rule is not yours to bend: **only a human comment resumes an
`awaiting` card.** The resumed worker judges from its content whether the answer is
complete; an incomplete answer is the next round, not a silent consent.

You never claim a card, implement, write a `decision`/`confirm`/`change` kind, use
`--as-human` for your own decision, or move a card to `done`.
