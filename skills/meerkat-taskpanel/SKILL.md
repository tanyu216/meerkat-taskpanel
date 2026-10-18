---
name: meerkat-taskpanel
description: Coordinate work across an AI Agent team using a shared local task board. Use when an agent or a human needs to create and track tasks, move them through a status workflow, assign owners, comment on a decision, edit a task's description or its priority, link parent/child and blocking relations, record which agent session is working on what, deliver a task with a report, write a periodic (daily / weekly / monthly) report with statistics over completed work, or export the board as markdown. Runs the local `taskctl` CLI; no network required.
---

# Meerkat TaskPanel

Meerkat TaskPanel is a local-first task board for AI Agent teams. Agents coordinate through a
single shared state store instead of ad-hoc chat messages: each agent claims a task, sends
periodic heartbeats so the board can tell liveness from abandonment, reports progress and
status transitions, and rolls child results up its dependency tree.

This skill is the agent-facing entry point. It is a thin wrapper over the `taskctl` CLI.

> **Status: M2.** The command surface is implemented and aligned with `task-interface v1`.
> `taskctl` is an HTTP client for `taskd`, the local board service, and starts one
> when there is none (set `TASKD_NO_AUTOSTART=1` to forbid that). See
> `references/cli.md` for the full surface, the delivery gate and the `--json` contract.

## Running the CLI

From this skill's directory:

```bash
node scripts/run.mjs --help
node scripts/run.mjs --version
```

`scripts/run.mjs` is a launcher: it finds the board CLI, spawns it with your arguments,
pipes stdin/stdout/stderr through, and propagates the exit code. It is safe to call from
any working directory, and it looks for the CLI in this order — using the first that
exists, and never assuming one:

1. `$MEERKAT_TASKPANEL_ROOT/src/cli/index.mjs` — a root you name explicitly;
2. `$MEERKAT_TASKPANEL_REPO/src/cli/index.mjs` — the key `install.sh` records in the host
   config;
3. the checkout this skill sits in, when it is in one;
4. **the `taskctl` shim `install.sh` writes beside this skill** (`<host>/bin/taskctl`);
5. `taskctl` on your `PATH`.

So inside a checkout it runs the CLI beside it; installed on its own — which is how
`install.sh` distributes it, and how every host consumes it — it uses the host's own shim,
or a `taskctl` you have installed, or a checkout you name. When it finds none of the five it
**stops with a message saying where it looked and the ways to fix it**, rather than dying
inside Node.

Rung 4 is the one that carries your identity, and it is why the ladder prefers it over a
bare `taskctl`: the shim spawns the CLI with `--agent <name> --actor-kind <host>` on every
call, so a write from this skill is recorded as *this agent* rather than as the person the
board would otherwise assume. It sits below the checkout rungs because an explicit root —
and a checkout the skill is lying in — is more specific than a wrapper written at install
time.

If `taskctl` is on your `PATH` (installed via `install.sh` or `npm link`), call it directly:

```bash
taskctl --help
```

> **What a `src/…` path means in these references.** Paths written as `src/…` (and
> `docs/…`) are in the **taskpanel source repository**. This skill ships only `SKILL.md`,
> `references/` and `scripts/`, so such a path is *provenance* — where a fact is defined —
> and not a file you can open or run from an installed copy. Everything this skill asks you
> to *run* goes through `taskctl`; where a reference documents a command that genuinely
> needs the checkout, it says so.

## Claiming work (claim-first)

**Claim first, and only claim what is yours to claim.** Before touching a card,
read the claimable set for *you* and take exactly one:

```bash
taskctl issue candidates --assignee <me>   # read-only: what may I claim?
taskctl issue move <ref> in_progress       # take exactly one
```

Do **not** claim a card that any of these is true of — it is not yours:

- it is **assigned to someone else** (the board refuses a claim by a different
  actor; it is never silently reassigned);
- it sits in **`backlog`** and has not been released for work (only the
  dispatcher or a human moves it to `todo`);
