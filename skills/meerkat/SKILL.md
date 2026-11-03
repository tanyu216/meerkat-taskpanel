---
name: meerkat
description: Use this skill when an agent must operate a Meerkat TaskPanel card through the local `taskctl` kanban — claim, heartbeat, comment, answer an on-card question, read or re-export the brief (`card.md`), create or split cards (uploading a plan, spec or reference file as an attachment), link relations, move status, deliver with a report, review, accept or reopen, and export the board as markdown. Trigger on Meerkat, taskpanel, taskctl, the task board, a task card, `card.md`, card file, `export md`, re-export, brief, deliver, heartbeat, acceptance, review, or an awaiting question; on a supervisor handoff or role workflow that only says read the brief or deliver the card. A human asking in a live session about progress, waiting questions, acceptance or board health is the `meerkat-chat` console's, not this mechanics contract. Works the same on any agent runtime — Claude, Codex, pi and OpenClaw are all covered.
---

# Meerkat TaskPanel

A local-first task board for AI Agent teams, driven entirely through the `taskctl` CLI: claim a card, heartbeat, comment, deliver with a report; results roll up a parent/child tree.

This page is the **decision manual** — what to do, in what order, and which of two similar commands to use. The board validates every write itself: read the refusal and act rather than pre-checking from a document, because enforced rules live in `references/`. Scheduling is the supervisor's job; the decisions it cannot make are the `meerkat-director` skill's. `src/…` and `docs/…` name the source repository, not this skill; everything you run is `taskctl`.

## Running the CLI

```bash
node scripts/run.mjs --help          # this skill's launcher
taskctl --help                       # when the shim is on PATH
```

