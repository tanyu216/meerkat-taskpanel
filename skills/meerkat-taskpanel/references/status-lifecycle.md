# The task lifecycle — statuses, transitions and constraints

> **Scope.** One card's state model: statuses, legal transitions and their guards, the
> delivery gate and its round counter, claims/heartbeats, containers, acceptance,
> creation, refusals, and the board's workflow decisions. `cli.md` is the command surface;
> `card-schema.md` is the card file.

> **A `src/…` path is provenance, not a location in this skill.** It names a file in the
> taskpanel source repository where a fact is *defined*. An installed copy ships only
> `SKILL.md`, `references/` and `scripts/`; everything you *run* goes through `taskctl`.

The whitelist's source is `src/core/domain/status.mjs` (`ALLOWED_TRANSITIONS`,
`EPIC_ONLY_TRANSITIONS`); the database re-encodes it as `tr_tasks_transition`
(`0024_epic_deliver_from_todo.sql`). `test/contract/state-machine.test.mjs` walks every
ordered pair for every kind through both, and `test/skill/loop.test.mjs` guards this page
against drift.

---

## 1. The vocabulary

A card has **eight stored status words**, but only **seven are stages** — the board's
columns:

| Stage status | Meaning |
|---|---|
| `backlog` | Not released for work; a dispatcher or human moves it to `todo`. |
| `todo` | Released and waiting. The only status a card can be claimed from. |
| `in_progress` | Being worked. Holds the claim; a heartbeat keeps it fresh. |
| `in_review` | Evidence attached, awaiting a verdict. The delivery gate lands here. |
| `blocked` | Cannot proceed on its own; `blocked_reason` says what it waits for. |
| `done` | Accepted. Terminal. |
| `canceled` | Abandoned. Terminal. |

`awaiting` is the **eighth literal but not an eighth column**: an *attention overlay* on an
in-progress card that has stopped to ask a human a question, displayed under `in_progress`.

Two more facts:

- **`done` and `canceled` are terminal** — no reopen command or transition. More work means a
  **new card** (the idempotency key is released at terminal).
- **Read aliases exist in the card file only.** `ready→todo`, `failed`/`cancelled→canceled`,
  `in-review→in_review`, `in-progress→in_progress` are handled by the markdown
  importer/exporter; the command surface rejects them (`issue move <ref> in-review` is
  `VALIDATION_FAILED`). See `card-schema.md`.

`kind` changes one thing: an **`epic`** has one extra edge (`todo → in_review`) and is never
claimable. A **`deploy`** card follows the ordinary `task` table — claimable, but never
offered by `issue candidates`.

---

## 2. The whitelist

Only these moves exist; every other ordered pair is refused — `INVALID_TRANSITION`, or
`TERMINAL_STATE` out of `done`/`canceled`.

<!-- status-whitelist:begin -->
```text
backlog     → todo, canceled
todo        → backlog, in_progress, blocked, canceled        (an epic also → in_review)
in_progress → in_review, blocked, todo, canceled, awaiting
awaiting    → in_progress, canceled
in_review   → done, in_progress, blocked
blocked     → todo, in_progress, in_review, canceled
done        → (terminal)
canceled    → (terminal)
```
<!-- status-whitelist:end -->

### What is not a transition

- **`x → x` is not a transition.** `assertTransition` rejects it even though the SQL trigger
  does not fire on a no-op write. Recover a stale `in_progress` claim with `issue claim`, not
  a move.
- **An unknown status word is `VALIDATION_FAILED`**, not `INVALID_TRANSITION` — outside the
  vocabulary, not a forbidden pair.
- **`in_review → canceled` does not exist.** It takes two moves: `→ in_progress` or
  `→ blocked`, then `→ canceled`. Both exits from `in_review` bump the round (§4), so the
  first hop starts a new round even if you cancel immediately.
- **Only an `epic` in `todo` may go to `in_review`** — the exception is scoped to `kind`, not
  status.

---

## 3. The guard on each edge

A pair on the whitelist can still be refused; the target decides which guard applies.

