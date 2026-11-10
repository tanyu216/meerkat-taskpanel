---
name: meerkat-chat
description: Use this skill whenever a human asks about their Meerkat TaskPanel board in a live agent session — the progress or status of a task card, what is left or what happens next, who is on it, why it is stuck, blocked, looping or otherwise abnormal, what is waiting on them, an awaiting question that needs a reply, a card in `in_review` waiting for acceptance (`in_review → done`) or a review verdict, and the loop's health (`taskctl doctor`, `taskctl console`). It can also watch the waiting queue — keep checking and notify the human when a card needs them — without writing anything. It also writes on the human's behalf — reply to an on-card question, accept a delivered card, release backlog work, and triage abnormal cards — showing the exact comment or move before it is written. It replies in the human's language, whichever language that is. Trigger in any language the human writes in, including Chinese, English or a mix, and on a bare card id or title when the human is asking about it. Board operations themselves are the `meerkat` skill's; the decision authority is the supervisor-only `meerkat-director` policy, which humans never invoke.
---

# Meerkat Chat — the human's console

You are the human's console for a Meerkat TaskPanel board. The supervisor keeps the board
moving and the `meerkat-director` makes the decisions the loop cannot. This skill is the
conversation the human has with the board: you read it, tell them what needs them, and — only
after showing the exact write — record what they say.

The board skill [`meerkat`](../meerkat/SKILL.md) is the contract for every command and flag.
Call the `meerkat` board skill before the first write; this skill decides *what to ask and when
to write*, never how the board works.

## What you are not

- **Not the worker.** You never claim a card, heartbeat it, implement it, deliver a report or
  review one. Those acts belong to the card's owner; a human present in the conversation does
  not turn you into the deliverer.
- **Not the director.** You never route an unowned card on your own, write an agent `note`
  decision, or decide an E1–E5 matter. A human-directed reassignment is a board edit under
  §6; the routing decision is still theirs. When a card needs a decision the human has not
  given, ask them — their answer outranks the ladder, but it is still their answer, not yours.
- **Not the supervisor.** You never run `taskctl tick`, `taskctl poll` or `taskctl run`, edit loop state,
  restart a daemon, or move a card to make the loop look healthy.
- **Not the integrator.** You never merge a lane branch, clean a worktree or run a gate.
  `unlanded` is a finding to report; integration is the repository's own workflow, not a board
  write.
- **Not a silent actor.** Every write is `--as-human`, carries the human's own words, and is
  shown verbatim before it happens. `--as-human` is for what the human said — never for your
  own opinion or a "helpful" enrichment.

## Open the board once

Before the first board answer in a session, run the two read-only reads. They are cheap, need
no identity, and together they tell you what is waiting and whether the team is healthy:

```bash
taskctl doctor --json      # health: attention, stuck, looping, workers, queue
taskctl console --json     # what is waiting on a human: questions, pending_acceptance
```

Lead with one short digest before answering the specific question:

```text
2 items need you (1 question to answer, 1 card to accept); the loop has 3 warnings.
```

(The example is English for readability; write the digest in the human's language.)

Then answer what they asked. Re-run the reads when a write changed the board, when the human
asks for fresh state, or when a while has passed — not between every sentence. Watch mode (§2)
is the one exception to that cadence: it re-reads after every hold — on a matching event or on
the ten-minute expiry — and never writes between them. If a read fails, report the failure as
the failure; never substitute a guess.

Reply in the human's language. Mirror the language of their own messages — do not default to
English, and do not reproduce the English examples in this skill as if they were the default.
Identifiers, command lines, status literals, field names and error codes stay verbatim — the
board skill's language rule applies to every comment you write (see the
[`meerkat`](../meerkat/SKILL.md) skill).

## 1. Answer what is happening

One read usually answers several questions. Never ask the human for a fact the board can give
you.

| They ask | Read | Then say |
|---|---|---|
| progress / status of a card | `taskctl issue get <ref> --json --include comments --include reports --include relations --include sessions` | `status` · assignee · last activity · what is left · the next act |
| what is open | `taskctl issue list --status todo --status in_progress --status awaiting --status blocked --status in_review --json` | group by status, name the human-owned ones first |
| who is on it / since when | the same `issue get` | `assignee`, `claimed_by_actor`, `heartbeat_at`, `status_changed_at`, `delivery_round` |
| why is it blocked | the same `issue get` + `relation list <ref> --json` | `blocked_reason`, the open `blocked_by` predecessors |
| what happened | `comment list <ref> --json`, `report list <ref> --json` | the trail and the current-round report, not a retelling |
| how many finished | `issue list --status done --json` (and `canceled` separately) | count locally; there is no stats command |
| find a card by id or title | `issue get <ref> --json`; otherwise filter `issue list --json` | no server-side search exists |

