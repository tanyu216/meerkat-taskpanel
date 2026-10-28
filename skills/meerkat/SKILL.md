---
name: meerkat
description: Use this skill when the user asks about a Meerkat TaskPanel task itself — progress, status, what is left, remaining work, who is on it, why it is blocked, history, completion count, acceptance criteria, what to do next, or a card found by a bare id or title. It also runs every card operation through the local `taskctl` kanban — claim, heartbeat, comment, answer on-card questions, read or re-export the brief (`card.md`), create or split cards (uploading a plan, spec or reference file as an attachment), link relations, move status, deliver with a report, review, accept or reopen, and export the board as markdown. Trigger on Meerkat, taskpanel, taskctl, the task board, a task card, `card.md`, card file, `export md`, re-export, brief, deliver, heartbeat, acceptance, review, or an awaiting question; on a `meerkat-loop` handoff or role workflow that only says read the brief or deliver the card. Works the same on any agent runtime — Claude, Codex, pi and OpenClaw are all covered.
---

# Meerkat TaskPanel

A local-first task board for AI Agent teams, driven entirely through the `taskctl` CLI: claim
a card, heartbeat, comment, deliver with a report; results roll up a parent/child tree.

This page is the **decision manual** — what to do, in what order, and which of two similar
commands to use. The board validates every write itself: a refusal returns a named code and
usually the command that satisfies it, so read that and act rather than pre-checking rules
from a document. Enforced rules are not restated here. Scheduling is the `meerkat-loop`
skill's job; the board owns the workflow decisions and the loop executes them.

Every card operation is defined here. The `meerkat-loop` scheduler, `setup-meerkat` and the
team role workflows point at this skill for card writes; they record only their own decisions.

> `src/…` and `docs/…` name the taskpanel **source repository**, not this skill. Everything
> you run is `taskctl`.

## Running the CLI

```bash
node scripts/run.mjs --help          # this skill's launcher
taskctl --help                       # when the shim is on PATH
```

`scripts/run.mjs` locates the CLI (`$MEERKAT_TASKPANEL_ROOT`, `$MEERKAT_TASKPANEL_REPO`, the
checkout, the shim, `PATH`) and propagates stdio and the exit code. The shim adds
`--actor-kind <kind>` and a default `--agent <name>`; `--actor-kind` is required except on
`--help`, `--version` and `status`, and a human writes with `--as-human`. Configuration is one
`.env` at the program root, read by both `taskctl` and `taskd` (process env wins key by key;
`--env-file` or `MEERKAT_TASKPANEL_ENV_FILE` selects another). Each actor kind also has a
per-kind config beside it, `<program root>/.env.<actor-kind>`, read by `taskctl` as a
per-agent default layer. `taskctl` starts a board if none
is running; `TASKD_NO_AUTOSTART=1` forbids that. All flags and exit codes:
[`references/cli.md`](references/cli.md).

## Reading a refusal

Every call returns `{ok:true, data}` or `{ok:false, error}`. Read a refusal in this order:
`error.code` (the stable branch point) → `error.hint.command` / `error.hint.fix` /
`error.hint.alternative` (usually the exact command or input change that satisfies the rule)
→ `error.details` (the fields the rule examined) → the prose `error.message` only last. Never
parse the message to decide what to do.