| Target | What must be true as well |
|---|---|
| `backlog` | Nothing; leaving the work cycle releases the claim. |
| `todo` | Nothing; the card must be claimed again. |
| `in_progress` | From `todo` this **is a claim**: the assignee, or an audited `--allow-steal --reason` of at least 8 characters; an `epic` is refused (`not_claimable`) despite the table. From `in_review`/`blocked` it is **rework/unblock** — keeps the executor, skips the routing lock. From `awaiting` it is a **resume** (a human replied); the round does not move. |
| `in_review` | The **delivery gate**: a `delivery` report for the current `delivery_round`, or an audited waiver for that round (§4). `blocked → in_review` and the epic-only `todo → in_review` pass it too. Every child must be terminal (`CHILDREN_OPEN`). |
| `blocked` | `--blocked-reason` is **optional** — absent is legal, not `unknown`. Entering `blocked` does not bump the round; **`in_review → blocked` does** (a blocker found at review is rework). |
| `awaiting` | The only entry is `in_progress → awaiting`, naming the question class: `--awaiting-reason E1`…`E5`. Leaving clears the reason. `awaiting → blocked`/`in_review`/`done` are forbidden. |
| `done` | Only from `in_review` — **acceptance**, not delivery, so the gate is not re-consulted. The writer must be allowed by policy and scope (§7); every child must be terminal (`CHILDREN_OPEN`). A human closing a top-level card needs the current round's review cards resolved (`REVIEW_PENDING`). |
| `canceled` | From `backlog`, `todo`, `in_progress`, `awaiting` or `blocked` — **never directly from `in_review`**. Terminal. |

### The order the guards run

`issue move` evaluates them in this order. The first refusal wins, so the error you see is
stable even though the database triggers are unordered:

1. waiver shape (`--no-report` only to `in_review`, never with a report, reason at least 8
   characters);
2. the `awaiting` / `blocked` reason vocabulary;
3. the whitelist (`INVALID_TRANSITION` / `TERMINAL_STATE`);
4. for `done`: acceptance authority (`ACCEPTANCE_FORBIDDEN`);
5. for `in_review` and `done`: children terminal (`CHILDREN_OPEN`);
6. for `todo → in_progress`: the claim gate (`not_assignee`, `EXECUTION_ACTIVE`,
   `CLAIM_LOST`, `not_claimable`);
7. for `in_review`: the delivery gate (`REPORT_REQUIRED`);
8. for `done`: the human/top-level review check (`REVIEW_PENDING`);
9. the compare-and-swap write (`VERSION_CONFLICT` on a stale `--if-version`).

Database triggers re-check the hard invariants afterwards; where two could match one write,
this order is what a `taskctl` caller sees.

---

## 4. The delivery gate and the delivery round

A card may not enter `in_review` without evidence **for the current delivery round** — a
report counts only for the round it was written in.

### What counts

- A report with `origin: "delivery"` for the card's current `delivery_round`.
- Markdown-imported reports (`origin: "import"`) are **history**; they never open the gate.
- The escape hatch is the **audited waiver**: `--no-report --reason "<why>"` on a move to
  `in_review` (or on `issue deliver`). The reason needs at least **8 characters** after
  trimming; the waiver is stamped on the task row, recorded as a `report_waived` activity
  and shown in `issue get` under `report_waivers[]`. It covers only its round.
- `--no-report` and `--report-file` are mutually exclusive; `--no-report` anywhere else is
  `VALIDATION_FAILED`.

### The round counter

| Move | Round |
|---|---|
| create | `1` |
| entering `in_review` | unchanged |
| `in_review → in_progress` | **+1** |
| `in_review → blocked` | **+1** |
| `in_review → done` | unchanged |
| `awaiting → in_progress` | unchanged |
| everything else | unchanged |

A rework voids the previous report **and** waiver; the next delivery needs fresh evidence.

### The compliant path

```bash
taskctl report template <ref>                 # fill the TODO lines
taskctl issue deliver <ref> --report-file -   # report + move, one transaction
```

