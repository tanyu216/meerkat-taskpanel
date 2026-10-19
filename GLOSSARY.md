# Meerkat TaskPanel

A local-first task board for AI-agent teams: agents create the work, claim it, send
heartbeats, report progress and roll results up a dependency tree, while humans watch the
same state on a deliberately read-only board.

This is the vocabulary of that system — one word per concept, the words to avoid, and a
closing list of words that do **not** mean what a newcomer expects them to.

> `_中文_` marks the Chinese wording this project's own zh-CN documentation already uses for
> a term. Where a term has no established Chinese word, the line is omitted on purpose: the
> zh-CN README keeps such terms in English (`epic`, `rollup`, `append-only`), and inventing a
> translation would mint vocabulary the project does not use.

## Language

### The board

**Board**:
The system as a whole, and in particular the deliberately read-only kanban view where
humans watch the same state the agents write.
_中文_: 看板
_Avoid_: dashboard, app, UI

**Project**:
The board's grouping of cards — a name, a label set, free-form meta and the counter that
issues identifiers. A project carries no working directory; where the work happens is a
local, per-machine decision, not a property of the project.
_中文_: 项目
_Avoid_: repo, workspace, directory, repository

**Card**:
The atomic unit of work — one thing a team can claim, work and deliver. It is the product
word for what the code calls a task.
_中文_: 卡（卡片）
_Avoid_: Task, ticket, issue

**Identifier**:
A card's human-facing name, `<PREFIX>-<serial>`, zero-padded (for example `DEMO-0007`).
_Avoid_: id, key, ref, number

**Prefix**:
The project half of every identifier that project issues. It is the project's declared
prefix if it has one, otherwise derived from the project id, and no two projects may share
one.
_Avoid_: namespace, code, tag

**Label**:
A free-form tag on a card, registered per project and normalised so that two spellings of
one word are one label. Unused labels are collected after a TTL.
_Avoid_: tag, category, keyword

**Actor**:
Anyone or anything that can be recorded as having done something — a human, an agent or
the system. Actors are created by use and are never renamed or deleted.
_Avoid_: user, owner, person

### The lifecycle

**Status**:
A card's position in its lifecycle — one of `backlog`, `todo`, `in_progress`, `in_review`,
`blocked`, `done`, `canceled`, plus the `awaiting` overlay.
_中文_: 状态
_Avoid_: state (that is a different thing — see *Claim*)

**Stage status**:
The seven statuses that are the board's columns. `awaiting` is not among them: it is an
attention overlay on a card that is otherwise in progress.
_Avoid_: column, lane, swimlane, phase

**Kind**:
What a card *is* — `task`, `epic` or `deploy` — as opposed to where it currently sits.
Only an epic may be a parent; a deploy card is withheld from automatic claiming.
_Avoid_: type, category

**Priority**:
How urgent a card is: `low`, `medium`, `high`, `urgent`. It is a claim of urgency, not a
measurement, and it never changes a card's status.
_Avoid_: severity, importance

**Comment**:
An append-only note on a card, written by an actor and typed by intent (`discuss`,
`decision`, `confirm`, `change`, `note`, `defect`). Comments are never edited or deleted.
_中文_: 评论
_Avoid_: message, post, reply

**Decision**:
A comment of kind `decision`, `confirm` or `change` — the record of a human choice. Only
humans make decisions; not every comment is one.
_中文_: 决策
_Avoid_: approval, verdict

### Claim and execution

**Claim**:
Taking a card to work on it — the move from `todo` to `in_progress`. Claiming is atomic:
one claimer, or none.
_中文_: 认领
_Avoid_: assign, take, lock

**Assignee**:
The actor a card is routed to — whose job it is. Assignment is responsibility, not
ownership, and an unassigned card is not unowned: it is in the open pool.
_Avoid_: owner, holder, claimer

**Claimer**:
The actor currently executing a card, as distinct from its assignee. A card can be assigned
to one actor and claimed by another; the claim is the execution lock, the assignment is the
route.
_Avoid_: holder, owner (see *Assignee*)

**Heartbeat**:
The signal a claimer sends to say "still working". It refreshes a claim's freshness and
never changes a card's status. A fresh heartbeat is what separates a live claim from a
stale one.
_中文_: 心跳
_Avoid_: ping, keepalive, poll

**Session**:
The record of which conversation is doing the work on a card. It is the trail that answers
"which agent, in which run, touched this", and it is distinct from the actor.
_中文_: 会话
_Avoid_: connection, run, thread

**Segment** (`seg`):
The discriminator that lets one card have several concurrent working conversations. A
session is identified by the card, the owner and the segment together.
_Avoid_: part, shard, chunk

**Candidate**:
A card the loop may claim, with the reason it qualified — `ready` (assigned and unblocked),
`unassigned` (open pool), `stale_same` (held too long by its own holder) or `stale_any`
(held so long that anyone may take it).
_中文_: 候选
_Avoid_: proposal, suggestion

**Open pool**:
Claimable cards that have no assignee. They are available to anyone rather than belonging
to nobody.
_Avoid_: backlog, queue, unassigned list

### Delivery

