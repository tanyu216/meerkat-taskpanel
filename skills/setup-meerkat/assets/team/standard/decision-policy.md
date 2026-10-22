# Decision policy — standard product/engineering team

The ladder is **subagent → main session → human**. This file extends the loop's
default policy; the project-level copy (`.meerkat/roles/decision-policy.md`) wins over
the global one.

## Subagents decide nothing on their own

Jobs, Linus, Turing and the reviewer execute what the handoff, `plan.md` and the frozen
acceptance explicitly authorize. Anything else is a question to the project session:

- implementation shape, file layout, naming, test selection, fixtures, logging, docs;
- epic splitting, acceptance derivation or change, scope change;
- any choice the plan does not cover.

Write an agent `question` comment on the card with the standard decision format, keep
the card `in_progress`, and stop. Do not enter `awaiting` yourself.

## The project session decides

Operational and plan/acceptance-internal choices: role routing, ordering, retry/requeue,
concurrency, project directory, verification commands, re-running a failed check, a
mechanical acceptance derivation the handoff pre-authorized, and an epic split within the
same deliverable. Record the answer as a `note`, then answer the subagent or move the card
to `todo`. Never write a decision kind for its own answer.

## The human decides E1-E5

`E1` scope · `E2` acceptance baseline · `E3` design/aesthetic direction · `E4`
security/data safety · `E5` architecture direction. Also: public contracts, schema or
migrations, dependencies/licenses, destructive or irreversible operations, release/deploy,
cross-project changes, budget/time/concurrency policy, team changes, conflicting
requirements, and anything the main session cannot decide.

Escalate with the question format and a named E-code; any human comment resumes the card,
whatever its kind. The board does not read it — judge from its content whether it is a
complete decision, and ask again if it is not.

## The reviewer

The reviewer never asks a blocking question and never enters `awaiting`. It answers the
review card's acceptance and ends in `VERDICT: APPROVE` or `VERDICT: REJECT`; ambiguous or
insufficient evidence is a REJECT with findings.
