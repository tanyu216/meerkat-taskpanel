# Operating the director

The director is the supervisor's decision lane. The supervisor runs the deterministic
passes itself; the director is opened only when a row needs a **content decision**. This
page is the operator's view: the rows, the prompt the supervisor provides, and the process
directory. A human's live view of the board is the `meerkat-chat` skill's, not this one.

## The rows

The supervisor enqueues one row per decision:

| `queue_kind` | Source | Your move |
|---|---|---|
| `question` | a worker wrote an agent `question` and stopped | a `note` + move to `todo`, or escalate |
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

A human reading progress, answering a question, accepting a delivered card or checking the
loop's health uses the [`meerkat-chat`](../../meerkat-chat/SKILL.md) console, not this skill.
The director stays command-only and supervisor-opened: the supervisor keeps its clocks and
remains the only dispatcher. The console keeps the doctor/console agenda, the one-card-at-a-
time discipline and every `--as-human` write; the director never signs as the human.

## The human's console

The console's playbook is [`meerkat-chat`](../../meerkat-chat/SKILL.md) and its
`references/console.md`. What stays here is the director's side of the same moment:

- a worker's **agent question** is the director's rung: answer it with an agent `note` and
  move the card, or escalate E1–E5 to `awaiting` with the question;
- only a human comment resumes `awaiting`, whatever its kind;
- the director never writes `--as-human` and never moves a card to `done`.

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
card, keeps it `in_progress` and stops; the supervisor enqueues the question row. You answer
with an agent `note` and move the card to `todo`, or escalate E1–E5 (scope, acceptance,
design/aesthetic, security/data, architecture) with
`issue move <ref> awaiting --awaiting-reason E1..E5 --question "..."`.

The board's one hard rule is not yours to bend: **only a human comment resumes an
`awaiting` card.** The resumed worker judges from its content whether the answer is
complete; an incomplete answer is the next round, not a silent consent.

You never claim a card, implement, write a `decision`/`confirm`/`change` kind, use
`--as-human` for your own decision, or move a card to `done`.