- it is an **`epic`** — a container, not a unit of work; claim its leaf children;
- it is a **deployment card** (`kind: deploy`) — deployment work runs against a
  live instance and is dispatched explicitly, so it is never auto-claimed;
- a **`depends_on` blocker is not `done`**.

`issue candidates --assignee <me>` already withholds the last three; use
`taskctl relation list <ref>` when a card you expected is missing. Hold **one
card at a time**, keep its claim fresh, deliver with a report, and stop at
`in_review` — a human accepts to `done`.

Keeping that claim fresh is a **command you run**, not a hope — the board sends
no pulse of its own, because nothing but you knows the work is still going:

```bash
taskctl issue heartbeat <ref>              # at least every 10 minutes while you work
```

It resets the heartbeat and **nothing else** — not the status, not the claimer,
not the delivery round — and only the holder may send it. A claim you stop
pulsing is meant to read as abandoned (see
[`references/practice-guides.md`](references/practice-guides.md) rule 4).

These are the eight shared rules: claim-first, claim only what you should, one
card at a time, a fresh heartbeat, deliver with a report, self-review ≠
acceptance, never preempt a conflict, and stay traceable. The full statement, the
per-host differences (Claude Code / Codex) and a worked example are in
[`references/practice-guides.md`](references/practice-guides.md).

## When the card is a container (promote it to an epic)

A card filed from the web UI is always a `task` — the create dialog has no `kind` field at all
— so an epic exists only where someone named one. When the card in your hand turns out to hold
several deliverables rather than one, make it the container **before** you work any of them:
only an epic may be a parent, so an un-promoted card cannot carry children.

```bash
taskctl issue update <ref> --kind epic                          # the card becomes the container
taskctl comment add <ref> --kind change --body "split into N cards: …"
taskctl issue create --project <p> --title "…" --target <t> --acceptance "…"   # one card per piece
taskctl relation add <ref> --type parent --target <child>        # <ref> is the parent
```

Four board facts decide that order:

- **An epic can never be claimed.** `issue move <epic> in_progress` is refused (`not_claimable`)
  and `issue candidates` never offers one — so a card that should end up `in_progress` must be
  claimed **while it is still a `task`**, and promoted after.
- **The board starts the epic for you.** The first child to enter `in_progress` moves the
  container `todo → in_progress` — a **system** move (no `claimed_by`, a `epic_auto_start`
  activity, and a `kind=note` comment saying which child started it). An epic that is already
  `in_progress` is left alone, so the transition happens once however many children are claimed.
- **An epic's route into review is its own.** `todo → in_review` is legal **for an `epic` only**
  — a container never enters the work cycle, so its `todo` row carries the delivery edge a task's
  does not. In practice the container is started by its first child and closed from
  `in_progress`; the direct edge remains the repair path for a child attached after it finished.
  (A `task` in `todo` still cannot reach `in_review`; the exception is scoped to the kind, not to
  the status.)
- **`issue create --parent <epic>` does not link anything.** On create, `--parent` only fills the
  idempotency key's source slot; the edge is `relation add … --type parent`, and only an `epic`
  may be the parent.
- **The promotion is an ordinary patch, not a new card.** It bumps `version` and records one
  `task_updated` activity, and changes nothing else — status, the claim, the heartbeat and the
  delivery round all stay put, so nothing has to be re-linked. What it does *not* leave is a
  comment, which is why the split is written down in the step above.

Create each child as an ordinary card, assigned to the epic's assignee unless you know a better
owner for that piece, with one deliverable and its own acceptance list. **Give each child its own
`--target`** — the piece's handle (a path, an area, a contract): the create guard keys on
kind + assignee + source + target, so two children for one owner with nothing to tell them apart
are the *same card* — the second create is read as a retry of the first, not a sibling. Use
`--allow-dup` when a target genuinely does not apply. Then claim exactly **one** child and work it
as usual: the container holds no work of its own, so it does not count against your one card.

