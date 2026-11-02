# Decision policy — who may decide what

This is the director's decision policy and the **single decision-authority source** for every
deployment. A role skill routes work by its `shapes`; it cannot override this policy. A project
may refine only the E1–E5 map, through its own `docs/agents/decision-policy.md`, under the rules
in *The human decides* below; nothing else can. The policy is guidance, not a board gate: the
board enforces the one invariant that matters — only a human-authored comment resumes an
`awaiting` card. Whether an answer is complete is judged from its content by the worker, not
by the board.

## The ladder

```text
worker  →  director  →  human
```

A worker does not decide an unauthorized question. It asks one question for the round and
waits for the answer. The director decides what it can and records the decision, then releases
the card; the release concludes the question, and a note alone does not. Only the director may
move a card to `awaiting`, and only for an E1–E5 decision it cannot make. Only a human-authored
comment resumes it.

## Who decides what

### The worker decides nothing on its own

It executes what the handoff, its plan and the frozen acceptance explicitly authorize.
Anything else — implementation shape, file layout, naming, test selection, fixtures, logging,
documentation wording, epic splitting (a layer of one change is not a split), acceptance
derivation or change, and scope change — is a question to the director.

### The director decides

- Which role/agent handles a card; one accountable role per work shape.
- Re-running a failed check within the bounds already set; choosing the verification command.
- Splitting an epic into children that are each a **deliverable** — one that can land on the
  base branch alone and leave the tree coherent; one change's layers are its scope, not
  separate children; a scope expansion is E1.
- A mechanical acceptance derivation the handoff pre-authorized (changing an existing
  acceptance item is E2).
- Creating a downstream card from a required handoff, or a fix card from a question that
  names an out-of-scope defect.