`issue deliver` writes the report and moves atomically. The CLI has no `--to` — it always
lands in `in_review`. (The HTTP `deliver` route accepts a wire-only `to`, including `done`;
acceptance authority still applies.) A report with an explicit non-current `round` is
`REPORT_ROUND_MISMATCH` — a report-write error, not a move refusal.

A refusal names the round and the command that fixes it:

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
```

---

## 5. Claims and heartbeats

- **Only `todo` is claimable.** `todo → in_progress` and `issue claim` are the same path;
  `issue claim` accepts only `todo`/`in_progress`, anything else is `INVALID_TRANSITION`.
- **An `epic` is never claimable** (`not_claimable`). A **`deploy`** card is claimable but
  withheld from every `issue candidates` pool — dispatch it explicitly.
- **A rework is not a claim.** `in_review → in_progress` and `blocked → in_progress` keep the
  claim and skip the routing lock.
- **Held** in `in_progress`, `awaiting`, `in_review` and `blocked`; the write reaching
  `todo`, `backlog`, `done` or `canceled` releases it. No separate unclaim command.
- **Heartbeat only in `in_progress`, only from the holder.** It refreshes `heartbeat_at` and
  nothing else. An `epic` has nothing to pulse (`INVALID_TRANSITION`).

### The three time windows

| Question | Threshold |
|---|---|
| The holder may re-claim with `issue claim` | heartbeat **older than 10 minutes** |
| `issue candidates --stale` offers `stale_same` | heartbeat **older than 30 minutes** |
| Anyone may take over | heartbeat **older than 6 hours**, or none usable |

Another actor's fresh claim is `EXECUTION_ACTIVE`; past six hours (or with no heartbeat) any
actor may take the rotted claim as an audited takeover.

### The `depends_on` read rule

`issue candidates` withholds a card whose `blocks` predecessor is not `done` — literally
`status !== "done"`, so **a `canceled` predecessor withholds too**. This is a *read* rule:
`issue claim`/`issue move` do not re-check blockers. Treat the candidates read as the rule;
do not use an explicit claim to step over it.

---

## 6. Containers (`epic`)

An epic is a container: no work of its own; a human's card is always a `task` unless someone
named an epic.

- **Never claimable.** `issue move <epic> in_progress` is `not_claimable` — the table allows
  the pair, the claim gate refuses it.
- **The board starts it.** The first child to enter the work moves the container
  `todo → in_progress` — a board move (actor kind `taskd`, no claim) with an
  `epic_auto_start` activity and a `kind=note` comment naming the child. Only from `todo`; a
  `backlog` epic is not auto-started.
- **The board closes it to `in_review`, never `done`.** When every child is terminal
  (`done`/`canceled`), at least one is `done`, and there is delivery evidence to roll up,
  the board writes the rollup report and moves the epic to `in_review`. Auto-close works from
  `todo`, `in_progress` and `blocked`; acceptance to `done` stays a separate act.
- **Nothing delivered, nothing to close.** If every child was canceled or every delivered
  child was waived, close it by hand: `report template`, then `issue deliver`.
- **`todo → in_review` is the epic-only repair edge** for a child attached after the
  container finished; it still passes the delivery gate.
- **No parent closes over an open child.** A parent may not enter `in_review`/`done` while
  any child is non-terminal (`CHILDREN_OPEN`) — the automatic rollup and the manual move share
  the predicate.

`issue reconcile` replays the start/close rules over every non-terminal epic and is
idempotent; the ordinary path does not need it.

---

## 7. Acceptance: policy × scope

`done` is the board's acceptance act; who may perform it depends on the board's acceptance
policy and the card's scope.

| Scope | `human-only` | `both` (default) | `agent-only` |
|---|---|---|---|
| `top_level` | human only | human or `taskd` | any non-human |
| `review` card | human or `taskd` | human or `taskd` | any non-human |
| `child` (has a parent) | any non-human | any non-human | any non-human |

Scope precedence is **`hasParent` > review marker > `top_level`**: a review card that somehow
acquired a parent is treated as a child.

- A worker agent delivers to `in_review` and **does not close a top-level card** under the
  default policy (`ACCEPTANCE_FORBIDDEN`).
- A **child** card is the opposite: only a non-human writer may close it.
- A review card is closed by a human or the board (any non-human under `agent-only`).
- `REVIEW_PENDING` applies only when a **human** closes a **top-level** card, and only to the
  **current round's** review cards; `taskd` is exempt because the loop writes the original
  before the review card.
- `--actor-kind human` is reserved and refused; a human write uses `--as-human` (id from
  `$TASKCTL_HUMAN`). The board trusts declared attribution — a service rule, not
  authentication.
- The policy comes from `TASKD_ACCEPTANCE_POLICY` / the environment / `<dataDir>/taskd.env`,
  defaulting to `both`.

---

## 8. Creating a card in a status

`issue create` defaults to `todo` and applies an INSERT-shaped gate:

| Initial status | Result |
|---|---|
| `backlog`, `todo`, `blocked`, `canceled` | allowed for a `task` |
| `in_progress` | `VALIDATION_FAILED` — create it in `todo`, then claim it |
| `awaiting` | `VALIDATION_FAILED` — a card is not born waiting |
| `in_review`, `done` | `REPORT_REQUIRED` — there is no evidence yet |
| an `epic` in anything but `backlog` / `todo` | `VALIDATION_FAILED` |

The markdown importer is the deliberate exception: it writes history directly, importing
`in_review`/`done` cards (`origin: "import"`); imported reports never satisfy a later delivery
gate.

---

## 9. Refusals

| Code | HTTP | When |
|---|---|---|
| `INVALID_TRANSITION` | 409 | The pair is not on the whitelist; `PATCH {status}`; heartbeat on a non-`in_progress` card; `issue claim` on a status other than `todo`/`in_progress`. |
| `TERMINAL_STATE` | 409 | The source is `done` or `canceled`. |
| `REPORT_REQUIRED` | 422 | Entering `in_review` without a current-round delivery report or waiver; creating in `in_review`/`done`. |
| `ACCEPTANCE_FORBIDDEN` | 409 | The writer may not move the card to `done` under the policy/scope matrix. |
| `CHILDREN_OPEN` | 409 | `in_review` or `done` while a child is non-terminal. |
| `REVIEW_PENDING` | 409 | A human closing a top-level card with current-round review cards still open. |
| `VALIDATION_FAILED` | 400 | Unknown status; create in `in_progress`/`awaiting`; an epic's illegal initial status; an unknown `awaiting_reason`/`blocked_reason`; a malformed waiver. |
| `VERSION_CONFLICT` | 409 | `--if-version` does not match the card's version. |
| `EXECUTION_ACTIVE` | 409 | Another actor holds a fresh claim, or a non-holder sends a heartbeat. |
| `CLAIM_LOST` | 409 | The claim's compare-and-swap lost a race. |
| `not_assignee` | 409 | A first claim of somebody else's `todo` card without `--allow-steal`. |
| `not_claimable` | 409 | A claim on an epic. |
| `EXECUTION_STATE_CORRUPT` | 500 | An `in_progress` **work card** has no holder. An unowned `in_progress` **epic** is the designed auto-start state, not corruption. |
| `REPORT_ROUND_MISMATCH` | 409 | A report names a round other than the card's current round, or duplicates `(task, round)`. |

`status` is a **move, never a patch**: `issue update` has no `--status`, and `PATCH {status}`
is refused with `INVALID_TRANSITION` plus a hint to use `issue move` or `issue deliver`.

---

## 10. What the board enforces, and what is practice

Not every rule here is a database constraint — the distinction matters when judging a
workaround.

| Rule | Enforced by |
|---|---|
| The transition whitelist | domain `ALLOWED_TRANSITIONS` + DB trigger `tr_tasks_transition` |
| The delivery gate | domain `delivery-gate.mjs` + DB trigger `tr_deliver_gate` |
| Terminal statuses never leave | domain + DB trigger `tr_tasks_terminal` |
| Children terminal before a parent closes | service + DB trigger `tr_tasks_children_terminal` |
| Acceptance authority | **service only** — the actor is not a column, so no trigger can see it |
| Claim routing and freshness | service + compare-and-swap |
| Heartbeat holder and status | repository `setHeartbeat` |
| “One card at a time” | **practice** — the board does not enforce it |
| “Read candidates, then claim” | **practice** — the board enforces only the claim gate |
| “Do not claim released `backlog` work” | **practice** — `backlog` is not claimable, but releasing it is a human/dispatcher act |
| `deploy` cards are never auto-offered | **read rule** — an explicit dispatch may still claim one |
| `depends_on` blocks claiming | **read rule** — candidates filters; the claim verb does not re-check |
| The `awaiting` payload is a human comment | **read model** — resume reads a human comment |

---

## 11. The board's workflow decisions

The board decides what happens after a delivery; the loop executes. The decision surface is
one command:

```bash
taskctl issue reconcile --workflow [--dry-run]
  [--reviewer <agent>] [--auto-accept-reviews yes|no]
  [--review-aging-ms <n>] [--max-actions <n>]