**Delivery round**:
The counter on a card that the delivery gate reads. A report is evidence only for the round
it was written in; leaving `in_review` starts the next round, which is why last round's
report no longer counts.
_中文_: 当轮
_Avoid_: iteration, sprint, cycle, attempt

**Delivery gate**:
The rule that a card may reach `in_review` only with a report written for its current
delivery round. It is enforced both in the database and in the application, and the two are
tested against each other.
_中文_: 交付门禁
_Avoid_: review gate, checklist, policy

**Acceptance authority**:
The actor kinds permitted to move a card into `done` — a human, or the board itself
(`system`). A worker agent may not accept, including on its own card: acceptance is a
separate act from delivery, and the board refuses the shortcut.
_中文_: 验收权限
_Avoid_: approver role, reviewer (the reviewer reports; it does not accept)

**Report**:
The record of what was delivered — a conclusion, the acceptance items and their verdicts,
and at least one piece of evidence. A report is evidence of work, not a promise of it.
_中文_: 报告
_Avoid_: summary, update, status

**Report origin**:
Whether a report was written on the delivery path (`delivery`) or imported from an older
source (`import`). Only a delivery report opens the gate.
_Avoid_: source, channel

**Acceptance**:
A stated condition for a card being done, together with whether it was met, partially met,
not met, or not applicable. It is what a report is evidence against.
_中文_: 验收
_Avoid_: criterion, requirement, DoD

**Evidence**:
A concrete pointer supporting a report — a commit, a path, a command or a coverage figure.
Evidence is what makes a report checkable rather than merely asserted.
_Avoid_: proof, artifact, link

**Waiver**:
The one audited escape from the delivery gate — a move to `in_review` with no report,
carrying a reason. It only excuses the round it names, and the reason is kept on the record.
_中文_: 弃权
_Avoid_: bypass, exemption, skip, override

### Structure and flow

**Relation**:
A typed edge between two cards: `parent` (containment), `blocks` (ordering) or `related`
(symmetry). Relations are immutable — you add and remove them, never edit them.
_中文_: 关系
_Avoid_: link, edge, association

**Parent / child**:
The containment edge. Only an epic may be a parent, and a parent may not be moved into its
own subtree.
_中文_: 父子
_Avoid_: master/detail, super/sub

**Blocks**:
The ordering edge — the source card must finish before the target can proceed. It is a
dependency, and it is not the same as the target being blocked.
_中文_: 依赖
_Avoid_: depends, prerequisite, wait

**Epic**:
A card of kind `epic` that groups children and rolls their results up. An epic is never
claimable — it is a container, not a unit of work.
_中文_: epic（中文镜像沿用英文）
_Avoid_: 史诗, milestone, theme, umbrella

**Blocked**:
The status for a card that cannot proceed. It is the *card's own* declared state, and it
is not the same as having an unresolved blocker.
_Avoid_: waiting, on hold, stuck

**Blocked reason**:
Why a card is blocked — one of a fixed set (`clarify`, `decision`, `dependency`,
`out_of_bounds`, `defect`, `external`, `resource`, `unknown`). It says who or what the card
waits for, never how bad it is.
_Avoid_: severity, cause, note

**Awaiting**:
The overlay for a card that has stopped to ask a human a question. It is entered only from
`in_progress` and left only by resuming or cancelling — it is not an eighth column.
_Avoid_: pending, on hold, blocked

**Awaiting reason**:
The category of the question being asked — a fixed enumeration, never free text. It says
what kind of answer unblocks the card, not what the answer is.
_Avoid_: question, topic

**Activity**:
An append-only audit row recording that something happened on a card. Activities are the
board's history and its change feed; they are the loosest, most deliberately untyped
surface in the model.
_中文_: 活动
_Avoid_: event, log (see *the loop* for alerts)

**Idempotency key**:
The value that makes creating the same card twice return the first one instead of a second.
It derives from the card's kind, assignee, source and target — a mechanical backstop to the
agent's own judgement, not a substitute for it.
_中文_: 幂等
_Avoid_: dedupe key, hash, unique key

## The loop

The loop is the part that keeps a board moving when no agent is watching. Its vocabulary is
its own and does not appear in the board's wire surface.

**Supervisor**:
The host-external process that watches the board and starts workers. It runs outside the
agent host, but it is neither the board service nor an agent itself.
_中文_: 监督进程
_Avoid_: daemon (that is the board service), scheduler, cron

**Poll**:
The frequent scan for new claimable work. Its only job is to find work and dispatch it.
_中文_: 轮询
_Avoid_: tick, scan, sweep

**Patrol**:
The slower pass with two halves. Its **SLA half** finds work already *stuck* — stale
claims, overdue waits, a silent inspector — and raises alerts without moving a card. Its
**workflow half** is the loop's one writing channel: it reconciles containers, dispatches
reviews and applies verdicts. Say which half a sentence is about; "the patrol never moves
a card" is only true of the SLA half.
_中文_: 巡检
_Avoid_: audit, sweep, health check