`--actor-kind` is required except on `--help`, `--version`, `status` and the `project map` actions; a human writes with `--as-human`. Config, flags and exit codes:
[`references/cli.md#configuration-env`](references/cli.md#configuration-env),
[`references/cli.md#global-options`](references/cli.md#global-options).

## Reading a refusal

Every call returns `{ok:true, data}` or `{ok:false, error}`. Read a refusal in this order: `error.code` (the stable branch point) → `error.hint.command` / `error.hint.fix` / `error.hint.alternative` → `error.details` → the prose `error.message` only last. Never parse the message to decide what to do.

Retry only `VERSION_CONFLICT` (re-read once, retry with the fresh `--if-version`) and `DB_BUSY` (wait `Retry-After`); everything else means "change the request". An omission is not permission. Classification:
[`references/status-lifecycle.md#10-what-is-enforced-and-what-is-practice`](references/status-lifecycle.md#10-what-is-enforced-and-what-is-practice).

## Finding the data you need

One read often answers several questions; the full field list and meanings are
[`references/card-schema.md#reading-a-card-as-json`](references/card-schema.md#reading-a-card-as-json) and [`references/card-schema.md#field-reference`](references/card-schema.md#field-reference).

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

Seven stages — `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled` — plus `awaiting`, an attention overlay for a card parked on a human question. `done` and `canceled` are terminal; `issue reopen <ref> --reason "<why>"` returns a card to `todo` and starts a new delivery round. A review card cannot be reopened — reopen the card it reviews.

Attempt the move and read the refusal; the whitelist names the allowed targets. Vocabulary, whitelist and reopen:
[`references/status-lifecycle.md#1-the-vocabulary`](references/status-lifecycle.md#1-the-vocabulary),
[`references/status-lifecycle.md#2-the-whitelist`](references/status-lifecycle.md#2-the-whitelist),
[`references/status-lifecycle.md#2a-reopen`](references/status-lifecycle.md#2a-reopen).

**`done` is acceptance; `canceled` is abandonment.** Deliver, then stop at `in_review`. Do **not** close a card — especially a container — by canceling it: canceling has no child guard and leaves the work orphaned.

## Creating a card

A create is one call and three decisions: **scope** (is this work a card at all?), **shape** (one
card, or an `epic` container for several deliverables?) and **closer** (`off`, `auto` or `human`).
`issue create` queues the card in `todo` — the queue the loop polls — in the same call; only
`--status backlog` keeps it out. An unassigned card is the public pool.

Resolve the project's own rule first — `taskctl project dir <id> --json`, then
`<project-dir>/docs/agents/create-card.md` when it exists. An explicit instruction from the human
wins over it. Route in the same call from the role catalog:

```bash
taskctl role list --json     # the valid assignees: data.roles[].agent
taskctl issue create --project <p> --title "…" --assignee <role> --assignee-kind agent --acceptance "…"
```

The full manual — what becomes a card, the epic decision and its patterns, the acceptance words,
routing, `--as-human`, attachments, the one-line outcome:
[`references/create-card.md`](references/create-card.md).

## Stage markers

A producer card that hands work on sets `meta.stage_handoff=required` and puts a `## Handoff`
block in its **current-round report**. The director's triage copies that block into a downstream
card's description and sets `meta.design_stage=yes` there. A small change or bug with no design
input sets `meta.product_change=none`. The foundation records the one gate command the reviewer
re-runs as the project's `meta.review_gate`. These keys are read by the role skills and the
reviewer; write them with `issue meta` (its `--if-version` CAS form), not with a second local
convention.

## The language of a card

Write in the language the work is actually being done in. English is not the default: the board stores text verbatim, so the first writer sets the language of the title, description, acceptance items, comment, question and report.

Decide it from evidence, in this order:

1. **The human in this conversation.** Their own messages are the signal — a Chinese question carrying an English stack trace is a Chinese request. An explicit instruction outranks this.
2. **The card, then its project.** With no human message — a loop tick, a handoff, a worker session — inherit what is already there: this card's own text, or the project's recent cards.
3. **The repository.** Use `README.md`, `CLAUDE.md`/`AGENTS.md` or `GLOSSARY.md` when the project has no cards yet. English only with no signal at all.

**What never translates:** identifiers, command lines, flags, error codes and status literals (`in_progress`, `E2`), field names, paths, code and log excerpts, and a quoted sentence. A review card's first line stays exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.

**A frozen acceptance item is a matching key, not prose.** Write it in the card's language at creation; afterwards each entry's `text` in the report repeats the item character for character, because the gate matches by normalised text. Translate the `note`, `conclusion` and `leftovers` around it, never the item. Anything another author wrote or the board froze stays as it is. Baseline and reviewer contract:
[`references/status-lifecycle.md#4a-the-acceptance-baseline`](references/status-lifecycle.md#4a-the-acceptance-baseline), [`references/review-protocol.md#3-the-reviewers-protocol`](references/review-protocol.md#3-the-reviewers-protocol).

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

Then **stop**: acceptance is somebody else's act. A card held by someone else, or still in `backlog`, is not yours; the board refuses.

**The one silent exclusion is dependencies.** `issue candidates` withholds a card whose `depends_on` (reversed `blocks`) predecessor is not `done` — a `canceled` predecessor withholds it too. The claim verb does not re-check blockers unless `--check-blockers`; a direct claim can take a blocked card. If a card you expected is missing, run `taskctl relation list <ref>`.

A heartbeat resets the claim and **nothing else** — not status, not claimer, not the delivery round — and only the holder may send it. A claim you stop pulsing reads as abandoned.

### The acceptance list is the contract

`issue get <ref> --json` carries `acceptance[]` — the **frozen** snapshot the delivery gate reads. `meta.acceptance` is only the seed; the gate never reads it.

- **Non-empty** — work to it. It is frozen: append with `issue update <ref> --acceptance "…"`; never replace or remove (removal is a human-only, audited prune).
- **Empty, but `meta.acceptance` / `meta.acceptance_legacy` is not** — append as above; the next round freezes it.
- **All empty** — this is an acceptance decision. Derive **1–6 concrete, externally checkable** items (usually 2–6; never pad) only when the handoff or the `meerkat-director` pre-authorized it for this card, persist them once, and record the act:

```bash
taskctl issue update <ref> --acceptance "…" --acceptance "…" --meta acceptance_derived=yes
taskctl comment add <ref> --kind note --body "acceptance list derived at claim (pre-authorized): 1) …"
```

Without that pre-authorization, write an agent `question` comment with the proposed items and **hold** with `issue wait` — leave the card `in_progress`. Never derive on an **epic** (its acceptance is its children) or a **review card**.

The report must **cover the snapshot**: every item appears by text; `met` or `not_applicable` (with a non-empty note) passes, `partial` / `not_met` block. A report item beyond the baseline blocks too if unfinished. An imported checkbox list freezes as plain items: a tick is the author's intent, not this delivery's evidence.

### Delivering

`issue deliver` writes the report and moves to `in_review` in one transaction; the gate reads the **current** delivery round's report — an earlier round is history, so re-deliver rather than reuse it. A waiver (`--no-report --reason "<why>"`, ≥ 8 characters) excuses the report for one round, not acceptance.

The mode is resolved once, at creation: `--acceptance-mode off|auto|human`; omitted, it falls
back to `auto`. There is no project default — the create section explains the project's
`docs/agents/create-card.md`. An `off` card may go straight from `in_progress` to `done`; `auto`
and `human` are both reviewed; the loop accepts an `auto` card on `APPROVE`, and a person
closes a `human` card after its review finishes. An epic is reviewed against its children and
rollup and closed only after an `APPROVE`. An agent may only tighten a mode
(`off → auto|human`); a review card is always `off`. Gate, rounds and the board's matrix:
[`references/status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round`](references/status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round), [`references/status-lifecycle.md#4a-the-acceptance-baseline`](references/status-lifecycle.md#4a-the-acceptance-baseline), [`references/status-lifecycle.md#5-claims-and-heartbeats`](references/status-lifecycle.md#5-claims-and-heartbeats), [`references/status-lifecycle.md#7-acceptance-one-mode-per-card`](references/status-lifecycle.md#7-acceptance-one-mode-per-card), [`references/status-lifecycle.md#9-refusals`](references/status-lifecycle.md#9-refusals).

## Review cards (flow B)

A card is a review card when `issue get <ref> --json` carries `review_of_id` / `review_round` (or `issue candidates --json` carries `review_of` / `review_round`). The `review` label is a discovery aid, never the predicate. `meta.flow` absent means flow A; a flow-B card is never reviewed again.

A review card the supervisor dispatched is already claimed by the loop: the handoff says so —
heartbeat it, do not re-claim. A review card you picked up interactively from `issue candidates`
is claimed like any `todo` card. The work is a review, not a change to the original. Ledger the
requirements first — every requirement in the description, comments and plan needs an acceptance item *and* an implementation, or the verdict is `REJECT` — then verify at the report's `commit` anchor rather than the live tree, and answer every baseline item with a status, how you checked it, and an `evidence[n]` anchor. A `met` the board cannot trace is refused, and so is an `APPROVE` whose report records no command the reviewer ran.

Then deliver a report **on this card** whose first line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`; put findings after that line and in `leftovers`, as a numbered must-fix list on a `REJECT` — the loop appends those items to the original's acceptance. Move neither card — the loop applies the verdict and closes the review card. A delivery whose first line is not a verdict is still accepted by the board; the loop records `verdict_unreadable`, so the review is wasted.

The review card's `review_round` is the **original's** audited round; its own `delivery_round` is a different number. A re-delivery after a rejection needs a new review card. Full protocol:
[`references/review-protocol.md`](references/review-protocol.md), [`references/review-protocol.md#2-the-review-cards-identity`](references/review-protocol.md#2-the-review-cards-identity), [`references/review-protocol.md#3-the-reviewers-protocol`](references/review-protocol.md#3-the-reviewers-protocol), [`references/review-protocol.md#6-what-happens-after-a-delivery`](references/review-protocol.md#6-what-happens-after-a-delivery).

## Waiting: the director, a human, or blocked

- A question for the **director** is an agent `question` comment plus a bounded hold: `issue wait <ref> --question <id>`. `answered` continues in the same turn (re-claim if the card is back in `todo`); `escalated`, `moved`, `timeout` and `error` end the turn, and the loop resumes the session when the answer lands.
- A question for a person is **`awaiting`**, not `blocked` and not a chat message: `issue move <ref> awaiting --awaiting-reason E3 --question "…"`. The reason is one of `E1`–`E5` (scope · acceptance baseline · design direction · security · architecture). **Any human comment** re-queues the card to `todo`; `awaiting → in_progress` resumes the same attempt without a new delivery round.
- **`blocked`** is for everything else; `--blocked-reason` is optional. Literals: [`references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for`](references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).

Full protocols:
[`references/cli.md#the-awaiting-state--asking-a-human-a-question`](references/cli.md#the-awaiting-state--asking-a-human-a-question), [`references/cli.md#the-blocked-state--what-the-card-is-waiting-for`](references/cli.md#the-blocked-state--what-the-card-is-waiting-for).

## Coordinating with other agents

- **Never force a conflict** — the retry rule is in *Reading a refusal*.
- **Stamp every write with your identity:** `--actor-kind <kind> --session-id <id>`. `taskctl session id <ref> --seg <seg> --owner <name>` derives it; offline, [`scripts/session-id.mjs`](scripts/session-id.mjs) computes the same value from the resolved task UUID.
- **Metadata has two writers.** `issue meta` is a read-modify-write with `--if-version` that preserves value types; `issue update --meta` merges but stringifies and sends no CAS, so a concurrent write can be lost. Use `issue meta` for machine keys. Neither writes `acceptance[]`.
- **The board runs no timer.** The supervisor owns the scheduler — add no second poller.

Session identity: [`references/cli.md#session`](references/cli.md#session).

## Configuring project directories

**The board holds no directories.** The only answer is the machine-local map at the config root (`<config root>/projects.json`), read with `taskctl project dir` and changed only with `taskctl project map`. **Never read or edit `projects.json` by hand.** Schema and codes:
[`references/projects-json.md#managed-by-taskctl`](references/projects-json.md#managed-by-taskctl), [`references/projects-json.md#project--directory-what-is-checked`](references/projects-json.md#project--directory-what-is-checked).

A project with **no directory** is an entry naming none: `project dir` says so and succeeds — do not invent one. A project **absent** from the map has no registered directory; do not guess. When a step needs it, stop and ask:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will register it with
`taskctl project map set <project> --local-path <dir>` — the board cannot supply one.
```

[`references/projects-json.md#no-directory-is-an-answer`](references/projects-json.md#no-directory-is-an-answer), [`references/projects-json.md#unregistered-no-fallback--ask`](references/projects-json.md#unregistered-no-fallback--ask). Claiming, moving, commenting and delivering need no directory.

## Keeping the brief fresh

A card exported into a project directory is a **snapshot**. Register it once with the local event hub — `export watch <ref> --dir <dir> --detach` — and check it with `--watch-status`; `--stop` ends it, and the portable form is `--once`. Never use a plain `&`: the hub, not your shell, owns the connection. It writes `.meerkat/<identifier>/card.md`, stops at `done` or `canceled`, and is one-way — re-read the brief before a decision, and never hand-edit it. **A supervisor-dispatched worker starts no watcher.** Detail:
[`references/cli.md#export-watch`](references/cli.md#export-watch).

## Where to look

| Topic | Read |
|---|---|
| statuses, whitelist, reopen, guards | [§1–§3](references/status-lifecycle.md#1-the-vocabulary) |
| creating a card: scope, epic decision and patterns, acceptance mode | [create-card](references/create-card.md) |
| delivery gate, round, acceptance baseline | [§4–§4a](references/status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round) |
| claims, heartbeats, stale takeover | [§5](references/status-lifecycle.md#5-claims-and-heartbeats) |
| containers, rollup, promotion | [§6](references/status-lifecycle.md#6-containers-epic) |
| acceptance modes | [§7](references/status-lifecycle.md#7-acceptance-one-mode-per-card) |
| creating in a status | [§8](references/status-lifecycle.md#8-creating-a-card-in-a-status) |
| refusal codes, enforced vs practice, workflow plan | [§9–§11](references/status-lifecycle.md#9-refusals) |
| commands, flags, exit codes, JSON envelope | [Commands](references/cli.md#commands), [`--json`](references/cli.md#--json), [returns](references/cli.md#what-each-command-returns) |
| `issue create`, attachments, `export watch` | [create](references/cli.md#issue-create), [attachment](references/cli.md#attachment), [export watch](references/cli.md#export-watch) |
| awaiting / blocked | [awaiting](references/cli.md#the-awaiting-state--asking-a-human-a-question), [blocked](references/cli.md#the-blocked-state--what-the-card-is-waiting-for) |
| review protocol and verdict | [§1–§3](references/review-protocol.md#1-two-flows), [§6](references/review-protocol.md#6-what-happens-after-a-delivery) |
| wire object, export format, identifiers, `blocked_reason` | [reading](references/card-schema.md#reading-a-card-as-json), [fields](references/card-schema.md#field-reference), [identifiers](references/card-schema.md#identifier-syntax), [blocked_reason](references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for), [export](references/card-schema.md#export-rules) |
| project ↔ directory map | [managed](references/projects-json.md#managed-by-taskctl), [validation](references/projects-json.md#project--directory-what-is-checked), [unregistered](references/projects-json.md#unregistered-no-fallback--ask) |
| supervisor bindings, candidate scan, live events | [invocation](references/capabilities.md#the-invocation-rule), [claim](references/capabilities.md#3-candidate-scan-and-atomic-claim), [questions](references/capabilities.md#questions--the-awaiting-protocol), [events](references/capabilities.md#8-live-stream--events-follow-hub--events-tail-direct) |