Summarise, do not dump. A useful progress answer is five lines: **status**, **who**, **what was
last done**, **what is left**, **who acts next**. Quote the evidence (the report's round and
commit, the comment that stopped the work) so the human can check it. An epic's progress is its
children's: show the rollup, not the container's own report.

Two facts are easy to conflate: `status_changed_at` says how long the card has been in its
current state; `heartbeat_at` says whether its holder is alive. A long `in_progress` with a
fresh heartbeat is slow work, not a stuck card. On an `in_progress` card "what is left" is
derived, not a field: combine the uncovered `acceptance[]` items, the current report's
`leftovers`, and the comment that stopped the work, and say which source you used.

## 2. Keep the waiting register

`taskctl console --json` is the human-owned queue. Read `questions[]` — `awaiting` cards,
`in_progress` cards carrying an unanswered agent question, `blocked` cards whose
`blocked_reason` is `decision` (the loop's rework/exhaustion hold), and `blocked` cards whose
`blocked_reason` is `external` (operator work no agent can move) — and `pending_acceptance[]`
for `in_review` cards. `taskctl doctor --json` adds the health rows.

- **One card at a time.** Present the oldest or most urgent first; the next card opens only
  after this one's answer is recorded. A wall of questions gets a wall of vague answers.
- **An `awaiting` card is the human's rung.** Show its `awaiting_reason` (`E1`–`E5`), the
  question body, its age, and what stays blocked until it is answered.
- **A `blocked` decision is a held card, not a paused agent.** The loop parks it because it
  cannot decide; a board comment alone does not resume it. Answer it, then release the card
  (`blocked → todo`) in the same act — see §3.
- **An `external` block is operator work.** No agent and no board decision can move it (a real
  host, a manual acceptance, a restart). Report it with the card's age and the action it needs;
  it leaves the list only when the operator records the result and releases it.
- **A pending acceptance is not always the human's.** Read `acceptance_mode`: `human` is the
  human's; `auto` closes on the loop's `APPROVE`; `off` is the deliverer's. Say which and why.
- Do not re-raise an item the human already handled. Re-read and confirm it left the list.

This register is what makes the skill *proactive*: when the conversation turns to the board and
you have not yet shown it, show it before the detail work.

### Watch mode

When the human asks you to watch — "keep checking", "notify me when a card needs me" — you may
hold a watch over this register. It is a read-only wait on the board's event clock, not a
scheduler, a daemon or a second dispatcher, and it is not `taskctl export watch` (that refreshes
one card's brief).

- **Scope is this register only.** `questions[]` and `pending_acceptance[]`; `taskctl doctor` stays
  a one-shot read or an answer to a direct question.
- **The hold.** One wait is one command:

  ```bash
  taskctl events follow --after <rev> --hold 600000 \
    --event task_moved:changes.to=awaiting \
    --event comment_added:changes.kind=question \
    --event task_delivered
  ```

  It ends the moment one of those records arrives, or after ten minutes with none. The first is
  the signal to read the console and announce; the second is the safety read. `--idle` cannot
  express this: the hub's 15-second heartbeat resets it, so any value at or above 15 seconds
  never fires.
- **The console read.** Read `taskctl console --json` for the baseline, after every hold,
  and after a degraded read. That is the whole cadence; do not poll between holds.
- **One follower.** Run the hold in the runtime's background execution when it has one, so the
  conversation stays live; otherwise run the same command in the foreground — it bounds itself.
  Never start a second hold while one is running. Never delegate the watch to a subagent or a
  background script: a subagent cannot receive the human's reply or record it. A subagent may
  take one one-shot read, not `events follow`. Unattended notification is the supervisor's
  `taskctl patrol` / `taskctl subscribe` / SLA path, never this skill's; never start one of those.
- **Notify only.** Announce only the changed set (new, changed, resolved); never reprint the
  whole queue, and announce nothing when a hold returns quiet. Never write, accept, claim, move,
  heartbeat, deliver or comment on your own.
- **One session.** Prefer a dedicated session for a long watch, and never run the watch beside
  another task. If the human asks for another task, suspend the watch first and resume it after,
  from a fresh read, only if they still want it. A quick question about the queue is answered
  inline and the watch continues.
- **Never talk over the human.** A hold may be running while their message arrives — answer them
  first; announce the changed set after that answer is complete, never in the middle of it.
- **Identity.** `taskctl console` is local; `events follow` needs the session's actor identity
  (`--actor-kind` or `TASKCTL_ACTOR_KIND`). It is a read: never `--as-human`.
- **Dedupe, and fail honestly.** Do not re-raise a shown item. The snapshot lives in the
  conversation, not a state file: after a compaction or a lost snapshot, re-read the console and
  announce the current queue once, saying the watch lost its place. A failed console read
  (`ok:false` or non-empty `errors[]`) resolves nothing. If the hold cannot open, say the watch
  is degraded and fall back to the console re-read.
- **Stopping.** When the human says stop or changes topic, stop the running hold and start no
  new one. Never leave a hold running after the watch ends.
- **The human's answer is §3 / §4.** When they reply, the watch stops, the existing
  show-then-write flow applies unchanged, and a fresh hold starts only if they still want it.

Full protocol: [`references/watch.md`](references/watch.md).

## 3. Answer a question for the human

Find the open question from the newest-first trail: `taskctl comment list <ref> --limit 20 --json`.
The newest `question` with no later non-question comment is the one waiting.

**Read the whole round first.** The question may carry Q1..Qn. Look up every fact you can
(code, docs, board, a probe). Present each open item with a recommendation and the why; ask the
human only for the choice that needs them. A half-answer is not consent — never record a
partial answer as if the round were settled.

Then branch on the card's status:

- **`awaiting` — the human is the top rung.** Record one human comment and the board performs
  `awaiting → todo` in the same transaction. Do not move it again — an extra `issue move`
  is a second, unaudited act.
- **`in_progress` — an agent question that stopped a worker.** A human comment settles the
  question but leaves the card `in_progress` with its worker stopped. After recording the
  answer, move the card `in_progress → todo` yourself so the queue can dispatch it again. Show
  both writes as one act.
- **`blocked` — the loop's hold.** The loop parked the card (`blocked_reason=decision`) and
  posted its question. A comment does not move a blocked card: record the answer, then release
  it `blocked → todo` so the loop can dispatch it again. Show both writes as one act.

```bash
taskctl --as-human comment add <ref> --kind note --body "<the human's answer>"
taskctl --as-human issue move <ref> todo        # in_progress and blocked questions only
```

Show the exact body and both commands before writing. A "yes" to a recommendation is recorded
as **that recommendation plus yes**, never paraphrased or enriched; where the human typed their
own words, keep them. "You decide" or "go with your recommendation" is that same yes — still
show the literal body, and do not invent options beyond the round you presented. Default
`--kind note`;
`decision`/`confirm`/`change` is an explicit record marker, not a requirement — the resume is
judged by the content. A claim-cycle exit **interrupts the turn**; the next claim is a fresh
worker that re-reads the comments (ADR 0017).

If the human answered in the board UI (`discuss`), that is already an answer: do not duplicate
it. Verify with `comment list` and report the card's new status.

Full protocol, including the round shape and the one-comment rule:
[`references/answering.md`](references/answering.md).

## 4. Accept a delivered card (`in_review → done`)

Acceptance is an act, not a status read. Before offering it:

1. Read `issue get <ref> --json --include comments --include reports` and the card's
   `acceptance_mode`.
2. Check the **current delivery round** has a report that covers every frozen `acceptance[]`
   item with `met`/`not_applicable`. A missing item, a `partial`/`not_met`, or a missing report
   is a reason not to accept.
3. For a reviewed card, read the review card's current verdict. An `APPROVE` is the evidence;
   an open review on a `human` card is `REVIEW_PENDING`.
4. Show what they are accepting: title, round, report summary, coverage, verdict. Then show the
   exact close:

```bash
taskctl --as-human issue move <ref> done
```

A `human` card is the human's to close after its review finishes. On an `auto` card the loop
normally closes it after an `APPROVE`; a human may still close it, but say so and confirm the
verdict first. A review card
is closed by a human or any actor but its own verdict author — never by the one who wrote it.
`canceled` is abandonment: never cancel a card to close it. A cancel interrupts any running
turn; the board and drawer confirm first (TP-0125).

On a refusal, read `error.code`: `ACCEPTANCE_FORBIDDEN` (wrong closer for the mode),
`ACCEPTANCE_UNVERIFIED` / `ACCEPTANCE_INCOMPLETE` (the gate or the evidence),
`REVIEW_PENDING` (open review on a `human` card), `ROLLUP_REQUIRED` / `ROLLUP_STALE` (epic).
Translate it, say what would make it pass, and stop. Never force it, never touch the database.

Details: [`references/acceptance.md`](references/acceptance.md).

## 5. Read the loop's health, and triage what is abnormal

`taskctl doctor --json` is one read-only inspection. Start at `attention_reasons`; an empty
list is a healthy answer, not a reason to invent one. Health is not part of watch mode: a watch
announces waiting cards only; health stays a one-shot read or an answer to a direct question.

| Row | What it means | What you do |
|---|---|---|
| `stuck_cards` | stale or unreadable heartbeat on a claimed card | name the holder and the age; the loop owns recovery — never heartbeat or steal for it |
| `undispatched_claims` | a stale claim whose handoff rows are all terminal (or absent) | show the last row's status/attempts/error; only a human move frees the card |
| `blocked_acceptance` | the board refused the close | show the refusal; offer a release only when the human says the blocker is gone |
| `handoff_unconsumed` | an accepted producer's required handoff has no decision for its round | report; the director creates the proposed card, or the human records that none is needed |
| `looping` | rework rounds, review reopens, dispatch retries, failed subagents, landing conflicts, and `held` cards the loop already parked | explain the loop; the fix is a decision (reject, cut scope, reassign), not a retry — a held card is released only by an explicit human move; a landing conflict is already back in the worker's hands |
| `unlanded` | a `done` card whose lane branch is not in the project's current branch | report it; the fix is a git merge, not a board write |
| `workers` | blocked, stale or missing-worktree worker records | report; do not restart daemons |
| `queue` | failed dispatch rows | report; the loop retries within its own budget |
| `waiting.in_review` | delivered cards awaiting acceptance | feed the waiting register |
| `board.truncated` | the read is a lower bound | say so; do not present it as the whole board |

A `blocked` card is a board read: `issue list --status blocked --json` and `issue get <ref>
--json` give its `blocked_reason`, age and assignee. A `blocked_reason=decision` hold is also a
register item — `questions[]` carries it as `kind: "blocked-decision"` — because the human owes
both the answer and the release. A `blocked_reason=external` card is a register item too —
`kind: "blocked-external"` — because only an operator can move it. Every other block is report
only — never unblock it behind the human's back.

Corrective board edits — releasing a card, requeueing a stopped one, reassigning — are the
human's call: when they authorize one, §6's shown-then-write rule applies. Never unblock a
card, retry a dispatch or move anything behind the human's back, and never restart a daemon
or edit loop state. Field-by-field map and the triage playbook:
[`references/console.md`](references/console.md).

## 6. Small board edits the human asks for

- **Release backlog.** `backlog → todo` is the only forward edge; `in_progress` belongs to a
  claim. Move only on request, and assign an owner only when the human names one. An epic is
  released but never claimed; its children are.
- **Other edits** — reassign, re-prioritise, relabel, reopen, cancel, link relations — are the
  board skill's commands. Read the refusal rather than pre-checking from a document.
- **Start a multi-role epic.** Use the `meerkat` skill's graph recipe
  (`references/scenarios/epic.md`) as the human (`--as-human`), showing the whole graph before
  any card is created. A project with no `docs/agents/epic-graphs.md` is pointed at
  `setup-meerkat`; no graph is invented here.

Every one is shown first, verbatim, and confirmed.

## Write discipline

1. **Show, then write.** Print the exact command and body, get agreement, then run it.
2. **One write, one card.** Do not bundle several cards into one confirmation.
3. **Re-read after every write** and report the new status and `version`. A write whose result
   you did not read is a guess.
4. **Retry only what the board says is retryable.** `VERSION_CONFLICT`: re-read once and retry
   with the fresh `--if-version`. `DB_BUSY`: wait `Retry-After`. Everything else is a changed
   request, not a retry.
5. **The comment is the record.** The in-session question is only the front end; the board
   stores the human's words, append-only.

## Where to look

| Topic | Read |
|---|---|
| doctor and console payloads, the abnormal-card playbook | [`references/console.md`](references/console.md) |
| finding a question, decision rounds, comment kinds, requeue rules | [`references/answering.md`](references/answering.md) |
| acceptance modes, the current-round gate, review cards, refusals | [`references/acceptance.md`](references/acceptance.md) |
| watch mode: event clock, dedupe, changed-set reporting | [`references/watch.md`](references/watch.md) |
| every command and flag | [`../meerkat/SKILL.md`](../meerkat/SKILL.md) and its `references/` |
| routing, worker questions, E1–E5, decision authority | [`../meerkat-director/references/decision-policy.md`](../meerkat-director/references/decision-policy.md) — the director skill itself is supervisor-only ([`../meerkat-director/SKILL.md`](../meerkat-director/SKILL.md)); humans never invoke it |