**Review card**:
An ordinary `task` card that audits another card: it records `review_of` (the original),
`flow=B` and the delivery round it audits, and carries the reviewer's verdict report. It is
not a `kind` of its own, and it reaches `done` through `in_review` like every other card.
_中文_: 审核卡
_Avoid_: review task kind, acceptance card, approval

**Reviewer**:
The independent agent a review card is assigned to. It reads the original's evidence and
reports a verdict; it moves no card. The loop is the acceptor.
_中文_: 审核员
_Avoid_: approver, acceptor, QA

**Epic triage**:
The worker's Step 0 decision — before starting, does this card contain several independent
deliverables, and should it therefore become an `epic` split into children? It happens in
the worker's own first turn, not in a separate planner.
_中文_: 升格判断
_Avoid_: planning, decomposition, estimation

**Wake**:
Starting one worker, once, with a bounded prompt. A wake is dispatched only for work the
loop actually claimed, and it is idempotent.
_中文_: 唤醒
_Avoid_: spawn, launch, trigger

**Handoff**:
The fresh, bounded briefing a wake gives a worker — the card, the exact commands to run,
and the identity to record. It is deliberately built new each time rather than resumed, and
it names no workspace.
_中文_: 交接
_Avoid_: prompt, context, briefing

**Tier**:
A card's hard ordering band within the assignee weight order — movable, stalled, or with
others. Tiers come before any score: a card never outranks one in a better tier.
_Avoid_: bucket, group, level

**Weight order**:
The optional ordering of a card list by urgency rather than by board position. It is
computed by the server, consumed as-is by the client, and exposed for inspection on request.
_Avoid_: sort order (a different, stored value), ranking

**SLA row**:
One named rule the patrol checks — a stale heartbeat, a stalled leader, an overdue
confirmation — each with its own threshold and its own repair.
_Avoid_: rule, check, metric

**Alert tuple**:
The identity of one alert: the card, the SLA row and the severity, plus the moment it began
to be measured. Re-raising the same situation re-uses the same identity, so a repeated
problem does not become a second alert.
_Avoid_: notification, event, message

## Process and repository

Terms about *this repository's* way of working. They are not board concepts, but they are
load-bearing in the same conversations and are easy to mistake for board vocabulary.

**Container gate**:
The authoritative verification run — the whole test suite executed inside a built image. It
bakes the tree it finds when the build starts, so the commit must land before the run.
_Avoid_: CI, build, pipeline

**Host-allowed check**:
One of the few checks that may run on the host instead of in the container — static
inspection, pure tests, and the browser-rendered frontend checks. Everything that *runs* the
product runs in the container.
_Avoid_: local check, quick test

**Lane**:
A parallel workstream in this repository's workflow — an isolated git worktree on a branch
named for the card and its segment. It is tooling vocabulary: the board has no lanes.
_Avoid_: 泳道, swimlane, column

**Release tree / hosted frontend root**:
Two different build outputs that are easy to conflate. The release tree is the npm package
tree and is never served; the hosted frontend root is the built web frontend, which the
board serves.
_Avoid_: dist, build (both are ambiguous here)

**Generated copy**:
A file that is produced from another source and must never be hand-edited. Editing a source
without regenerating its copies is drift, and drift fails the build.
_Avoid_: duplicate, mirror, fork

**Skill**:
The unit an agent installs to use the board — the board skill for working cards, and the
loop skill for supervising a board. They version independently.
_Avoid_: plugin, extension, tool

## Not part of the model

A glossary is where a newcomer goes to confirm a word, so these are stated plainly. Each one
is a term that reads as if it must exist, and does not.

**Iteration**:
Does not exist. Grouping cards into iterations is a roadmap item; no card, table, command or
wire field carries one. Sprint is not a synonym here — it is another name for the thing that
is not built.
_中文_: 迭代（规划中，尚未实现）
_Avoid_: sprint, cycle, milestone

**Card (as a type)**:
There is no card type. The type is the task; "card" is only the word people use for it. A
card in the importer's sense — a markdown file — is a third, file-level meaning.
_Avoid_: treating "card" as an entity name in code

**Agent (as a type)**:
There is no agent type. An agent is an actor whose kind is `agent`, together with the
sessions it opens; the word names a role, not a structure.
_Avoid_: `Agent`, `AgentService`, agent object

**Report digest**:
Does not exist. Reports are stored whole. The word "digest" in this codebase means a hash,
and separately names the loop's batched notification mode — neither is a property of a
report.
_Avoid_: digest, report summary, report hash

**Rollup**:
Informal prose for how child results aggregate into an epic, and for the periodic report
that summarises a window of work. It is a behaviour, not a field, command or type — do not
look for a rollup object.
_中文_: rollup（中文镜像沿用英文，非字段名）

**State**:
Not a synonym for status. A card's status is where it sits in its lifecycle; its execution
state is the coherence of its claim — whether it is claimed, by whom, and whether it is
still fresh.
_Avoid_: using state and status interchangeably

**Migration**:
Deliberately overloaded, and the two senses are unrelated. One is a change to the database
schema; the other is taking over a team's existing markdown cards. The repository names both
"migration" on purpose — read the surrounding sentence to tell which is meant.
_中文_: 迁移（数据库结构与「接管旧卡片」共用一词）
