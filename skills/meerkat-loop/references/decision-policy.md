# Decision policy — who may decide what

This is the loop's decision policy and the **single decision-authority source** for
every deployment. A team's `ownership.md`, when it has one, routes work; it cannot
override this policy. The policy is prompt guidance, not a board gate: the board
still enforces the one invariant that matters — **only a human comment resumes an
`awaiting` card**.
The kind does not matter (a note, a discuss, a question are all answers); the board
does not read the text. Whether the answer is a complete decision — approve, reject, or
still incomplete — is judged from its content by the resumed worker, not by the board.

## The ladder

```text
subagent  →  main session (control/project)  →  human
```

A subagent does **not** decide an unauthorized question. It writes an agent
`question` comment on the card, keeps the card `in_progress`, and stops. Poll's
**question lane** sees the unanswered question and wakes the project session with it (no
claim, no subagent slot); the session answers with an agent `note` and moves the card to
`todo`, or escalates. Only the project session may move a card to `awaiting`, and only for
an E1-E5 decision it cannot make.

## Who decides what

### The subagent decides nothing on its own

It executes what the handoff, `plan.md` and the frozen acceptance explicitly authorize.
Anything else — including implementation shape, file layout, naming, test selection,
fixtures, logging, documentation wording, **epic splitting (a layer of one change is not a
split), acceptance derivation or change, and scope change** — is a question to the project
session.

### The main session decides

Operational and plan/acceptance-internal choices:

- which role/agent handles a card, ordering, retry/requeue, concurrency, the project
  directory, choosing a verification command, re-running a failed check, adjusting a
  timeout inside its bounds;
- splitting an epic into children that are each a **deliverable** — one that can land on the
  base branch alone and leave the tree coherent; one change's layers are its scope, not
  separate children; a scope expansion is E1;
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

**In manual mode a round is scoped to one card.** The live session walks the waiting cards
one at a time, so the frontier is that card's unsettled decisions — never several cards at
once. The next card opens only after this one's answer is recorded.

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
6. **Do not act early.** Do not build, add dependencies, freeze a direction or write files
   while a frontier item is open. Record the settled answers in `plan.md`, `spec.md` or
   `test-plan.md` (and on the card), and confirm the shared understanding with the decider.

**Card mode — collaborative.** For card execution (Jobs/Linus/Turing) lead with the
recommendation and the evidence, not an interrogation. "yes" accepts the recommended set;
record the answers and proceed.

**Design mode — adversarial.** For setup and team design, challenge the assumptions: ask
what would falsify each one and request a concrete counterexample — a real card, flow or
failure the proposal gets wrong. For a team, require an ownership matrix: every card shape
has exactly one accountable role — a defined role, or an explicit assignment to a worker
outside the roles — and the reviewer is independent of the producer. Work that belongs
outside the roles goes to a worker outside them rather than being force-fit into a role; an
unowned card shape is a finding only when a defined role owns that shape.

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

**In manual mode** the live session is the middle rung: it selects the card, asks its frontier
in the conversation, and records the answer on that card. The next card starts only after the
answer is written. An operational `agent-question` is the session's to decide; only E1–E5 is
carried to the human.

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

- Subagent question: an agent `question` comment while the card stays `in_progress`; poll's
  question lane hands it to the project session.
- Main-session decision: a `note` comment recording the decision, then answer the subagent or
  move the card back to `todo`.
- Human escalation: move the card to `awaiting` with the E1–E5 reason and the question.
- Human answer: a human comment (`--as-human`) of any kind; the board requeues the card to
  `todo` in the same transaction, so do not move it again. On the board the human types in the
  drawer's comment box (the UI sends `discuss`, which is an answer too). `decision` / `confirm`
  / `change` is the explicit record marker a reviewer can query; the resume does not depend on
  it. The body is the human's own words, shown to them before it is written — a "yes" to a
  recommendation is recorded as that recommendation plus yes, never paraphrased or enriched.

The comment and move commands themselves are the `meerkat` board skill's contract.

`--as-human` signs the fixed local human name (`TASKCTL_HUMAN`). It is the one way to record
what the human said; it is never the loop's own voice. In a human-opened loop
(`--opened-by human`), the control session may ask its operator in the conversation and record
the answer with `--as-human`; a supervisor-opened loop leaves the card on the board.
