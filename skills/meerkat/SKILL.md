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

`issue create` is the whole handoff: the card lands in `todo` — the queue the loop's poll reads — in the same call, addressed to whoever it is assigned to. The queue is per assignee, not global; an unassigned card is the public pool. Only `--status backlog` keeps it out of a queue. The INSERT gate:
[`references/status-lifecycle.md#8-creating-a-card-in-a-status`](references/status-lifecycle.md#8-creating-a-card-in-a-status).

**Route the card at creation.** The create *is* the routing decision, not a step after it. When a role skill fits the card's work shape (each role's `SKILL.md` lists its shapes), name that one accountable role in the same call:

```bash
taskctl issue create --project <p> --title "…" --assignee <role> --assignee-kind agent --acceptance "…"
```

An unassigned card is **unowned**, not handed off: the supervisor's pool claim can take it as the Worker role, or the `meerkat-director` routes it. A shape no role describes goes to the Worker role, named explicitly. **With no role installed, do not invent a role name** — leave the card unassigned (the public pool) or name your own worker identity. Ambiguous between two shapes: split it into one card per **role** shape — a handoff boundary, not a technical layer — or leave the routing to the director.

**File a card in the human's name when you are in an interactive session with the human, or when the instruction to create this card comes explicitly from them.** Either one is enough: `--as-human` records that human as both the writer and the reporter. Do not use it when you are working from a loop handoff or a card brief with no explicit human instruction, when you file a card yourself outside a human conversation, or for your own claim, heartbeat, delivery or review. If the human asked but `--as-human` is unavailable, pass `--reporter <name>` for the create.

**A document the work must follow is attached, not retyped.** When the human points at a file — a plan, a spec, a vendor's PDF to read closely — that pointing *is* the instruction; nobody says "upload it". Attach it straight after the create, and when the file is the plan itself, store it as `plan.md` whatever it is called on disk:

```bash
taskctl --as-human issue create --project <p> --title "…" [--assignee <role>] --acceptance "…"
taskctl attachment add <ref> --file <path> --name plan.md   # the plan's one name; create has no --file
```

Anything else keeps its own name, and a non-text plan keeps its extension (`plan.pdf`). The worker reads the card and its brief, never this conversation, so a path said only here reaches nobody: attach the file and point `--description` at the attachment instead of retyping it. A file named without a path gets one question for the path — never go hunting the tree for a document nobody named.

