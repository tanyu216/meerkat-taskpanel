# Answering a question in the human's name

The ladder is `worker → director → human`. The human is the top rung, and this skill is their
front end: it reads the question, helps them decide, and records their words. It never decides
for them.

The question-shaping rules — the frontier, the numbered round, "facts are the asker's job" — are
the director's decision policy and have one home:
[`../../meerkat-director/references/decision-policy.md#decision-rounds`](../../meerkat-director/references/decision-policy.md#decision-rounds).
Reuse them here; do not re-derive a second protocol.

## Find the open question

Comments come back **newest first**:

```bash
taskctl comment list <ref> --limit 20 --json
```

(Use `--json` for the whole read; the human output is for a person reading a terminal.)

- The newest `question` comment is the candidate.
- It is **open** when nothing newer and non-`question` sits above it. A human comment, a
  `note`, a `decision` — any newer non-question — settles it.
- An `awaiting` card is narrower: only a **human** comment resumes it. The board moves it back
  to `todo` in the same transaction, whatever the comment's kind.

`loop console --json` already applies these predicates; use `comment list` to read the body and
to confirm an answer that arrived in the board UI.

## Read the whole round first

A worker or the director may ask Q1..Qn in one string. Settle the whole frontier, not the first
line:

1. **Look up every fact the tools can establish** — code, docs, board, a probe. Never ask the
   human for something `taskctl` can answer.
2. **Number the open items** Q1..Qn, each with a recommendation and why, worded so "yes"
   accepts the recommendation.
3. **Say what stays blocked** until the answer lands.
4. **Do not act early.** Do not move, create or build while a frontier item is open.

A nice round looks like this:

```text
Decision needed: Should TP-0047's acceptance baseline grow from 3 items to 4?
Options: A) add the fourth and freeze it; B) keep 3 and open a separate card for the fourth
Recommendation: A — the fourth item is part of this change; a separate card would leave a half-finished result
Impact if deferred: TP-0047 stays awaiting; the worker will not continue
Verified already: read acceptance[], the current-round report and the lane branch
```

## Record the answer

Show the exact body and the exact command before writing. A "yes" to a recommendation is
recorded as **that recommendation plus yes** — never paraphrased, never enriched with advice the
human did not give. When the human typed their own words, keep them.

**Delegation is still the human's decision.** "You decide" or "go with your recommendation"
accepts the recommendation you just presented; it does not authorize inventing options or answers beyond
that round. Still show the literal body — the recommendation plus their approval — and record
it. For an E1–E5 matter the human remains the decider; their delegation is the decision.

### Answer an `awaiting` card

```bash
taskctl --as-human comment add <ref> --kind note --body "<the human's answer>"
```

That is the whole act: the board requeues the card to `todo` in the same transaction. Do not
move it again — an extra `issue move` is a second act the human did not ask for. After writing,
re-read the card and report the new status and `version`.

### Answer an `in_progress` agent question

A human comment settles the question, but the card stays `in_progress` with its worker stopped.
The queue will not pick it up. Record the answer **and** requeue it as one act:

```bash
taskctl --as-human comment add <ref> --kind note --body "<the human's answer>"
taskctl --as-human issue move <ref> todo
```

Show both commands before running them. If the director already answered, the question is
settled and `loop console` no longer lists it — do not answer a second time.

### The answer arrived in the board UI

The drawer sends a human `discuss` comment, and that is an answer. Do not duplicate it. Verify
with `comment list` and report the state the board already reached.

## Comment kinds

| Kind | Use it for |
|---|---|
| `note` (default) | an ordinary human answer or remark |
| `decision` / `confirm` / `change` | an explicit record marker a reviewer may query later — optional, never required for a resume |
| `discuss` | what the board UI's comment box sends; do not hand-write it as a substitute |
| `question` | asking — never record a human answer as a question |

The resume is judged from the comment's **content**, not its kind. One round is **one** comment:
never spread a round across several comments, and never open a second question for the same
round.

## When to leave the question to the director

The director owns operational and plan/acceptance-internal choices. If an `in_progress` card
opens an operational agent question and the human has not engaged with it, the director lane
will answer it and requeue the card; chat does not need to race it.

Chat answers when:

- the card is `awaiting` — the human is the only rung that resumes it;
- the human asks to answer, or dictates the answer;
- the question is E1–E5 (scope, acceptance baseline, design, security/data, architecture) and
  therefore the human's by policy.

When in doubt, present the question and let the human choose whether to answer or leave it to
the director.
