---
name: meerkat
description: Use this skill when an agent must operate a Meerkat TaskPanel card through the local `taskctl` kanban — claim, heartbeat, comment, answer an on-card question, read or re-export the brief (`card.md`), create or split cards (uploading a plan, spec or reference file as an attachment), link relations, move status, deliver with a report, review, accept or reopen, and export the board as markdown. Trigger on Meerkat, taskpanel, taskctl, the task board, a task card, `card.md`, card file, `export md`, re-export, brief, deliver, heartbeat, acceptance, review, or an awaiting question; on a supervisor handoff or role workflow that only says read the brief or deliver the card. A human asking in a live session about progress, waiting questions, acceptance or board health is the `meerkat-chat` console's, not this mechanics contract. Works the same on any agent runtime — Claude, Codex, pi and OpenClaw are all covered.
---

# Meerkat TaskPanel

A local-first task board for AI Agent teams, driven entirely through the `taskctl` CLI: claim a
card, heartbeat, comment, deliver with a report; results roll up a parent/child tree.

This page is the **universal contract** — the rules every card operation shares. The board
validates every write itself: read the refusal and act rather than pre-checking from a
document. Scheduling is the supervisor's job; the decisions it cannot make are the
`meerkat-director` skill's. `src/…` and `docs/…` name the source repository, not this skill;
everything you run is `taskctl`.

## How this skill is organized

Three layers:

- **This page** — what every operation shares.
- **`references/scenarios/<operation>.md`** — the runbook for one operation.
- **`references/lifecycle/`, `references/schema/`, `references/cli/`, `review-protocol.md`,
  `projects-json.md`, `capabilities.md`** — the deep authorities.

Open exactly one scenario page for the card in hand, then only the deep section that page
names. **Do not read `cli.md`, `lifecycle/*` or `schema/*` end to end**: the board is the
authority and the refusal is the instruction.

## Start here

| The card in hand | Read |
|---|---|
| creating a card | [`references/scenarios/create.md`](references/scenarios/create.md) |
| claiming and delivering | [`references/scenarios/execute.md`](references/scenarios/execute.md) |
| adding or changing requirements on an existing card | [`references/scenarios/edit.md`](references/scenarios/edit.md) |
| splitting or building an epic | [`references/scenarios/epic.md`](references/scenarios/epic.md) |
| reviewing a delivered card | [`references/scenarios/review.md`](references/scenarios/review.md) |
| waiting on the director, a human, or blocked | [`references/scenarios/wait.md`](references/scenarios/wait.md) |
| resolving a project directory, owning a session worktree, or watching a brief | [`references/scenarios/setup.md`](references/scenarios/setup.md) |
| a read-only lookup | this page's read table |

The table is a **selector, not a reading list**. The universal core below is not a procedure:
open the matching scenario page before the first write.

## Running the CLI

```bash
node scripts/run.mjs --help          # this skill's launcher
taskctl --help                       # when the shim is on PATH
```