**Say the outcome in one line, then stop**: the identifier, that it is queued, and the file when you attached one — `已建卡 PROJ-0007，已排队处理（附 spec.pdf）`. Do not ask whether to start. Commands and flags:
[`references/cli.md#issue-create`](references/cli.md#issue-create), [`references/cli.md#attachment`](references/cli.md#attachment).

## The language of a card

Write in the language the work is actually being done in. English is not the default: the board stores text verbatim, so the first writer sets the language of the title, description, acceptance items, comment, question and report.

Decide it from evidence, in this order:

1. **The human in this conversation.** Their own messages are the signal — a Chinese question carrying an English stack trace is a Chinese request. An explicit instruction outranks this.
2. **The card, then its project.** With no human message — a loop tick, a handoff, a subagent — inherit what is already there: this card's own text, or the project's recent cards.
3. **The repository.** Use `README.md`, `CLAUDE.md`/`AGENTS.md` or `GLOSSARY.md` when the project has no cards yet. English only with no signal at all.

**What never translates:** identifiers, command lines, flags, error codes and status literals (`in_progress`, `E2`), field names, paths, code and log excerpts, and a quoted sentence. A review card's first line stays exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.

**A frozen acceptance item is a matching key, not prose.** Write it in the card's language at creation; afterwards each entry's `text` in the report repeats the item character for character, because the gate matches by normalised text. Translate the `note`, `conclusion` and `leftovers` around it, never the item. Anything another author wrote or the board froze stays as it is. Baseline and reviewer contract:
[`references/status-lifecycle.md#4a-the-acceptance-baseline`](references/status-lifecycle.md#4a-the-acceptance-baseline), [`references/review-workflow.md#3-the-reviewers-protocol`](references/review-workflow.md#3-the-reviewers-protocol).

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

Without that pre-authorization, write an agent `question` comment with the proposed items and stop — leave the card `in_progress`. Never derive on an **epic** (its acceptance is its children) or a **review card**.

The report must **cover the snapshot**: every item appears by text; `met` or `not_applicable` (with a non-empty note) passes, `partial` / `not_met` block. A report item beyond the baseline blocks too if unfinished. An imported checkbox list freezes as plain items: a tick is the author's intent, not this delivery's evidence.

### Delivering

`issue deliver` writes the report and moves to `in_review` in one transaction; the gate reads the **current** delivery round's report — an earlier round is history, so re-deliver rather than reuse it. A waiver (`--no-report --reason "<why>"`, ≥ 8 characters) excuses the report for one round, not acceptance.

The mode is resolved once, at creation: `--acceptance-mode off|agent|human`; omitted, it follows the project's `acceptance` default. `human` is opt-in and **top-level only**; an `off` card may go straight from `in_progress` to `done`; an `agent` and a `human` card are both reviewed; the loop accepts an `agent` card on `APPROVE`, a person closes a `human` card. An epic is reviewed against its children and rollup and closed only after an `APPROVE`. An agent may only tighten a mode (`off → agent|human`); a review card is always `off`. Gate, rounds and the board's matrix:
[`references/status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round`](references/status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round), [`references/status-lifecycle.md#4a-the-acceptance-baseline`](references/status-lifecycle.md#4a-the-acceptance-baseline), [`references/status-lifecycle.md#5-claims-and-heartbeats`](references/status-lifecycle.md#5-claims-and-heartbeats), [`references/status-lifecycle.md#7-acceptance-one-mode-per-card`](references/status-lifecycle.md#7-acceptance-one-mode-per-card), [`references/status-lifecycle.md#9-refusals`](references/status-lifecycle.md#9-refusals).

## Containers: when the card is an epic

An epic exists only where someone named one. Splitting is a scope decision: it belongs to the `meerkat-director` (an out-of-scope expansion to the human, `E1`), so a worker that finds several deliverables writes an agent `question` comment describing the pieces, keeps the card `in_progress`, and stops. A title and description naming the **sum** of the work is the container; naming **one deliverable** makes it a child.

**A child is a deliverable, not a layer.** Ask four questions of every proposed child:

1. **Can it land on the base branch alone?** Its branch merges without carrying a sibling's unmerged commit.
2. **Does landing it leave the tree coherent?** Every surface it touches — core, CLI, web, docs and fixtures — is updated in the same card, and the suite is green.
3. **Is the outcome visible?** A reader of the epic sees a result, not "the CLI flag" or "the docs".
4. **Does it owe a cleanup card?** No fixture sweep or documentation catch-up exists only to pay its debt.

A later child may build on an earlier child already on the base branch; a stack on an unmerged sibling is not. The layers of one change are its **scope**: enforcing the 1-4 character project prefix on every create path is one child, not five. The role routing table's "one card per shape" sizes a **role** handoff, not a technical layer.

| Card you have | Role | What to do |
|---|---|---|
| already an `epic` | — | add children; never convert it |
| `task`, no parent | the whole job | promote in place (below) |
| `task`, no parent | one deliverable among several | create a new `--kind epic` container; link it and the new children |
| `task`, with a parent | the whole job | promote to a nested epic; its parent edge stays |
| `task`, with a parent | one deliverable among several | keep it as a child; add siblings under the same parent |
| `in_review`, `done`, `canceled` or archived | — | do **not** promote; create a new container and link the old card |
| a review card | — | do **not** promote; split a separate container |

**Promote before the card delivers its current-round report.** The rollup collects the **children's** delivery reports, not the container's own history, so promoting a card that already delivered strands every child attached after it; start a *new* container instead.

```bash
taskctl issue update <ref> --kind epic       # the card keeps its status
taskctl comment add <ref> --kind note --body "split into N cards: …"
taskctl issue create --project <p> --title "…" [--assignee <role>] --target <t> --acceptance "…"
taskctl relation add <ref> --type parent --target <child>     # <ref> is the parent
```

**An epic's acceptance is its children**; its delivery is a rollup of their reports. The board starts the container when a child enters work and closes it to `in_review` (never `done`) when the tree is finished — but a `backlog` or `awaiting` epic does not auto-start, and an `in_review` epic that gains a child must move back to `in_progress` to roll up again. An all-canceled tree is not a delivery — cancel the container instead. Attempt the close; the refusal names anything still open.

Three rules that fail **silently**:

- **Each child needs its own `--target`.** The create guard keys on kind + assignee + source + target; two children for one owner with nothing to tell them apart are the *same card*. Use `--allow-dup` when a target does not apply.
- **`issue create --parent <epic>` links nothing** — only `relation add --type parent` does.
- **A child attached after the rollup makes it stale**; rework the epic to start a new round.

Claim exactly **one** leaf child; the container holds no work of its own. Full rules:
[`references/status-lifecycle.md#6-containers-epic`](references/status-lifecycle.md#6-containers-epic), [`references/cli.md#promoting-an-existing-card-to-an-epic`](references/cli.md#promoting-an-existing-card-to-an-epic).

## Review cards (flow B)

A card is a review card when `issue get <ref> --json` carries `review_of_id` / `review_round` (or `issue candidates --json` carries `review_of` / `review_round`). The `review` label is a discovery aid, never the predicate. `meta.flow` absent means flow A; a flow-B card is never reviewed again.

Claim it like any `todo` card, but the work is a review, not a change to the original. Ledger the requirements first — every requirement in the description, comments and plan needs an acceptance item *and* an implementation, or the verdict is `REJECT` — then verify at the report's `commit` anchor rather than the live tree, and answer every baseline item with a status, how you checked it, and an `evidence[n]` anchor. A `met` the board cannot trace is refused, and so is an `APPROVE` whose report records no command the reviewer ran.

Then deliver a report **on this card** whose first line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`; put findings after that line and in `leftovers`, as a numbered must-fix list on a `REJECT` — the loop appends those items to the original's acceptance. Move neither card — the loop applies the verdict and closes the review card. A delivery whose first line is not a verdict is still accepted by the board; the loop records `verdict_unreadable`, so the review is wasted.

The review card's `review_round` is the **original's** audited round; its own `delivery_round` is a different number. A re-delivery after a rejection needs a new review card. Full protocol:
[`references/review-workflow.md`](references/review-workflow.md), [`references/review-workflow.md#2-the-review-cards-identity`](references/review-workflow.md#2-the-review-cards-identity), [`references/review-workflow.md#3-the-reviewers-protocol`](references/review-workflow.md#3-the-reviewers-protocol), [`references/review-workflow.md#6-what-happens-after-a-delivery`](references/review-workflow.md#6-what-happens-after-a-delivery).

## Waiting: a human question, or blocked

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
| delivery gate, round, acceptance baseline | [§4–§4a](references/status-lifecycle.md#4-the-delivery-gate-and-the-delivery-round) |
| claims, heartbeats, stale takeover | [§5](references/status-lifecycle.md#5-claims-and-heartbeats) |
| containers, rollup, promotion | [§6](references/status-lifecycle.md#6-containers-epic) |
| acceptance modes | [§7](references/status-lifecycle.md#7-acceptance-one-mode-per-card) |
| creating in a status | [§8](references/status-lifecycle.md#8-creating-a-card-in-a-status) |
| refusal codes, enforced vs practice, workflow plan | [§9–§11](references/status-lifecycle.md#9-refusals) |
| commands, flags, exit codes, JSON envelope | [Commands](references/cli.md#commands), [`--json`](references/cli.md#--json), [returns](references/cli.md#what-each-command-returns) |
| `issue create`, attachments, `export watch` | [create](references/cli.md#issue-create), [attachment](references/cli.md#attachment), [export watch](references/cli.md#export-watch) |
| awaiting / blocked | [awaiting](references/cli.md#the-awaiting-state--asking-a-human-a-question), [blocked](references/cli.md#the-blocked-state--what-the-card-is-waiting-for) |
| review protocol and verdict | [§1–§3](references/review-workflow.md#1-two-flows), [§6](references/review-workflow.md#6-what-happens-after-a-delivery) |
| wire object, export format, identifiers, `blocked_reason` | [reading](references/card-schema.md#reading-a-card-as-json), [fields](references/card-schema.md#field-reference), [identifiers](references/card-schema.md#identifier-syntax), [blocked_reason](references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for), [export](references/card-schema.md#export-rules) |
| project ↔ directory map | [managed](references/projects-json.md#managed-by-taskctl), [validation](references/projects-json.md#project--directory-what-is-checked), [unregistered](references/projects-json.md#unregistered-no-fallback--ask) |
| supervisor bindings, candidate scan, live events | [invocation](references/capabilities.md#the-invocation-rule), [claim](references/capabilities.md#3-candidate-scan-and-atomic-claim), [questions](references/capabilities.md#questions--the-awaiting-protocol), [events](references/capabilities.md#8-live-stream--events-follow-hub--events-tail-direct) |