Retry only `VERSION_CONFLICT` (re-read once, then retry with the fresh `--if-version`) and
`DB_BUSY` (wait `Retry-After`). Everything else means "change the request", not "try again".
A rule this page omits is still enforced — an omission is not permission. The classification
behind that:
[`references/status-lifecycle.md#10-what-is-enforced-and-what-is-practice`](references/status-lifecycle.md#10-what-is-enforced-and-what-is-practice).

## Finding the data you need

The card's data is read through `taskctl`, and one read often answers several questions at
once. This table is the map; the full field list, and what each field means, is
[`references/card-schema.md#reading-a-card-as-json`](references/card-schema.md#reading-a-card-as-json).

| I need… | Run | Read |
|---|---|---|
| what a key or section means in an exported card (any `export md` output; the loop's brief is usually `.meerkat/<id>/card.md`) | — read the page | [`references/card-schema.md#field-reference`](references/card-schema.md#field-reference) |
| the whole picture for a progress answer, in one read | `issue get <ref> --json --include comments --include reports --include relations --include sessions` | `data.{task,comments,reports,relations,sessions}` |
| the card: title, description, status, priority, kind, role | `issue get <ref> --json` | `data.task.{title,description,status,priority,kind,role}` |
| the acceptance contract (frozen) | `issue get <ref> --json` | `data.task.acceptance[]` — never `meta.acceptance` |
| who is on it, the claim and its heartbeat | `issue get <ref> --json` | `data.task.{assignee,reporter,claimed_by_actor,claimed_at,heartbeat_at}` |
| the parent, children, ancestors, blockers | `relation list <ref> --json`, or `issue get <ref> --include relations` | `data.{parent_chain,children,ancestors,blocked_by,blocks}` — under `data.relations` when it came from `issue get` |
| the comment / decision trail | `comment list <ref> --json`, or `issue get <ref> --include comments` | `data.comments[]` |
| the delivery reports and their evidence | `report list <ref> --json`, or `issue get <ref> --include reports` | `data.reports[]` (`issue get` alone has only `report_waivers[]`) |
| the waivers and attachments | `issue get <ref> --json` | `data.report_waivers[]`, `data.attachments[]` |
| the sessions that worked a card | `session list <ref> --json`, or `issue get <ref> --include sessions` | `data.sessions[]` |
| what may I claim | `issue candidates --assignee <me> --json` | `data.candidates[]` |
| cards in a slice (project / status / parent / label / meta / target) | `issue list … --json` | `data.tasks[]` |
| the project ↔ directory map | `project dir <p> --json` | `data.dir` |
| the `--if-version` value for a write | `issue get <ref> --json` | `data.task.version` |

`--include` adds exactly what the standalone read returns; an unknown section is a usage error.
The **activity** trail is the one board read with no CLI verb: it is
`GET /api/v1/tasks/:ref/activities`.

### When a human asks

These are the questions a person actually asks. Answer them with the reads below, not by
piecing a card together from source.

- **"What is the progress of X?"** → one read:
  `issue get <ref> --json --include comments --include reports` (`data.task` for
  status/priority/delivery_round/acceptance_mode, `data.comments[]` for the trail,
  `data.reports[]` for the deliveries). Add `--include relations --include sessions` when the
  answer must cover blockers or who worked it. `--limit <n>` caps the comment trail (default
  50, newest first); `0` = all.
- **"What is still open?"** → `issue list --status todo --status in_progress --status awaiting
  --status blocked --status in_review --json`. `backlog` is not started yet — list it
  separately if the ask means "everything not done".
- **"How many were completed?"** → `issue list --status done --json`, and `--status canceled`
  separately. There is **no count or stats command**; count `data.tasks[]` locally, and say so
  if `--limit` truncated it.
- **"Look up card X"** → an identifier or UUID is `issue get <ref> --json`; a title or keyword
  has **no server-side search** — read `issue list --json` and filter `identifier` / `title`
  yourself.
- **"Push / cancel / put back in the backlog"** → `issue move <ref> <status>`; the whitelist
  decides what is legal and a refusal names the allowed targets. `canceled` is abandonment, not
  completion — say which one the ask meant.

## The card's life

A card has **seven stages** — `backlog`, `todo`, `in_progress`, `in_review`, `blocked`,
`done`, `canceled` — plus `awaiting`, an **attention overlay** for a card parked on a human
question (shown under `in_progress`). `done` and `canceled` are terminal, with one audited
exit: `issue reopen <ref> --reason "<why>"` returns the card to `todo` and starts a new
delivery round. A review card cannot be reopened — reopen the card it reviews.

The legal moves are the board's whitelist; it refuses every other pair and names the allowed
ones in `details` — attempt the move and read the refusal. The table and the guard on each
edge live in
[`references/status-lifecycle.md#2-the-whitelist`](references/status-lifecycle.md#2-the-whitelist).

**`done` is acceptance; `canceled` is abandonment.** Deliver, then stop at `in_review`; the
card's `acceptance_mode` names who may close it. Do **not** "close" a card — especially a
container — by canceling it: canceling is legal from most stages and has no child guard, so
it succeeds silently and leaves the work orphaned.

## Creating a card

`issue create` is the whole handoff: the card lands in `todo` — the queue the loop's poll
reads — in the same call, addressed to whoever it is assigned to. The queue is per assignee,
not global: `issue candidates` returns a card only to that name, and an unassigned card is the
public pool. Only `--status backlog` keeps it out of a queue. Describe the card by the `status`
the create returned: a repeated create answers with the existing one. The INSERT gate:
[`references/status-lifecycle.md#8-creating-a-card-in-a-status`](references/status-lifecycle.md#8-creating-a-card-in-a-status).

**A document the work must follow is attached, not retyped.** When the human points at a file —
a plan you wrote, a third-party spec, a vendor's PDF to read closely — that pointing *is* the
instruction; nobody says "upload it". Attach it straight after the create, and when the file is
the plan itself, store it as `plan.md` whatever it is called on disk — an export name like
`draft-7f3a.md` is not a name anyone will look for:

```bash
taskctl issue create --project <p> --title "…" --acceptance "…"
taskctl attachment add <ref> --file <path> --name plan.md   # the plan's one name; create has no --file
```

Anything else keeps its own name, and a plan that is not text keeps its extension (`plan.pdf`):
the board derives the stored type from that name, so a PDF called `plan.md` would be filed as
Markdown. The worker reads the card and its brief, never this conversation, so a path said only
here reaches nobody: the file is attached and `--description` points at the attachment instead
of retyping the document. A file named without a path gets one question for the path — never go
hunting the tree for a document nobody named.

**Say the outcome in one line, then stop**: the identifier, that it is queued, and the file
when you attached one, in the conversation's language —
`已建卡 PROJ-0007，已排队处理（附 spec.pdf）`. Do not ask whether to start, and with nothing
to attach say nothing about attachments.

## The language of a card

Write in the language the work is actually being done in. English is not the default: the
board stores text verbatim, so a card created in English pulls every later comment, question
and report into English even when the human has been writing to you in another language —
and each of those is a sentence they have to re-read in a second language.

Decide it from evidence, in this order:

1. **The human in this conversation.** Their own messages are the signal. If they write in
   Chinese, the title, description, acceptance items, comments, questions and report are in
   Chinese — even when the existing card is in English, because they are the one who has to
   read and accept it. Mixed input does not cancel it: a Chinese question carrying an English
   stack trace is a Chinese request. An explicit instruction ("write this one in English")
   outranks everything below.
2. **The card, then its project.** With no human message in this session — a loop tick, a
   handoff, a subagent — inherit what is already there: this card's own text, or for a new
   card the project's recent cards. A thread that changes language halfway is harder to
   follow than one written in the "wrong" language.
3. **The repository.** A project with no cards yet usually speaks its own language in
   `README.md`, `CLAUDE.md`/`AGENTS.md` or `GLOSSARY.md`; use it. Only a project with no
   signal at all falls back to English.

**What never translates, whatever the prose around it:** identifiers, command lines, flags,
error codes and status literals (`in_progress`, `E2`), field names, paths, code and log
excerpts, and a quoted sentence — quote it in its original wording rather than paraphrasing
it. A review card's first line stays exactly `VERDICT: APPROVE` or `VERDICT: REJECT`.

**A frozen acceptance item is a matching key, not prose.** Write the baseline in the card's
language when you create the card; after that, each entry's `text` in the report's
`acceptance[]` repeats the item character for character, because the gate matches report to
baseline by normalised text. Translate the `note`, the `conclusion` and the `leftovers`
around it, never the item itself. The same goes
for anything another author wrote or the board froze — an existing comment, a delivered
report: add your own text in your language and leave theirs as it is.

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

Then **stop**: acceptance is somebody else's act. An `epic` is a container — claim a leaf
child. A card held by someone else, or still in `backlog`, is not yours; the board refuses.

**The one silent exclusion is dependencies.** `issue candidates` withholds a card whose
`depends_on` (reversed `blocks`) predecessor is not `done` — a `canceled` predecessor
withholds it too. The claim verb does not re-check blockers by default (`--check-blockers`
does), so a direct claim can take a blocked card. If a card you expected is missing, run
`taskctl relation list <ref>`.

A heartbeat resets the claim and **nothing else** — not status, not claimer, not the delivery
round — and only the holder may send it. A claim you stop pulsing reads as abandoned.

### The acceptance list is the contract

`issue get <ref> --json` carries `acceptance[]` — the **frozen** snapshot the delivery gate
reads. `meta.acceptance` is only the seed it was copied from; the gate never reads it.

- **The snapshot is non-empty** — work to it. It is frozen: **append** with
  `issue update <ref> --acceptance "…"`; never replace or remove (removal is a human-only,
  audited prune). A wrong baseline means rework.
- **Empty, but `meta.acceptance` / `meta.acceptance_legacy` is not** — a grandfathered card;
  append as above, and the next round freezes it.
- **All three are empty** — an empty baseline is vacuous and would let the card reach `done`
  with nothing checked, so this is an acceptance decision, not a formality. Derive **1–6
  concrete, externally checkable** items (usually 2–6; never pad) only when the project
  session's handoff pre-authorized it for this card, persist them once, and record the act:

```bash
taskctl issue update <ref> --acceptance "…" --acceptance "…" --meta acceptance_derived=yes
taskctl comment add <ref> --kind note \
  --body "acceptance list derived at claim (pre-authorized): 1) … 2) …"
```

Without that pre-authorization, write an agent `question` comment describing the proposed
items and stop — leave the card `in_progress`; the project session answers and re-queues it,
and decides whether to escalate `E2`. Never derive on an **epic** (its acceptance is its
children) or on a **review card**. If the card is too thin to yield checkable items, say so in
the question rather than inventing them, and say in the delivery report that the list was
derived when it was.

The report must **cover the snapshot**: every item appears by text; `met` or `not_applicable`
(with a non-empty note) passes, `partial` / `not_met` block. A report item beyond the baseline
blocks too if it is unfinished. An imported checkbox list freezes as plain items: a tick on
the card is the author's intent, not this delivery's evidence.

### Delivering

`issue deliver` writes the report and moves to `in_review` in one transaction; use it rather
than a separate report write and move. A waiver (`--no-report --reason "<why>"`, ≥ 8
characters) excuses the report for one round, not acceptance.

The mode is resolved once, at creation: `--acceptance-mode off|agent|human` is the card's
snapshot; omitted, it follows the project's `acceptance` default (`auto` by default), where
the creator decides or the card falls back to `human` (an epic falls back to `off`). An `off`
card may go straight from `in_progress` to `done`; an `agent` card waits for the loop's
current-round `APPROVE`; a `human` card is closed by a person. An agent may only tighten a
mode (`off → agent|human`). A review card is always `off`. The board's matrix:
[`references/status-lifecycle.md#7-acceptance-one-mode-per-card`](references/status-lifecycle.md#7-acceptance-one-mode-per-card).

## Containers: when the card is an epic

A card filed from the web UI is always a `task`; an epic exists only where someone named one.
Splitting is a scope decision: it belongs to the project session (an out-of-scope expansion to
the human, `E1`), so a worker that finds several deliverables writes an agent `question`
comment describing the pieces, keeps the card `in_progress`, and stops. Decide what the card
*is* first: a title and description naming the **sum** of the work is the container; naming
**one deliverable** makes it a child.

| Card you have | Role | What to do |
|---|---|---|
| already an `epic` | — | add children; never convert it |
| `task`, no parent | the whole job | promote in place (below) |
| `task`, no parent | one deliverable among several | create a new `--kind epic` container; link it and the new children |
| `task`, with a parent | the whole job | promote to a nested epic; its parent edge stays |
| `task`, with a parent | one deliverable among several | keep it as a child; add siblings under the same parent |
| `in_review`, `done`, `canceled` or archived | — | do **not** promote; create a new container and link the old card as a child (or `related` for history) |
| a review card | — | do **not** promote; split a separate container |

**Promote before the card delivers its current-round report.** The rollup collects the
**children's** delivery reports, not the container's own history, so promoting a card that
already delivered strands every child attached after it. A card that has delivered starts a
*new* container instead.

```bash
taskctl issue update <ref> --kind epic       # the card keeps its status
taskctl comment add <ref> --kind note --body "split into N cards: …"
taskctl issue create --project <p> --title "…" --target <t> --acceptance "…"
taskctl relation add <ref> --type parent --target <child>     # <ref> is the parent
```

**An epic's acceptance is its children**; its delivery is a rollup of their reports. The board
starts the container when a child enters work, and closes it to `in_review` (never `done`)
when the tree is finished — but only from `todo`, `in_progress` or `blocked`: a `backlog` or
`awaiting` epic does not auto-start, and an `in_review` epic that gains a child is not rolled
up again (move it back to `in_progress`). An all-canceled tree is not a delivery — cancel the
container instead. Attempt the close; the refusal names anything still open.

Three rules that fail **silently**, so the board cannot teach them at that moment:

- **Each child needs its own `--target`.** The create guard keys on kind + assignee + source +
  target, so two children for one owner with nothing to tell them apart are the *same card*
  (the second create is read as a retry). Use `--allow-dup` when a target does not apply.
- **`issue create --parent <epic>` links nothing** — only `relation add --type parent` does.
- **A child attached after the rollup makes it stale**; rework the epic to start a new round.

Claim exactly **one** leaf child and work it as usual — the container holds no work of its
own. Full rules:
[`references/status-lifecycle.md#6-containers-epic`](references/status-lifecycle.md#6-containers-epic).

## Review cards (flow B)

A card is a review card when `issue get <ref> --json` carries `review_of_id` / `review_round`
(or `issue candidates --json` carries `review_of` / `review_round`). The `review` label is a
discovery aid, never the predicate. `meta.flow` absent means flow A; the loop writes
`meta.flow=B` on the review card it dispatches, and a flow-B card is never reviewed again.

Claim it like any `todo` card, but the work is a review, not a change to the original: read the
original's description, every acceptance item, the current round's report and evidence, the
comment trail and (for an epic) its children. Ledger the requirements first — every
requirement in the description, comments and plan needs an acceptance item *and* an
implementation, or the verdict is `REJECT` — then verify at the report's `commit` anchor
rather than the live tree, and answer every baseline item with a status, how you checked it,
and an `evidence[n]` anchor. A `met` the board cannot trace is refused, and so is an
`APPROVE` whose report records no command the reviewer ran. Then deliver a report **on this
card** whose first line is exactly `VERDICT: APPROVE` or `VERDICT: REJECT`; put the findings
after that line and in `leftovers`, as a numbered must-fix list on a `REJECT` — the loop
appends those items to the original's acceptance. Move neither card — the loop applies the
verdict and closes the review card. A delivery whose first line is not a verdict is still
accepted by the board; the loop records `verdict_unreadable`, so the review is wasted.

The review card's `review_round` is the **original's** audited round; its own `delivery_round`
is a different number. A re-delivery after a rejection needs a new review card. Full protocol:
[`references/review-workflow.md`](references/review-workflow.md).

## Waiting: a human question, or blocked

- A question for a person is **`awaiting`**, not `blocked` and not a chat message:
  `issue move <ref> awaiting --awaiting-reason E3 --question "…"`. The reason is one of `E1`–
  `E5` (scope · acceptance baseline · design direction · security · architecture), and an
  agent must also ask the question. **Any human comment** re-queues the card to `todo`;
  `awaiting → in_progress` resumes the same attempt without a new delivery round.
- **`blocked`** is for everything else. `--blocked-reason` is optional; its literals and
  meanings are in
  [`references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for`](references/card-schema.md#blocked_reason--what-a-blocked-card-is-waiting-for).

## Coordinating with other agents

- **Never force a conflict.** On `VERSION_CONFLICT`, re-read the card once and retry with the
  fresh `--if-version`; a blind retry is how two agents overwrite each other.
- **Stamp every write with your identity:** `--actor-kind <kind> --session-id <id>`.
  `taskctl session id <ref> --seg <seg> --owner <name>` derives it before a session starts;
  offline, [`scripts/session-id.mjs`](scripts/session-id.mjs) computes the same value from the
  resolved task UUID (`--task-id` from `issue get <ref> --json` → `data.task.id`).
- **Metadata has two writers.** `issue meta` is a read-modify-write with `--if-version` that
  preserves value types; `issue update --meta` merges but stringifies new values and sends no
  CAS, so a concurrent write can be lost. Use `issue meta` for machine keys. Neither writes
  `acceptance[]`.
- **The board runs no timer.** The `meerkat-loop` skill owns the scheduler — add no second
  poller. A service with its own timer drives one tick of `candidates → claim → heartbeat`,
  binding to `error.code` and the hint fields, never to prose.

## Configuring project directories

**The board holds no directories.** The only answer is the machine-local map at the
program's config root (`<config root>/projects.json`), read with `taskctl project dir`
and changed only with `taskctl project map`. Schema, validation codes and the maintenance
commands are in [`references/projects-json.md`](references/projects-json.md). **Never read
or edit `projects.json` by hand** — the CLI is what validates the directory and keeps the
file's shape stable.

A project with **no directory** is an entry naming none: `taskctl project dir <project>` says
so and succeeds. Do not invent one. A project **absent** from the map has no registered
directory and the board cannot supply one — do not guess. When a step needs it, stop and ask:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will register it with
`taskctl project map set <project> --local-path <dir>` — the board cannot supply one.
```

Claiming, moving, commenting and delivering need no directory.

## Keeping the brief fresh

A card exported into a project directory is a **snapshot**. Register it once with the local
event hub — `export watch <ref> --dir <dir> --detach` — and check it with `--watch-status`.
The hub, not your shell, owns the board connection, so never use a plain `&`; the portable
form is `--once`, and `--stop` ends it. It writes `.meerkat/<identifier>/card.md`, stops at
`done` or `canceled`, and is one-way — re-read the brief before a decision, and never hand-edit it. **A
loop-dispatched worker starts no watcher**: the loop's poll already registered the hub watch for
its brief. Detail:
[`references/cli.md#export-watch`](references/cli.md#export-watch).

## Where to look

| You need… | Read |
|---|---|
| a transition, guard, delivery round, claim window, refusal code, or the board's workflow plan | [`references/status-lifecycle.md`](references/status-lifecycle.md) |
| a command, its flags, exit codes, the `--json` envelope, or the live-stream contract | [`references/cli.md`](references/cli.md) |
| what a reviewer reads and writes, and the two-round model | [`references/review-workflow.md`](references/review-workflow.md) |
| the card's wire object (`issue get --json`), the exported-card file format (what `export md` writes, including a loop brief), identifier syntax, or `blocked_reason` meanings | [`references/card-schema.md`](references/card-schema.md) |
| the `taskctl` invocations and JSON keys a supervisor binds to | [`references/capabilities.md`](references/capabilities.md) |
| the project ↔ directory map (`taskctl project dir`, `project map`) | [`references/projects-json.md`](references/projects-json.md) |