`--actor-kind` is required except on `--help`, `--version`, `status` and the `project map`
actions; a human writes with `--as-human`. Config, flags and exit codes:
[`references/cli/core.md#configuration-env`](references/cli/core.md#configuration-env),
[`references/cli.md#global-options`](references/cli.md#global-options).

## Reading a refusal

Every call returns `{ok:true, data}` or `{ok:false, error}`. Read a refusal in this order:
`error.code` (the stable branch point) → `error.hint.command` / `error.hint.fix` /
`error.hint.alternative` → `error.details` → the prose `error.message` only last. Never parse
the message to decide what to do.

Retry only `VERSION_CONFLICT` (re-read once, retry with the fresh `--if-version`) and `DB_BUSY`
(wait `Retry-After`); everything else means "change the request". An omission is not
permission. Classification:
[`references/lifecycle/refusals.md#10-what-is-enforced-and-what-is-practice`](references/lifecycle/refusals.md#10-what-is-enforced-and-what-is-practice).

## Finding the data you need

One read often answers several questions; the full field list and meanings are
[`references/schema/wire.md#reading-a-card-as-json`](references/schema/wire.md#reading-a-card-as-json)
and [`references/schema/records.md#field-reference`](references/schema/records.md#field-reference).

| I need… | Run | Read |
|---|---|---|
| the card, who is on it, the claim and its heartbeat | `issue get <ref> --json` | `data.task` |
| the acceptance contract (frozen) | `issue get <ref> --json` | `data.task.acceptance[]` — never `meta.acceptance` |
| the parent, children, ancestors, blockers | `relation list <ref> --json` | `data.{parent_chain,children,ancestors,blocked_by,blocks}` |
| the comment and decision trail | `comment list <ref> --json` | `data.comments[]` |
| the delivery reports and their evidence | `report list <ref> --json` | `data.reports[]` |
| waivers and attachments | `issue get <ref> --json` | `data.report_waivers[]`, `data.attachments[]` |
| the whole picture in one read | `issue get <ref> --json --include comments --include reports --include relations --include sessions` | `data.{task,comments,reports,relations,sessions}` |
| cards in a slice | `issue list … --json` | `data.tasks[]` |
| the project ↔ directory map | `project dir <p> --json` | `data.dir` |

The **activity** trail has no CLI verb: `GET /api/v1/tasks/:ref/activities`.

A human asking in a live session — progress, what is open, a lookup, a move — is the
[`meerkat-chat`](../meerkat-chat/SKILL.md) console's; it uses the same reads below.

## The card's life

Seven stages — `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled` —
plus `awaiting`, an attention overlay for a card parked on a human question. `done` and
`canceled` are terminal; `issue reopen <ref> --reason "<why>"` returns a card to `todo` and
starts a new delivery round. A review card cannot be reopened — reopen the card it reviews.

Attempt the move and read the refusal; the whitelist names the allowed targets. Vocabulary,
whitelist and reopen:
[`references/lifecycle/transitions.md#1-the-vocabulary`](references/lifecycle/transitions.md#1-the-vocabulary),
[`references/lifecycle/transitions.md#2-the-whitelist`](references/lifecycle/transitions.md#2-the-whitelist),
[`references/lifecycle/transitions.md#2a-reopen`](references/lifecycle/transitions.md#2a-reopen).

**`done` is acceptance; `canceled` is abandonment.** Deliver, then stop at `in_review`. Do
**not** close a card — especially a container — by canceling it: canceling has no child guard
and leaves the work orphaned.

## Creating a card

`issue create` is the whole handoff: the card lands in `todo` — the queue the loop's poll
reads — and the create is the routing decision. The acceptance mode is resolved at creation
from the card and the project's `docs/agents/create-card.md`; the detail, routing,
attribution, attachments and the one-line outcome are in
[`references/scenarios/create.md`](references/scenarios/create.md).

## Stage markers

A producer card that hands work on sets `meta.stage_handoff=required` and puts a `## Handoff`
block in its **current-round report**. The director's triage copies that block into a
downstream card's description and sets `meta.design_stage=yes` there. A small change or bug
with no design input sets `meta.product_change=none`. The foundation records the one gate
command the reviewer re-runs as the project's `meta.review_gate`. These keys are read by the
role skills and the reviewer; write them with `issue meta` (its `--if-version` CAS form), not
with a second local convention.

## The language of a card

Write in the language the work is actually being done in. English is not the default: the
board stores text verbatim, so the first writer sets the language of the title, description,
acceptance items, comment, question and report.

Decide it from evidence, in this order:

1. **The human in this conversation.** Their own messages are the signal — a Chinese question
   carrying an English stack trace is a Chinese request. An explicit instruction outranks this.
2. **The card, then its project.** With no human message — a loop tick, a handoff, a worker session —
   inherit what is already there: this card's own text, or the project's recent cards.
3. **The repository.** Use `README.md`, `CLAUDE.md`/`AGENTS.md` or `GLOSSARY.md` when the
   project has no cards yet. English only with no signal at all.

**What never translates:** identifiers, command lines, flags, error codes and status literals
(`in_progress`, `E2`), field names, paths, code and log excerpts, and a quoted sentence. A
review card's first line stays exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.

**A frozen acceptance item is a matching key, not prose.** Write it in the card's language at
creation; afterwards each entry's `text` in the report repeats the item character for
character, because the gate matches by normalised text. Translate the `note`, `conclusion` and
`leftovers` around it, never the item. Anything another author wrote or the board froze stays
as it is. Baseline and reviewer contract:
[`references/lifecycle/delivery.md#4a-the-acceptance-baseline`](references/lifecycle/delivery.md#4a-the-acceptance-baseline),
[`references/review-protocol.md#3-the-reviewers-protocol`](references/review-protocol.md#3-the-reviewers-protocol).

## Claim one card, deliver it, stop

Read the claimable set for *you*, take exactly one, then work it:

```bash
taskctl issue candidates --assignee <me>       # read-only: what may I claim?
taskctl issue move <ref> in_progress           # claim exactly one
taskctl issue get <ref> --json                 # description + the frozen acceptance snapshot
taskctl issue heartbeat <ref>                  # keep the claim fresh (at least every 10 minutes)
taskctl report template <ref>                  # fill the TODO lines
taskctl issue deliver <ref> --report-file -    # report + in_review, one transaction
```

Then **stop**: acceptance is somebody else's act. A card held by someone else, or still in
`backlog`, is not yours; the board refuses.

The dependency exclusion, heartbeat semantics, delivery round, waiver and evidence anchors
are in [`references/scenarios/execute.md`](references/scenarios/execute.md).

### The acceptance list is the contract

`issue get <ref> --json` carries `acceptance[]` — the **frozen** snapshot the delivery gate
reads. `meta.acceptance` is only the seed; the gate never reads it.

- **Non-empty** — work to it. It is frozen: append with `issue update <ref> --acceptance "…"`;
  never replace or remove (removal is a human-only, audited prune).
- **Empty, but `meta.acceptance` / `meta.acceptance_legacy` is not** — append as above; the
  next round freezes it.
- **All empty** — this is an acceptance decision. Derive **1–6 concrete, externally checkable**
  items (usually 2–6; never pad) only when the handoff or the `meerkat-director` pre-authorized
  it for this card, persist them once, and record the act:

```bash
taskctl issue update <ref> --acceptance "…" --acceptance "…" --meta acceptance_derived=yes
taskctl comment add <ref> --kind note --body "acceptance list derived at claim (pre-authorized): 1) …"
```

Without that pre-authorization, write an agent `question` comment with the proposed items and
**hold** with `issue wait` — leave the card `in_progress`. Never derive on an **epic** (its
acceptance is its children) or a **review card**.

The report must **cover the snapshot**: every item appears by text; `met` or `not_applicable`
(with a non-empty note) passes, `partial` / `not_met` block. A report item beyond the baseline
blocks too if unfinished. An imported checkbox list freezes as plain items: a tick is the
author's intent, not this delivery's evidence.

## Containers: when the card is an epic

An epic exists only where someone named one; splitting is a scope decision that belongs to the
`meerkat-director`. Promote the container **before** the card delivers its **current-round
report**, and do **not** promote a card that already delivered — start a new container. The
four sizing questions, the promotion table and the silent traps are in
[`references/scenarios/epic.md`](references/scenarios/epic.md); the board's container rules are
[`references/lifecycle/containers.md#6-containers-epic`](references/lifecycle/containers.md#6-containers-epic).

## Review cards (flow B)

A card is a review card when `issue get <ref> --json` carries `review_of_id` / `review_round`
(or `issue candidates --json` carries `review_of` / `review_round`). The `review` label is a
discovery aid, never the predicate. `meta.flow` absent means flow A; a flow-B card is never
reviewed again. A review card the supervisor dispatched is already claimed by the loop:
heartbeat it, do not re-claim. Deliver a report **on this card** whose first line is exactly
`VERDICT: APPROVE` or `VERDICT: REJECT`, and move neither card.

The entry sequence is [`references/scenarios/review.md`](references/scenarios/review.md); the
full protocol is [`references/review-protocol.md`](references/review-protocol.md).

## Waiting

A director question holds with `issue wait`; a human question moves the card to `awaiting`
with an E1–E5 reason; everything else is `blocked`. The three protocols and the E-code table
are in [`references/scenarios/wait.md`](references/scenarios/wait.md).

## Coordinating with other agents

- **Never force a conflict** — the retry rule is in *Reading a refusal*.
- **Stamp every write with your identity:** `--actor-kind <kind> --session-id <id>`.
  `taskctl session id <ref> --seg <seg> --owner <name>` derives it; offline,
  [`scripts/session-id.mjs`](scripts/session-id.mjs) computes the same value from the resolved
  task UUID.
- **A card you claimed yourself registers its session row** with `--seg manual` after the
  claim and closes it on delivery
  ([`references/scenarios/execute.md`](references/scenarios/execute.md#the-cards-session-row-manual-claim)).
  A supervisor handoff already holds the claim and the loop owns its `worker`/`reviewer` row —
  do not register a second one.
- **Metadata has two writers.** `issue meta` is a read-modify-write with `--if-version` that
  preserves value types; `issue update --meta` merges but stringifies and sends no CAS, so a
  concurrent write can be lost. Use `issue meta` for machine keys. Neither writes
  `acceptance[]`.
- **The board runs no timer.** The supervisor owns the scheduler — add no second poller.

Session identity: [`references/cli.md#session`](references/cli.md#session).

## Project directories and the brief

The board holds no directories: the map is machine-local, read with `taskctl project dir` and
changed only with `taskctl project map` — never edited by hand. The directory resolution, the
`docs/agents/` rule files, session identity and the brief watcher are in
[`references/scenarios/setup.md`](references/scenarios/setup.md).

## Deep references

Read only the section a scenario page names.

| Topic | Authority |
|---|---|
| statuses, whitelist, reopen, guards, create | `references/lifecycle/transitions.md` |
| delivery gate, round, acceptance baseline | `references/lifecycle/delivery.md` |
| claims, heartbeats, stale takeover | `references/lifecycle/claims.md` |
| containers, rollup, promotion | `references/lifecycle/containers.md` |
| acceptance modes | `references/lifecycle/acceptance.md` |
| refusals, enforced vs practice | `references/lifecycle/refusals.md` |
| the board's workflow plan | `references/lifecycle/workflow.md` |
| commands, flags, exit codes | `references/cli.md` |
| command semantics, JSON envelope, returns | `references/cli/` |
| the state model, delivery, acceptance, containers, refusals | `references/lifecycle/` |
| the wire object, records, identifiers, blocked reasons | `references/schema/` |
| the review protocol and verdict | `references/review-protocol.md` |
| the project ↔ directory map | `references/projects-json.md` |
| supervisor bindings and live events | `references/capabilities.md` |
