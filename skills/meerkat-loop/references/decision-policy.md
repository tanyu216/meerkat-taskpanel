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
`question` comment on the card, keeps the card `in_progress`, and stops. Poll's
**question lane** sees the unanswered question and wakes the project session with it (no
claim, no subagent slot); the session answers with an agent `note` and moves the card to
`todo`, or escalates. Only the project session may move a card to `awaiting`, and only for
an E1-E5 decision it cannot make.

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

## How to ask

Both the subagent → main-session question and the main-session → human escalation use
the same shape:

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
  while the card stays `in_progress`. The loop's question lane hands it to the project
  session on the next poll.
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