```

Without `--workflow`, the command only reconciles containers (the historical behaviour). With
it, the board:

1. performs its own container reconcile (unless `--dry-run`);
2. reads a bounded board snapshot;
3. returns a plan: `{alerts, actions, changes, summary}`.

Actions are decisions, not effects. The **loop** executes `create_review`, `approve`,
`approve_hold`, `reject_task`, `reject_epic`, `reject_task_finish`, `close_review` and
`cancel_review`; the review card closes **last**, so a crash between moving the original and
closing the review card is recovered next pass. The board never moves a review card.

The fail-safe rules are part of the decision:

- an unreadable verdict, a stale round, a conflicting verdict, or a report not written by the
  configured reviewer produces an **alert and no write**;
- a **truncated** snapshot applies outcomes but **dispatches nothing**;
- **one review card per `(original, delivery round)`**, keyed `loop-review|<ref>|r<round>`;
- a delivery on flow B (a review card) is never itself reviewed;
- self-review is refused: the reviewer may not be the card's assignee/holder;
- `autoAcceptReviews = no` only withholds the review card's close; the verdict on the
  original is still applied;
- the board's acceptance policy decides `approve` vs `approve_hold`; the loop's
  `--acceptance` is an advisory copy, not the authority.

`approve` actions carry the acceptance marker (`acceptedBy: loop-review`) and `approve_hold`
actions carry `held` (whether the card already has the hold marker), so the loop's executor
never needs to re-read a task snapshot or re-derive a decision.

---

## 12. Choosing a status

- Not released → `backlog`.
- Released, not started → `todo`.
- Working → `in_progress` (a claim).
- Stopped to ask a human a question → `awaiting` with `E1`–`E5`; put the question in a
  comment.
- Stopped on anything else → `blocked`, with an optional `--blocked-reason`.
- Evidence attached, awaiting a verdict → `in_review` (`issue deliver`).
- Accepted → `done`, by whoever the policy/scope matrix allows.
- Abandoned → `canceled`; from `in_review` that is two hops.
- “Reopen” → there is no reopen. Create a new card.

`awaiting` is not `blocked`: `blocked` is the card's own declaration that it cannot proceed;
`awaiting` is a question addressed to a human. `blocked_reason` is optional and cleared on
exit; `blocked_at` is kept because it dates the last blockage. The reason vocabulary and the
card-file rules are in
[`card-schema.md`](card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).

---

## 13. Provenance

- The whitelist: `src/core/domain/status.mjs` — `ALLOWED_TRANSITIONS`,
  `EPIC_ONLY_TRANSITIONS`, `TERMINAL_STATUSES`, `ROUND_BUMPING_EXITS`,
  `CLAIM_HOLDING_STATUSES`.
- The delivery gate: `src/core/domain/delivery-gate.mjs` and the SQL trigger in
  `src/core/storage/migrations/0024_epic_deliver_from_todo.sql`.
- The command-side guards: `src/core/commands/tasks.mjs`, `acceptance.mjs`, `rollup.mjs`.
- The workflow decisions: `src/core/domain/workflow.mjs` (pure) and
  `src/core/commands/workflow.mjs` (the snapshot assembly).
- The command surface: [`cli.md`](cli.md).