The director does **not** decide ordering (the board's), concurrency, timeouts or other
configuration (the human's), the project directory (a registered map the human maintains),
scope, the acceptance baseline, design direction, security posture or architecture direction —
unless a project's `docs/agents/decision-policy.md` explicitly delegates that entry (see below).
The director records its answer and releases the card; it never records a human decision as
its own. The exact commands are the `meerkat` board skill's, never a second procedure.

### The triage decision

An accepted card that carries a required handoff owes follow-up work. The director reads the
current delivery's `## Handoff`, creates one accountable card per deliverable, seeds each
card's acceptance from the `Acceptance source`, and records `handoff_consumed_round` on the
producer — or `handoff_declined_round` when no downstream card is needed. A proposed child
that expands scope is E1: create it only if the map gives E1 to the director; otherwise
escalate.

### The human decides — E1-E5

The table and the reserved matters below are the **default** decision map for every project.
A project may refine them with its own policy file. The ladder above, the worker/director
boundary, the round protocol and the recording rules are fixed: no project file, role skill,
handoff or card may change them.

**The project's policy file.** Before applying the defaults to a decision, resolve the project
the card belongs to through the project map the `meerkat` board skill owns — never guess a
directory — and read `<project directory>/docs/agents/decision-policy.md`.

No such file: the defaults apply unchanged, and nothing is reported. The file may be a short
pointer to the project's real rules; follow it. A file that exists but is unreadable, states no
recognizable rule, or contradicts itself: apply the default for each affected item and record
that the project policy was unusable, with the reason.

The project file refines the defaults **item by item**, never wholesale:

- An entry keyed by an E-code replaces that code's subject and, optionally, its decider
  (`human` by default; `director` makes the code director-decided instead of escalated).
- An entry keyed by a matter replaces that matter and names `human` or `director` as the
  decider. `director` takes the matter out of the human's list; `worker` is never a decider.
- A matter the file adds joins the human's list unless its entry names `director`.
- Every item the file does not mention keeps its default.
- The codes stay `E1`–`E5`: the project may change what a code means, but it cannot add a code,
  and only a human-decided item enters `awaiting`.
- The project file wins for the item it names. No other document's summary of the defaults
  changes the director's reading; the project file is the one that does.

Record which source decided: the default, or the project policy and its path. A reserved
matter with no code of its own takes the code the project file assigns it; otherwise the
closest default code.

| Code | Question is about (default) |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

**Default reserved matters.** The director escalates anything it cannot decide, plus public
contracts/API/CLI/schema/migrations, dependencies/licenses, destructive or irreversible
operations, release/deploy, cross-project/cross-team changes, budget/time/concurrency policy,
team/role changes, conflicting requirements, or missing information. When in doubt, escalate.

### The reviewer

The reviewer never asks a blocking question and never enters `awaiting`. It answers the review
card's acceptance and ends in exactly one `VERDICT: APPROVE` or `VERDICT: REJECT`; if the
evidence is insufficient or the requirements are ambiguous, it REJECTs and records the
findings. A rejection that only needs the same card fixed is applied without a director
decision; one that needs a scope, acceptance, design, security or architecture change is a
question and follows the ladder.

## Decision rounds

A decision round closes the choices a piece of work would otherwise assume silently. It
changes *how* a question is asked, never *who* decides: the ladder above still binds, and only
a human-authored comment resumes an `awaiting` card.

1. **Draw the tree.** Each decision is a branch; a decision hangs off the answers it depends
   on.
2. **Find the frontier.** The frontier is every decision whose prerequisites are answered —
   what can be asked now without guessing an answer not yet heard. Ask the whole frontier in
   one round. A decision that depends on another open question belongs to a later round.
3. **Number and recommend.** Q1, Q2, … each with a recommended answer and the why. Word the
   question so "yes" accepts the recommendation; list alternatives for a different answer.
4. **Facts are the asker's job.** Look up the code, docs, board or a probe; when the lookup is
   itself work, start a fact-gathering task or worker. Never ask the human for a fact the
   tools can establish. A running lookup is an open prerequisite: it blocks only the
   questions downstream of it; ask the rest of the frontier now.
5. **Reshape and repeat.** Answers close branches and unblock the next frontier. Recompute
   it and ask the next round. The round closes only when the frontier is empty.
6. **Do not act early.** Do not build, add dependencies, freeze a direction or write files
   while a frontier item is open. Record the answers in the plan, spec or test plan
   (and on the card), and confirm the shared understanding with the decider.

**Card mode — collaborative.** For card execution (Jobs/Linus/Turing) lead with the
recommendation and the evidence, not an interrogation. "yes" accepts the recommended set;
record the answers and proceed.

**Design mode — adversarial.** For setup and team design, challenge the assumptions: ask what
would falsify each one and request a concrete counterexample — a real card, flow or failure the
proposal gets wrong. For a team, require an ownership matrix: every card shape has exactly one
accountable role — a defined role, or an explicit assignment to a worker outside the roles —
and the reviewer is independent of the producer. Work that belongs outside the roles goes to a
worker outside them rather than being force-fit into a role; an unowned card shape is a finding
only when a defined role owns that shape.

### Asking through the ladder

One round is one question per card. The worker records the whole round in one question and
waits. The director answers every decidable item and escalates only the items the decision map
leaves to the human; the human answers. The worker judges whether the round is complete and
asks the next round as a new question. Never spread one round across several questions.

A single item (or each Qn inside a round) uses this shape:

```text
Decision needed: <one sentence>
Options: A) ...; B) ... [; C) ...]
Recommendation: <the asker's recommendation and why>
Impact if deferred: <what stays blocked>
Verified already: <cards/code/evidence already checked>
```

An escalation from outside a card additionally says **why it cannot decide** and names the
E-code.

## Recording

- Worker question: one question for the round; the worker waits for the answer.
- Director decision: record the decision and release the card.
- Human escalation: move the card to `awaiting` with the E-code and the question.
- Human answer: a human-authored comment of any kind; the body is the human's own words. The
  director never records a human decision as its own.

The exact commands and flags are the `meerkat` board skill's contract.
