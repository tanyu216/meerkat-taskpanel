# taskctl — cards, delivery and review

> The prose behind the command index in `../cli.md`: the issue group, create, claiming,
> promotion, the delivery gate, awaiting/blocked and review-card fields. Comments, relations,
> attachments, reports, export and the editing commands are `files.md`. The frozen flag table
> is `../cli.md`.

# taskctl — cards, delivery and review

> The prose behind the command index in `../cli.md`: the issue group, create, claiming,
> promotion, comments, relations, attachments, reports, export, editing, the delivery gate,
> awaiting/blocked and review-card fields. The frozen flag table is `../cli.md`.

### `issue`

> The status model — every status, transition and guard — is in
> [`lifecycle/transitions.md`](../lifecycle/transitions.md). This section is the command surface.

| Command | Purpose |
|---|---|
| `issue create` | Create a card. Synopsis and flag semantics: [below](#issue-create). |
| `issue list [--project] [--status <s>]… [--assignee <name>\|--assignee-id <id>] [--parent <ref>] [--kind <kind>] [--label <label>]… [--target <value>] [--meta <key>=<value>]… [--review-of <ref>] [--limit] [--include-archived] [--order-debug]` | List cards. Archived cards are hidden unless `--include-archived` is set. The order is always the assignee weight order (below); there is no sort flag. `--review-of <ref>` returns the **review cards of** that card — not the card itself — across every round (`review_round` is on each returned card, so a caller selecting the current round filters on it). It combines with the other filters and is read-only. An unknown ref is `NOT_FOUND`; an identifier that exists in two projects is `VALIDATION_FAILED`. **The further filters are all pushed into SQL** (they hold under `--limit`): `--parent` = that card's children; `--kind` = `task\|epic\|review`, the stored type read literally — `review` returns only the cards that carry the review marker, and `task` no longer returns them (an unknown kind is `VALIDATION_FAILED`); `--label` repeats and every label must be present, matched against the card's **exact display name** (no normalisation, no `labels` registry); `--target` compares `meta.target` as text; `--meta k=v` repeats, every pair must hold, and the key must match `[A-Za-z0-9_.-]+`; `--assignee` resolves a free-text name through the dictionary (an unknown name matches **nothing**, not everything) and is refused together with `--assignee-id`. |
| `issue candidates --assignee <name> [--stale] [--include-unassigned] [--order-debug]` | The claim read: `todo` cards that are auto-claimable (not an `epic`), every `depends_on` predecessor `done` (a `canceled` one also withholds). `--stale` adds the recovery pool (holder after 30 min; the assignee past 6 h; anyone else only with the audited override); `--include-unassigned` adds the public pool. Each row carries the card's route — `assignee` (dictionary display name, `null` when unassigned), `assignee_id`, `assignee_kind` — so a consumer claims as the assignee rather than as the scanner. Read-only; no `--limit`. |
| `issue get <id\|identifier> [--include comments\|reports\|relations\|sessions]… [--limit <n>]` | One card, plus `report_waivers[]` and `attachments[]` (`id`, `filename`, `content_type`, `size`, `kind`, `created_at`, `comment_id`). The human view prints identifier, title, status, priority, kind, labels, assignee, reporter, claimed_by, heartbeat_at, delivery_round, acceptance_mode, review_of (the reviewed card's identifier), review_round, parent, awaiting_reason, acceptance_revision, the numbered acceptance snapshot (`none (vacuous)` when empty), meta as JSON, the description and version, then a waiver row and an attachment table when present. `--json` carries the same fields: `acceptance[]` is the **frozen baseline**; `meta.acceptance` is only its seed; `role` is the readable word (`task\|epic\|review`) and `kind` is the stored type (`task\|epic\|review`). The one divergence is a legacy `meta.review_of`-only row whose mirror cannot be resolved: it keeps `kind=task` (the documented read-only exception) while `role` still reads `review`. `--include <section>` (repeatable) adds, under the section's own name in `data`, exactly what that command returns: `comments` → `data.comments[]` (newest first; `--limit <n>` caps it, default **50**, `0` = no cap), `reports` → `data.reports[]` (every round), `relations` → `data.relations` (`relation list`'s payload minus `task_id`), `sessions` → `data.sessions[]`. Without `--include` the payload is unchanged. An unknown section, or `--limit` without the `comments` section, is a usage error (exit 2) — never a silent no-op. |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]… [--drop-acceptance <text>]… [--acceptance-revision <n>] [--acceptance-mode off\|auto\|human [--reason "<why>"]]` | Patch. `--status` is refused here on purpose. `--acceptance` **appends** to the frozen baseline (`tasks.acceptance_json`) and is idempotent by criterion text; it cannot remove it. `--drop-acceptance` is **human-only**, needs `--reason` (≥ 8 characters) and the current `--acceptance-revision`; both are audited. `--acceptance-mode` is the single acceptance decision (`off` = no review/direct done, `auto` = independent review then the loop closes on APPROVE, `human` = human-only close after the review finishes); an agent may only tighten `off → auto|human`, and leaving `auto` needs `--reason` and no open current-round review card. The complete edit sequence (append acceptance, replace description, human prune) is [`../scenarios/edit.md`](../scenarios/edit.md). `--if-version` is forwarded and guards the **whole** update: a stale version refuses the write with `VERSION_CONFLICT` before any change, including an acceptance append. |
| `issue move <ref> <status> [--allow-steal --reason "<why>"] [--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--question "<text>"] [--blocked-reason <word>]` | Move, subject to the delivery gate. `todo → in_progress` is a **claim**; a move to `done` is an **acceptance** and requires a current-round report that covers every frozen acceptance criterion — for an **epic**, a current-round rollup (`ROLLUP_REQUIRED` / `ROLLUP_STALE`). `done`/`canceled → todo` is the audited **reopen** and needs `--reason` (prefer `issue reopen`). `--awaiting-reason` is required for `awaiting`; an agent entering `awaiting` must also supply `--question` (or already have an unanswered `question` comment). `--blocked-reason` is optional. |
| `issue reopen <ref> --reason "<why>"` | **Reopen a `done`/`canceled` card to `todo`.** Audited: the reason is required (≥ 8 characters) and recorded as `task_reopened`. Starts a new delivery round, clears the archive and releases the idem key. A review card is refused — reopen the original; the loop issues the next round's review. |
| `issue claim <ref> [--check-blockers] [--allow-steal --reason "<why>"]` | **Claim, re-claim or take over.** On `todo` it behaves like `move … in_progress`; on `in_progress` it is the only recovery path. The holder may re-claim after 10 min; past 6 h the card's **assignee** re-claims it, while any other actor needs `--allow-steal --reason` (the audited override, also a `change` comment). A fresh claim by another actor is `EXECUTION_ACTIVE`. `--check-blockers` is opt-in: the board re-reads the card's `blocks` predecessors and refuses with `BLOCKED_BY_PREDECESSOR` (details carry the open predecessors) when one is not `done`. Claim does **not** re-check by default — the poll (`issue candidates`) already withholds blocked cards, and `issue move … in_progress` remains the caller's own responsibility. |
| `issue heartbeat <ref>` | Pulse a claim you hold. Refreshes `heartbeat_at` and nothing else; holder only; `in_progress` only; takes no flags of its own. |
| `issue wait <ref> [--question <comment-id>] [--timeout <ms>] [--interval <ms>] [--heartbeat <sec>]` | The worker's bounded in-turn hold after it writes an agent `question`. Reads the card and the trail after the question every `--interval` (default 2000 ms); it never claims, moves or comments. `answered` (exit 0) **only** when the card was **released** (`todo`, or a status change after the question, including a released-then-reclaimed card); a `note` — the Director's or the worker's own — does not end the hold, because the settle is the release, not the author. `answer` still carries the bounded newer trail. `escalated` (exit 3) when the card is `awaiting`: park; a human answer resumes the session by id. `moved` (exit 3) when the card left the work states or another actor owns the claim. `timeout` (exit 3) after `--timeout` (default 110000, max 540000): re-invoke once when the runtime allows it, then park; the loop resumes the session when the release lands. `error` (exit 1) after three unreadable reads. While waiting it pulses the caller's own heartbeat every `--heartbeat` seconds (default 240; `0` disables) so the claim stays fresh. A non-zero exit is a **result**, not a failure: read `outcome` from `--json`. |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--reporter-id <id>] [--force-create]` | Assign. `--if-version` is forwarded and refuses a stale write with `VERSION_CONFLICT`. |
| `issue archive <ref> [--days <n>]` | Archive finished work (done/canceled; 7-day window by default). |
| `issue meta <ref> --meta <k>=<v>…` | Merge metadata keys into a card, leaving other keys and their value types intact. The read-modify-write form: `--if-version` is forwarded and refuses a stale merge with `VERSION_CONFLICT`; without it, the version the command read guards the merge. |
| `issue deliver <ref> --report-file <file\|-> [--to done] [--no-report --reason "<why>"] [--seg <seg>]` | **Write the report and move, in one transaction.** The default destination is `in_review`; `--to done` is the `off` card's **direct acceptance** (any other `--to`, and a waiver with `--to done`, are usage errors). The two report forms are mutually exclusive. On an **epic** the report is its rollup: it must name every live child by `ref` (`ROLLUP_STALE` otherwise) and is stored with `is_rollup = 1`; `--no-report` is refused for an epic (`ROLLUP_REQUIRED`). |
| `issue reconcile [--dry-run] [--workflow] [--assignee <agent>] [--review-aging-ms <n>] [--rework-max-rounds <n>] [--max-actions <n>] [--board-limit <n>]` | Without `--workflow`: replay the epic rules over every non-terminal container. With it: return the board's workflow plan (see below). `--dry-run` writes nothing. `--assignee` is the review card's assignee (the role catalog's `default_reviewer`, normally `Reviewer`); `--reviewer` is a deprecated alias. `--rework-max-rounds` bounds the delivery rounds before a loop hold. Idempotent. |

#### `issue create`

```bash
taskctl issue create --project <id> --title <t> [flags]
```

| Flag | Meaning |
|---|---|
| `--project <id>` | **Required.** The project that issues the card; the card is numbered with that project's identifier prefix (declared or id-derived). |
| `--title <t>` | **Required.** The one-line summary. |
| `--acceptance-mode off\|auto\|human` | The card's acceptance decision. `off`: no review; the deliverer may close it directly (`in_progress → done`). `auto`: an independent review card must APPROVE before the loop closes it; this is the fallback when the mode is omitted. `human`: a human closes it after the current-round review finishes. Any explicit value is the whole decision — there is no project default; a project may document its selection guidance in `docs/agents/create-card.md`, which this skill discovers at creation. A review card is always `off`. |
| `--acceptance <text>` | One acceptance item; repeat for each. |
| `--assignee <text>` / `--assignee-id <id>` / `--assignee-kind <agent\|human>` | Route the card. `--assignee-id` bypasses the dictionary. When the local role catalog is non-empty, `--assignee` must name a role in it (see [`role`](#role)); `--force-create` is the documented escape. |
| `--reporter <text>` / `--reporter-id <id>` / `--reporter-kind <agent\|human>` | Set the reporter. |
| `--description <md>` | The markdown description. |
| `--priority <low\|medium\|high\|urgent>` | Urgency; a card with none reads as `medium`. |
| `--kind task\|epic\|review` | The card's stored type; default `task`. `review` is accepted only together with `--review-of` (the marker forces it anyway); a markerless `review` is `VALIDATION_FAILED`. |
| `--label <l>` / `--meta k=v` | Repeatable labels and metadata. |
| `--target <t>` | An opaque per-card value; it is not a directory. |
| `--parent <ref>` | Fills the idempotency key's source slot; it **links nothing** — use `relation add --type parent`. |
| `--status <s>` | Initial status; see [`lifecycle/transitions.md` §8](../lifecycle/transitions.md#8-creating-a-card-in-a-status). |
| `--idem <key>` | Creation idempotency key; a match returns the existing card, keeping its acceptance mode. |
| `--allow-dup` / `--force-create` | Skip the duplicate guard / the fuzzy dictionary step. On `issue create` and `issue assign`, `--force-create` also admits an assignee outside the local role catalog — use it only on an explicit human instruction. |
| `--review-of <ref> [--review-round <n>]` | Create a review card for that original and round. |

**Routing is the handoff.** In a team project `--assignee` is part of the create, not a later
step: the supervisor scans **the role skills it discovers** — installation location is the
routing — so a card assigned to a name nobody scans is never claimed. Read `taskctl role list
--json` first and pick a worker-lane role from `roles[].agent`, using `title`/`summary`/`shapes`
to choose. Pass that one accountable role (`--assignee <role> --assignee-kind agent`) in the
same call. An unassigned card is claimed as `Worker`, or routed by `meerkat-director`; never
invent a role name. With no catalog yet (the supervisor has not run), the range is open and
the same rule applies: name a discovered role. A reviewer-lane role is never routed an
ordinary card; a person is named with `--assignee-kind human`.

### The weight order (every task list)

`issue list` and `issue candidates` are **always weight-ordered**: a hard **tier** (can I move
this card at all?), then a weighted score (priority, time in status, age, SLA pressure, how
many cards this unblocks), then a deterministic tie-break ending on the identifier. A tier is
never traded against a score. There is no sort flag — the order is not optional. Inside
`issue candidates` the claimability bucket stays the first key; the weight order only refines
within a bucket. `--order-debug` adds
`{id, identifier, order, tier, tier_name, score, factors}` to reconcile a rank by hand; the
projection is opt-in and does not change the order.

### Claiming: only the assignee may claim

`issue move <ref> in_progress` on a `todo` card takes the execution lock
(`claimed_by` / `claimed_at` / `heartbeat_at`). The **assignee** is who the card is routed to;
the **claimer** is who is doing it now.

- **Unassigned** cards are an open pool: any actor may claim them.
- An **`epic`** can never be claimed (`not_claimable`); `backlog` is not claimable either.
- A card routed to somebody else is refused on the first claim with `not_assignee`.
  `--allow-steal --reason "<why>"` (reason ≥ 8 characters) is the audited override, valid on
  that first claim only; it records a `task_claimed` activity and a `kind: change` comment.

The holder may re-claim after **10 minutes**. Past **6 hours** the claim has rotted but the
route has not: the card's **assignee** re-claims it as an audited takeover, while any other
actor needs `--allow-steal --reason`. The full threshold table, including the 30-minute stale
pool, is in [`lifecycle/claims.md` §5](../lifecycle/claims.md#5-claims-and-heartbeats).

A **rework** (`in_review`/`blocked → in_progress`) is not a claim: it keeps the existing
executor and their lock. The claim is held in `in_progress`, `awaiting`, `in_review` and
`blocked`, and released by the write that moves the card to `todo`, `backlog`, `done` or
`canceled`. The board runs **no background pulse**; keeping it fresh is the holder's job.

### Promoting an existing card to an epic

`kind` is patchable, and a card filed from the web UI is always a `task`:

```bash
taskctl issue update PROJ-0007 --kind epic
taskctl relation add PROJ-0007 --type parent --target PROJ-0008
```

Only an `epic` may be a parent (`VALIDATION_FAILED`, `details.field: kind`, until promoted).
Neither end of a `parent` edge may be a review card (`VALIDATION_FAILED`,
`details.field: source|target`), even with `--force`. `todo → in_review` is the epic's own
edge. The promotion is an ordinary patch — status, claim, heartbeat and delivery round stay
put — and leaves no comment, so write the split down yourself. An epic that still has children
cannot be downgraded to `task`. The board starts and closes the container; see
[`lifecycle/containers.md`](../lifecycle/containers.md#6-containers-epic).

## The delivery gate

A refusal looks like this:

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
```

`issue deliver` writes the report and performs the move atomically; `report template` prints a
report `deliver` accepts without editing. The second line is the **audited waiver** (reason
≥ 8 characters, stamped on the task row and recorded as a `report_waived` activity). The gate
rule and the round table:
[`lifecycle/delivery.md` §4](../lifecycle/delivery.md#4-the-delivery-gate-and-the-delivery-round).

On an **`agent`** card each `met` item's `note` must cite an anchor from the report's own
`evidence[]`, written `evidence[n]` (1-based). The template seeds the note with
`evidence[1]`, so filling it in is "say what you saw". A `met` with no reference
(`no_anchor`) or one past the end of the list (`dangling_anchor`) is
`ACCEPTANCE_INCOMPLETE` with `details.unsupported`; an empty evidence list makes every
reference dangle. An `off` or `human` card is not held to this rule. An APPROVE on a review
card additionally needs a `{kind: "command", cmd, exit_code}` anchor — the reviewer runs the
gate it records.

The same rule bites **at delivery**: `issue deliver` refuses an anchored-`met` violation the
way `done` would (`ACCEPTANCE_INCOMPLETE`, `details.source = "delivery"`), because a report is
bound to its round and cannot be amended afterwards. Fix the note — or report the item as
`not_met`/`partial` — and deliver again; nothing is written on a refusal.

## The `awaiting` state — asking a human a question

A card that needs an answer from a person is **`awaiting`**, not `blocked` and not a chat
message. It is an overlay on a running card: entering or leaving it does not start a delivery
round.

`in_progress → awaiting` is the **only** entry, and it must name the question class:

```bash
taskctl issue move PROJ-0007 awaiting --awaiting-reason E3
```

| Code | The question is about |
|---|---|
| `E1` | scope |
| `E2` | the acceptance baseline |
| `E3` | design / aesthetic direction |
| `E4` | security / data safety |
| `E5` | architecture direction |

Without the flag the CLI refuses as a usage error (exit 2); the service refuses an unusable
value with `VALIDATION_FAILED` (`details.field` = `awaiting_reason`). The reason is stamped on
the card while it is `awaiting` and cleared on exit. An agent must also ask the question
(`--question`, or an already-unanswered `question` comment) — `QUESTION_REQUIRED` otherwise.
Read the set with `issue list --status awaiting`; the web board's **waiting** view is the same
set. Entry, exits and the resume rule: [`lifecycle/transitions.md` §1](../lifecycle/transitions.md#1-the-vocabulary).

## The `blocked` state — what the card is waiting for

`blocked` is the other stop: the card cannot proceed, but nobody has been asked a question.
`--blocked-reason` says **what** it waits for so a reader need not open the comment trail.

```bash
taskctl issue move PROJ-0007 blocked --blocked-reason dependency
```

Unlike `--awaiting-reason` it is **optional**; an unset value reads as `clarify`. The value is
one of eight literals — `clarify`, `decision`, `dependency`, `out_of_bounds`, `defect`,
`external`, `resource`, `unknown` — trimmed, never free text (`VALIDATION_FAILED` otherwise).
`unknown` is not the spelling of "no reason": it is a writer saying there is a block they
cannot classify. The reason is stamped while `blocked` and cleared on exit; the card's
`task_moved` activity keeps it afterwards. The table and import rules are in
[`schema/blocked-reason.md`](../schema/blocked-reason.md#blocked_reason--what-a-blocked-card-is-waiting-for).

## Review cards — the declared fields

A review card names the original it audits through the **declared** create fields:

```bash
taskctl issue create --project PROJ --title "Review PROJ-0007" \
  --assignee <reviewer> --assignee-kind agent --label review \
  --review-of PROJ-0007 --review-round 1 --meta flow=B
```

`--review-of` takes an identifier or an id; `--review-round` is a positive integer and requires
`--review-of`. When given, `--review-round` must equal the original's **current**
`delivery_round`; omit it only for a legacy round-agnostic review. The board resolves both,
stores `review_of_id` / `review_round`, and mirrors `meta.review_of` / `meta.review_round`
itself. One review card per `(original, delivery round)`; the loop's idempotency key is
`loop-review|<ref>|r<round>`.

Four creation invariants (`VALIDATION_FAILED`): `review_of` must name a card that is
`in_review` (deliver the original first); `review_of` may not name another review card;
`review_round` may not be stale or future; and a review card is `kind=review` (the marker
forces it; an epic cannot be claimed, so an epic review card would never be woken). A review card in `in_review`
is canceled in one move: `in_review → canceled` (TP-0125). Detection and the two-round model:
[`review-protocol.md`](../review-protocol.md).
