# Decision policy — who may decide what

This is the loop's default question policy. A team installed by `setup-meerkat` may
ship `decision-policy.md` in its roles root; the project-level copy
(`.meerkat/roles/decision-policy.md`) wins over the global one, and either wins over
this file. The policy is prompt guidance, not a board gate: the board still enforces
the one invariant that matters — **only a human comment resumes an `awaiting` card**.
The kind does not matter (a note, a discuss, a question are all answers); the board
does not read the text. Whether the answer is a complete decision — approve, reject, or
still incomplete — is judged from its content by the resumed worker, not by the board.

## The ladder

```text
subagent  →  main session (control/project)  →  human
```

A subagent does **not** decide an unauthorized question. It writes an agent
`question` comment on the card, keeps the card `in_progress`, and stops. The project
session answers what it can, or escalates. Only the project session may move a card
to `awaiting`, and only for an E1-E5 decision it cannot make.

## Who decides what

### The subagent decides nothing on its own

It executes what the handoff, `plan.md` and the frozen acceptance explicitly authorize.
Anything else — including implementation shape, file layout, naming, test selection,
fixtures, logging, documentation wording, **epic splitting, acceptance derivation or
change, and scope change** — is a question to the project session.

### The main session decides

Operational and plan/acceptance-internal choices:

- which role/agent handles a card, ordering, retry/requeue, concurrency, the project
  directory, choosing a verification command, re-running a failed check, adjusting a
  timeout inside its bounds;
- splitting an epic **within the same deliverable** (a scope expansion is E1);
- a mechanical acceptance derivation the handoff pre-authorized (changing an existing
  acceptance item is E2).

The main session records its answer as an agent `note` with the decision and the why,
then either answers the live subagent or moves the card to `todo` so a fresh worker
re-claims it with the answer in the trail. It never writes `decision` / `confirm` /
`change`, and never uses `--as-human` for its own decision.

### The human decides — E1-E5

| Code | Question is about |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

The main session escalates anything it cannot decide, plus the reserved matters:
public contracts/API/CLI/schema/migrations, dependencies/licenses, destructive or
irreversible operations, release/deploy, cross-project/cross-team changes,
budget/time/concurrency policy, team/role changes, conflicting requirements, or missing
information. When in doubt, escalate.

### The reviewer

The reviewer never asks a blocking question and never enters `awaiting`. It answers the
review card's acceptance and ends in a `VERDICT: APPROVE` or `VERDICT: REJECT`; if the
evidence is insufficient or the requirements are ambiguous, it REJECTs and writes the
findings. The main session or the human decides what to do next.

## Decision rounds

A decision round settles the choices a piece of work would otherwise assume silently. It
changes *how* a question is asked, never *who* decides: the ladder above still binds, and
only a human comment resumes an `awaiting` card.

1. **Draw the tree.** Each decision is a branch; a decision hangs off the answers it
   depends on.
2. **Find the frontier.** The frontier is every decision whose prerequisites are settled —
   what can be asked now without guessing an answer not yet heard. Ask the whole frontier
   in one round. A decision that depends on another open question belongs to a later round.
3. **Number and recommend.** Q1, Q2, … each with a recommended answer and the why. Word the
   question so "yes" accepts the recommendation; list alternatives for a different answer.
4. **Facts are the asker's job.** Look up the code, docs, board or a probe; when the lookup
   is itself work, start a fact-gathering task or subagent. Never ask the human for a fact
   the tools can establish. A running lookup is an unsettled prerequisite: it blocks only
   the questions downstream of it; ask the rest of the frontier now.
5. **Reshape and repeat.** Answers settle branches and unblock the next frontier. Recompute
   it and ask the next round. The round closes only when the frontier is empty.
6. **Do not act early.** Do not build, freeze a direction, install or write files while a
   frontier item is open. Record the settled answers in `plan.md`, `spec.md` or
   `test-plan.md` (and on the card), and confirm the shared understanding with the decider.

**Card mode — collaborative.** For card execution (Jobs/Linus/Turing) lead with the
recommendation and the evidence, not an interrogation. "yes" accepts the recommended set;
record the answers and proceed.

**Design mode — adversarial.** For setup and team design, challenge the assumptions: ask
what would falsify each one and request a concrete counterexample — a real card, flow or
failure the proposal gets wrong. For a team, require an ownership matrix: every card shape
has exactly one accountable role, and the reviewer is independent of the producer. An
unowned card shape is a finding, not a detail for later.

### Asking through the ladder

One round is one question string per card. A subagent records the whole round in one agent
`question` comment (Q1..Qn, each item in the shape below with its `Verified already`
evidence), keeps the card `in_progress`, and stops. The project session answers every
decidable item in one `note` and moves the card once; it escalates only the E1-E5 items in
one `awaiting` question string that names each E-code, recommendation and evidence. The
human answers in one comment. Only a human comment resumes an `awaiting` card; the resumed
worker judges whether the round is complete and, if not, asks the next round as a new
string. Never spread one round across several question comments, and never open a second
`awaiting` question for the same round.

A single item (or each Qn inside a round) uses this shape:

```text
Decision needed: <one sentence>
Options: A) ...; B) ... [; C) ...]
Recommendation: <the asker's recommendation and why>
Impact if deferred: <what stays blocked>
Verified already: <cards/code/evidence already checked>
```

A main-session escalation additionally says **why it cannot decide** and names the
E-code.

## Recording

- Subagent question: `taskctl comment add <ref> --kind question --body "..." <flags>`
  while the card stays `in_progress`.
- Main-session decision: `taskctl comment add <ref> --kind note --body "decision: ..."`,
  then answer the subagent or `taskctl issue move <ref> todo`.
- Human escalation:
  `taskctl issue move <ref> awaiting --awaiting-reason E1..E5 --question "..."`.
- Human answer: `taskctl comment add <ref> --kind <any> --as-human ...`; the board
  auto-requeues the card. On the board itself the human types in the drawer's comment box
  and submits — the UI sends `discuss`, and that is an answer too. A `decision` /
  `confirm` / `change` kind is the explicit record marker a reviewer can query; the
  resume itself no longer depends on it.

`--as-human` signs the fixed local human name (`TASKCTL_HUMAN`). It is the one way to
record what the human said; it is never the loop's own voice. In a human-opened loop
(`--opened-by human`), the control session may ask its operator in the conversation and
then record the answer with `--as-human`; a supervisor-opened loop leaves the card on the
board for the human's comment.
