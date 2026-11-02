# The console: one read of the board, one read of the loop

Two commands answer "what is happening" and "what needs the human". Both are read-only, both
are local, and neither needs `--actor-kind` or a session identity. Run them with `--json`; the
human output is for a person reading a terminal, not for a decision.

```bash
taskctl loop console --json   # questions waiting on a human + delivered cards
taskctl loop doctor --json    # the daily inspection: attention, stuck, looping, workers
```

## `loop console --json`

The human-owned queue, already filtered to what is actually unanswered.

```json
{
  "ok": true,
  "supervisor": { "...": "the same verdict `loop status` prints" },
  "questions": [
    {
      "ref": "PROJ-0042",
      "title": "…",
      "status": "awaiting",
      "awaiting_reason": "E3",
      "question": "…",
      "asked_at": "2026-11-01T09:12:00.000Z",
      "kind": "awaiting",
      "age_ms": 3720000,
      "answered_pending_release": false
    }
  ],
  "pending_acceptance": [{ "ref": "PROJ-0041", "title": "…", "priority": "medium" }],
  "errors": []
}
```

- `kind: "awaiting"` — the card is parked on a human question. A human comment resumes it.
- `kind: "agent-question"` — an `in_progress` card carries a worker question the director has
  not settled. The card needs a requeue after the answer (see
  [`answering.md`](answering.md#answer-an-in_progress-agent-question)).
- `age_ms` is how long the question has waited (working time in the SLA sense is the
  board's, not this field). `answered_pending_release: true` means a later human comment
  exists but the card is still `in_progress` — the **director owes the release**; do not
  answer the human's reply again.
- `pending_acceptance` is a reading, not a claim about who owes the act. Cross-check each card's
  `acceptance_mode`: `human` is the human's; `agent` and `off` are normally the loop's or the
  deliverer's.
- `errors[]` is non-empty when a board read failed. Say that; do not fill the gap with a guess.

A question answered in the board UI is already settled. If a stale snapshot still lists it,
`comment list` shows the human comment; do not ask again.

## `loop doctor --json`

One read-only inspection. Start with `attention` and `attention_reasons`; read the specific rows
only for what the human asks about or what the reasons name.

| Key | Meaning | Chat's move |
|---|---|---|
| `attention` / `attention_reasons` | any row below is non-empty | lead with the reasons, in the human's language |
| `ok` | false when a read failed or a project was skipped | report the failure, not health |
| `supervisor` | the loop's verdict (`healthy`, `partial`, `absent`, …) | absent/partial means the loop is not fully running; report, never start it |
| `agents`, `roles` | the resolved scan set and where each role is installed | report a stranded role only when the human asks |
| `patrol` | last-successful patrol marker, age, cadence, `overdue` | `overdue` is a health finding; report it |
| `board` | `total`, `counts` by status, `truncated`, `error` | `truncated` makes every count a lower bound |
| `log` | the bounded tail of the loop log | quote only the lines that explain the finding |
| `queue` | `depth`, `pending`, `processing`, `failed` | failed rows are the loop's to retry; report |
| `subagents` | live and total subagent rows | context for a stalled fleet |
| `stuck_cards` | stale or unreadable heartbeat on claimed cards | name holder and age; never heartbeat or steal |
| `looping` | cards going round the same loop, including `held` cards the loop already parked (`meta.loop_hold_code`, blocked) | explain the pattern; the fix is a decision — never move a held card back without one |
| `looping.awaiting` | cards parked on a human question (`awaiting_reason`, age) | surface them in the human's waiting register |
| `looping.question_lane` | director rows that exhausted their two attempts (question or route) | explain the failed turn; a route card is parked, a question card still waits |
| `looping.unowned` | `todo` cards nobody owns past the route window | the routing table has no shape for them — ask the human to assign |
| `looping.orphaned` | processing rows whose agent child outlived twice the turn bound | report; do **not** re-dispatch the card under a live child |
| `waiting.in_review` | delivered cards awaiting acceptance | feed the human's waiting register |
| `blocked_acceptance` | the board refused a close; the card still carries the marker | show the refusal and what it demands |
| `unlanded` | `done` cards whose lane branch is not in the project's branch | report; the fix is a git merge |
| `workspaces` | stale workspace registry records | report |
| `workers` | blocked, stale, missing-worktree worker records | report; never restart a daemon |
| `errors`, `skipped` | reads that failed, projects that could not be inspected | these are findings too |

## The abnormal-card playbook

**Stuck (`stuck_cards`).** The holder's heartbeat is older than the stale bound, or unreadable.
Show the card, the holder, the last heartbeat and what is left. The thresholds (re-claim by the
holder, the stale pool, takeover) are the board skill's
[§5](../../meerkat/references/status-lifecycle.md#5-claims-and-heartbeats); quote them rather
than inventing a number. Do not heartbeat, re-claim or steal — the loop owns stale recovery,
and a chat-side pulse would hide the problem. If the human asks to recover it, the director's
operational rules apply, not yours.

**Blocked.** Read `issue list --status blocked --json`; for each, `issue get <ref> --json` and
`relation list <ref> --json`. Show `blocked_reason`, the open `blocked_by` predecessor and the
age. Never unblock a card behind the human's back: when they confirm the blocker is gone,
`taskctl --as-human issue move <ref> todo`.

**Blocked acceptance (`blocked_acceptance`).** The card was moved toward `done` but the gate
refused, and the marker stayed. Read the current report and the last comments; name the missing
or failing acceptance item. The fix is evidence or a rework, not a retry of the move.

**Looping (`looping`).** The heuristics are review thresholds, not verdicts: a rework round
count, repeated review reopens, repeated dispatch rows, repeated failed subagents. Explain which
pattern fired and what it usually means (a requirement nobody can satisfy, a review disagreeing
with the plan, a worker that cannot start). The next act is a human decision — reject, cut scope,
reassign, or fix the environment.

**Unlanded (`unlanded`).** A card is `done` but its lane branch is not in the project's current
branch. Report the branch and the worktree path. The fix is a merge in git; chat never merges.

**Workers (`workers`).** A worker record that is blocked, stale, or points at a missing worktree.
Report the key, card and last error. Do not stop, start or restart the pool from here.

**Queue (`queue.failed`).** Handoffs that exhausted their attempts. Report the card and the
error; the loop's budget owns the retry.

**Truncated board.** `board.truncated: true` means the snapshot is capped. Say "at least N";
never present a truncated read as the complete board.

## Presentation

Keep the digest short enough that the human reads it:

```text
Waiting on you:
- PROJ-0042 (awaiting, E3, 3 hours) — question: …; answering it returns the card to todo.
- PROJ-0041 (in_review, acceptance_mode=human) — current-round report covers 4/4 items; waiting for your acceptance.

Worth a look:
- PROJ-0038 heartbeat stopped 41 minutes ago (assignee=linus); the loop's stale recovery owns it, I did not touch it.
- PROJ-0035 is done, but lane/PROJ-0035 is not merged into dev.
```

The order is the human's attention order: questions, acceptance, then health. Each line names
the card, the state and the next act — never just a status word. The example is English for
readability; write the report in the human's language.