**The board closes the container for you.** When the last child is accepted to `done` and every
other child is finished — `done` or `canceled` — the board writes the container's rollup report
(one acceptance line per child, carrying the children's own delivery evidence) and moves the epic
to `in_review` in the same transaction as that child's move. It also leaves a `kind=note` comment
naming the source (`event`), the basis (`N/N` children terminal, how many done/canceled), and the
instant. You do not deliver it; "who closes it" is answered by the board, not by whoever happened
to finish last. A human still accepts `in_review → done`, which is why a **nested** container's
parent keeps waiting until the inner container is accepted.

- **A `canceled` child does not block the close** — it is terminal, like `done`. The rollup report
  lists it as `not_applicable` with the cancellation reason from its own comment trail, so the
  person accepting the container can decide whether finishing without it was right. Write that
  reason as a comment on the child when you cancel it; a card with no trail says so explicitly.
- **A container with nothing delivered stays open.** If every child was canceled, or every
  delivered child was waived (`--no-report`, no evidence), there is nothing to roll up; close it
  by hand: `taskctl report template <ref>` then `taskctl issue deliver <ref> --report-file -`
  (the delivery gate still applies).

**The reconciler is the backstop, not a step you owe.** A child attached *after* it started or
finished fires no status transition, and a write that bypassed the service layer (a direct edit)
can leave the container behind. `taskctl issue reconcile --dry-run` reports what the board would
do; `taskctl issue reconcile` applies it. It scans every non-terminal epic, writes only start/close
transitions that the rules allow, and is idempotent — a second run over the same board writes
nothing. The same sweep runs once at `taskd` startup; you never need it for the ordinary path.

**The container rests in `todo` until work starts.** An epic is not claimed, so `todo` is a
resting place rather than a queue position; its first child's claim starts it. Moving it to
`blocked` is still legal, and still right when the container really is waiting on something
external.

## When to use it

- **Finding the board** — the board holds no directories; look the directory up in the
  `projects.json` kept beside this skill (see
  [Configuring project directories](#configuring-project-directories)).
- **Starting work** — `taskctl issue candidates --assignee <me>` to find your
  claimable cards, then `taskctl issue move <id> in_progress` (see
  [Claiming work](#claiming-work-claim-first)).
- **Asking for something** — `taskctl issue create --project <id> --title "…" --acceptance "…"`.
- **While working** — `taskctl comment add <id> --body "…"`; a `decision`/`change`
  comment is what a reviewer reads later.
- **Editing a card** — `status` moves (`issue move`), `priority` and the markdown
  `description` patch (`issue update`), files go through `attachment add|list|remove`,
  and `depends_on` is a `relation` written from the blocker's side. Downloading a
  file is the API's alone (`GET /api/v1/attachments/:id/content`); removal is a
  hard delete. The five edits, capability by capability, are in
  [`references/cli.md`](references/cli.md#editing-a-card-status-priority-description-attachments-dependencies).
- **Delegating** — make the card a container and split it: `taskctl issue update <ref> --kind epic`
  to promote one you already hold (or `taskctl issue create --kind epic …` for one you are filing
  fresh), then one `taskctl issue create` per child and a
  `taskctl relation add <ref> --type parent --target <child>` per edge. The container needs no
  parking move — an `epic` may be delivered out of `todo`. See
  [When the card is a container](#when-the-card-is-a-container-promote-it-to-an-epic).
- **Finishing** — `taskctl report template <id>` to get a report, fill in the TODO
  lines, then `taskctl issue deliver <id> --report-file -`. **The board will not let a
  task into `in_review` without a report** for the current round: the refusal prints the
  exact command that fixes it.
- **Reporting on a period** — `node scripts/report.mjs --period daily|weekly|monthly`
  builds a daily/weekly/monthly report plus its statistics from the cards completed in
  the window. `--group-by` picks the dimension (`kind` by default, or `project` /
  `assignee` / `status` / `label:<namespace>`); `--preset <name>` adds named metrics —
  the shipped `software` preset is one example, and the statistics are domain-agnostic.
  The templates, the counting rules and how to define your own metrics live in
  [`references/reports.md`](references/reports.md).

## Configuring project directories

**The board holds no directories.** A board project carries no `workspace_path`, there is
no `context` command, and the file importer names no directory anchor — by design:
taskpanel does not manage project directories (and does not manage project *data*
either). The **local** map is a `projects.json` kept **beside this skill** (next to
`SKILL.md`), and it is the only place that answers "which directory does work for this
project happen in". That directory is where a **worker starts** — not where results are
stored; where a project keeps what it produces is nobody's business but its own.

Add one entry per project — the **board project identity**, plus the directory if the
project has one:

```json
{
  "projects": [
    { "local_path": "/Users/you/code/meerkat-taskpanel", "project": "TaskPanel" },
    { "run_dir": "/Users/you/ops-inbox", "project": "Ops" },
    { "project": "Community" }
  ]
}
```

`project` is the board project — its **id** (preferred) or name. `local_path` is the
project's own directory, an **absolute** path that exists and *is* a directory;
`run_dir` is where a worker starts for a project that has no directory of its own, and is
only consulted when `local_path` is not given (`dir = local_path ?? run_dir`). Both are
**checked**, and a path that is relative, missing, not a directory — or a key that is
there but empty — is as unusable as no entry at all: a stale path is a moved checkout, and
a worker started there would be working the wrong repository.

A directory resolves to the entry whose `local_path` is that directory or an ancestor of
it; when several match, the **longest** path wins. `run_dir` never takes part in that
direction — a launch directory (an inbox, a home directory) says nothing about which
project you are working for.

**No directory is an answer, not a gap.** A project whose work needs no checkout —
operations, coordination, research — is registered with an entry that names no directory
at all, and `taskctl project dir <project>` then says so and succeeds. Do not point such a
project at a directory "so the command works". A **wake** still needs somewhere to start a
worker: give the entry a `run_dir`, or work that project by hand.

**Ask when there is genuinely no answer.** A project **absent** from `projects.json` has
no registered directory, and the board cannot supply one. Do not guess, and do not derive
one. When a step needs the directory — a wake, or any command that must run *in* the
project — stop and **ask the user which directory it is**:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will add it to projects.json beside this skill
(references/projects-json.md) — the board cannot supply one.
```

The same prompt applies to a registered-but-unusable path, naming what is wrong
(missing, relative, or not a directory). `taskctl project dir <project>` is the command
form of this rule: it prints the resolved directory, prints that the entry names none, or
exits non-zero with that question instead of continuing. The **wake glue** uses the same
map and the same rule, so a woken worker runs in the directory the map names — or the wake
is refused.

Work that needs no directory (claiming, moving, commenting, delivering) is unaffected.
The full schema, the resolution rule and the re-install behaviour are in
[`references/projects-json.md`](references/projects-json.md).

Three boundaries this respects, on purpose: **taskpanel does no project-directory
management**, **it does not manage project data** — what a task produces and where that is
kept is the business's call, and the board only keeps task data complete, reliable,
traceable and auditable — and **whether you manage a project's source data with `meta` is
your own call**: the metadata key set in `projects.json` is yours too, defined by the work,
read from the file, never prescribed here.

## Reference

See [`references/card-schema.md`](references/card-schema.md) for the **card format** — every
frontmatter key and every body section, i.e. what `taskctl export` writes and the md migrator
reads back (the known keys, what an empty value means, and how a card round-trips),
[`references/cli.md`](references/cli.md) for the command surface, the delivery gate,
the report template and the `--json` contract,
[`references/reports.md`](references/reports.md) for periodic reports and statistics,
[`references/projects-json.md`](references/projects-json.md) for the local
project ↔ board project map, and
[`references/practice-guides.md`](references/practice-guides.md) for the claim-first
practice guide (Claude Code / Codex best practices).
