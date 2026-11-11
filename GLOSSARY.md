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

## Product language

The product's own vocabulary — the board's views, the drawer, the roster, the create dialog's
fields, the status and priority chips — is recorded in [`design/DESIGN.md`](design/DESIGN.md) and
the prototype under `design/`. Its terms are **not copied here**: this file is the codebase's
vocabulary, and a word the UI owns belongs to the UI's document. Where the two name the same
concept, the codebase word is the one code and `taskctl` output use.

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

**Project map**:
The one machine-local `projects.json` at the config root, mapping a project to the
directory its workers run in. It is never board data: `taskctl project map` is its only
writer, `taskctl project dir` its reader.
_中文_: 项目映射
_Avoid_: workspace registry, project directory setting

**Card**:
The atomic unit of work — one thing a team can claim, work and deliver. It is the product
word for what the code calls a task.
_中文_: 卡（卡片）
_Avoid_: Task, ticket, issue

**Identifier**:
A card's human-facing name, `<PREFIX>-<serial>`, zero-padded (for example `DEMO-0007`).
_Avoid_: id, key, ref, number

**Prefix**:
The project half of every identifier that project issues. A new project's prefix is 1–4
characters of `A`–`Z` and `0`–`9` after normalization, declared with `meta.prefix` (the CLI
spelling is `taskctl project create --prefix`) or else derived from the project id; a value
outside that shape refuses the create. Rows that predate the rule keep their longer or
hyphenated token. It is fixed at creation, and no two projects may share one.
_Avoid_: namespace, code, tag

**Label**:
A free-form tag on a card, registered per project and normalised so that two spellings of
one word are one label. Unused labels are collected after a TTL.
_Avoid_: tag, category, keyword

**Actor**:
Anyone or anything that can be recorded as having done something — a human, an agent or
the board. Actors are created by use and are never renamed or deleted.
_Avoid_: user, owner, person

**Actor kind**:
Which application wrote: a platform slug (`claude`, `codex`, `pi`, `openclaw`), the board's
own `system`, or `human` — the one reserved value a caller may not
declare. It is recorded on every write and read back as `author_kind` / `owner_kind`;
the CLI flag is `--actor-kind`. It is **not** the identity: that is the actor id
(`--agent jobs|linus|…`). Every automated write carries the kind `system` under the one
automation identity `Board`; `system` itself is never an actor id (ADR 0018).
_中文_: actor kind（平台）
_Avoid_: host (that is the machine), platform (the web layer's display badge), kind alone
(card kind is a different word)

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

**Reopen**:
The one exit from a terminal status: `done`/`canceled → todo`, with an audited reason. It
starts a new delivery round. A review card cannot be reopened; reopen the card it reviews.
_中文_: 重开
_Avoid_: un-cancel, restore, retry

**Kind**:
What a card *is* — `task` or `epic` — as opposed to where it currently sits. Only an epic
may be a parent, and only an epic is withheld from automatic claiming. `deploy` was a kind
until 0039; whether a card belongs to a release line is the loop's decision, not a card kind.
_Avoid_: type, category

**Priority**:
How urgent a card is: `low`, `medium`, `high`, `urgent`. It is a claim of urgency, not a
measurement, and it never changes a card's status.
_Avoid_: severity, importance

**Comment**:
An append-only note on a card, written by an actor and typed by intent (`discuss`,
`decision`, `confirm`, `confirm_request`, `change`, `note`, `defect`). Comments are never
edited or deleted.
_中文_: 评论
_Avoid_: message, post, reply

**Decision**:
A comment of kind `decision`, `confirm` or `change` — the record of a human choice. Only
humans make decisions; not every comment is one.
_中文_: 决策
_Avoid_: approval, verdict

**Decision round**:
The way a question is asked: the frontier of decisions whose prerequisites are settled,
numbered Q1..Qn with a recommendation each, asked in one question string per card and
recomputed after the answers. It changes *how* a question is asked, never *who* decides.
_中文_: 决策轮次
_Avoid_: questionnaire, batch of questions

**Frontier**:
In a decision round, every decision whose prerequisites are settled — what can be asked now
without guessing an answer not yet heard. A decision that depends on an open one waits for
the next round.
_中文_: 前沿
_Avoid_: backlog, wish list

### Claim and execution

**Claim**:
Taking a card to work on it — normally the move from `todo` to `in_progress`, and also
re-taking a stale `in_progress` claim (where the status does not change). Claiming is
atomic: one claimer, or none.
_中文_: 认领
_Avoid_: assign, take, lock

**Stale recovery**:
Re-claiming an `in_progress` card whose heartbeat has expired — by its own holder after 30
minutes, and past six hours by the card's **assignee**; anyone else needs an audited
`--allow-steal --reason`. It is a claim, not a transition, so it goes through `issue claim`;
a takeover leaves an audit comment naming the previous holder.
_中文_: 过期恢复
_Avoid_: takeover, steal, rebirth

**Assignee**:
The actor a card is routed to — whose job it is. Assignment is responsibility, not
ownership, and an unassigned card is not unowned: it is in the open pool.
_Avoid_: owner, holder, claimer

**Claimer**:
The actor currently executing a card, as distinct from its assignee. A card can be assigned
to one actor and claimed by another; the claim is the execution lock, the assignment is the
route. Claiming an **unassigned** card also records the route — the claimant becomes its
assignee — so a claimed card is never left without one; a card already assigned keeps its
assignee.
_Avoid_: holder, owner (see *Assignee*)

**Heartbeat**:
The signal a claimer sends to say "still working". It refreshes a claim's freshness and
never changes a card's status. A fresh heartbeat is what separates a live claim from a
stale one.
_中文_: 心跳
_Avoid_: ping, keepalive, poll

**Session**:
The record of which conversation is doing the work on a card. It is the trail that answers
"which agent, in which run, touched this", and it is distinct from the actor. Its row pairs
`owner` with `owner_kind` — the owner's platform kind, the same `kind` an actor reference
carries elsewhere. The loop writes one stable row per card per segment; a rework round keeps
that identity (`meta.round` moves, the conversation continues), so the trail reads as one
conversation per card, not one per delivery round.
_中文_: 会话
_Avoid_: connection, run, thread

**Segment** (`seg`):
The discriminator that lets one card have several concurrent working conversations. A
session is identified by the card, the owner and the segment together. The loop's segments
are stable lane names — `worker` and `reviewer` — never a round number.
_Avoid_: part, shard, chunk

**Goal**:
The one sentence a session registers to say what it is working on. It lives on the
session row, so concurrent segments on one card each state their own; it is not a card
field and does not replace the round's report.
_中文_: 目标
_Avoid_: description, note, summary

**Session reset** (`meta.session_reset`):
A one-shot card marker that forces the next rework round into a fresh conversation while
keeping the same worktree and branch. The loop clears it to `no` once the handoff is queued;
a row that runs into an in-flight turn leaves it for the next round. It resets the
conversation, never the workspace.
_中文_: 会话重置
_Avoid_: workspace reset, clear history

**Candidate**:
A card the loop may claim, with the reason it qualified — `ready` (assigned and unblocked),
`unassigned` (open pool), `stale_same` (held too long by its own holder, who alone may
re-claim it) or `stale_any` (rotted past six hours: its assignee recovers it, anyone else
only with an audited `--allow-steal --reason`).
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

**Acceptance mode**:
The one word that decides who may move a card into `done`: `off` (no review; the deliverer may
close it, and `in_progress → done` is allowed), `auto` (an independent review card must APPROVE
first; the loop then closes it — anyone but the reviewer may also close, and a human always),
`human` (a person only, after the current-round review finishes). It never decides *whether* a
review happens: `auto` and `human` are both dispatched a reviewer, and only `off` is not.
Resolved once at creation and stored on the card; an unresolved card falls back to `auto`.
Any card, at any depth, may carry any of the three words. Authority decides *who*; the
acceptance baseline decides *whether* the evidence suffices.
_中文_: 验收模式
_Avoid_: acceptance policy, approver role, reviewer (the reviewer reports; it does not accept),
project acceptance (retired — the card states its own mode)

**Must-fix item**:
One numbered finding in a `VERDICT: REJECT` report. The loop appends each item to the
original's frozen acceptance baseline, so it is not advice: the next round's report must
answer it (`met` with an anchor, or a recorded deferral) and the next review card's baseline
carries it. A rejection with no numbered list still appends one pointer item — no rejection
is silent.
_中文_: 必改项
_Avoid_: finding (as a noun for an item the next round does not owe), leftover (that is work
outside the frozen acceptance)

**Auto-accept**:
The loop's `auto_accept` action for a delivered card whose `acceptance_mode` is `off`: it
writes `meta.accepted_by=loop-auto` and moves the card `in_review → done`. A `human` card is
never auto-accepted — it is reviewed, the verdict is recorded, and a person closes it after
the review finishes; an `off` card may also be delivered straight to `done`. It is distinct from closing a review
card.
_中文_: 自动验收

**Report**:
The record of what was delivered — a conclusion, the acceptance items and their verdicts,
and at least one piece of evidence. A report is evidence of work, not a promise of it.
_中文_: 报告
_Avoid_: summary, update, status

**Acceptance**:
A stated condition for a card being done, together with whether it was met, partially met,
not met, or not applicable. It is what a report is evidence against. When a card carries no
list, its worker may derive one at claim; `meta.acceptance_derived=yes` records that, and an
independent acceptor still has to audit its coverage.
_中文_: 验收
_Avoid_: criterion, requirement, DoD

**Acceptance baseline**:
The card's frozen acceptance list (`acceptance_json` + `acceptance_revision`), seeded once
from `meta.acceptance` / the imported checkboxes. It can be appended to and only a human may
prune an item (audited), so it cannot silently shrink under the work. `done` requires the
current round's report to cover it; a review `APPROVE` requires the review report to cover the
original's.
_中文_: 验收基线
_Avoid_: checklist, TODO list, meta.acceptance

**Evidence**:
A concrete pointer supporting a report — a commit, a path, a command or a coverage figure.
Evidence is what makes a report checkable rather than merely asserted. A `met` acceptance
item needs a command that fails when the item is broken; a path, a commit or a coverage
figure corroborates it.
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

**Epic graph**:
A project's optional `docs/agents/epic-graphs.md`: an epic-level acceptance mode and named
stages with their role, mode, dependencies and acceptance items for a multi-role epic. It is
guidance, not board data — `taskd` never reads it and nothing is stored or inherited; the
`meerkat` skill's epic recipe instantiates it.
_中文_: epic 图
_Avoid_: template, workflow, pipeline, DAG

**Graph stage**:
One stage row inside an epic graph. A card created from it carries `meta.epic_graph` and
`meta.epic_stage`; the stage's `depends_on` becomes reverse `blocks` edges, and its custom
columns are interpreted by the project's role skills.
_中文_: 图节点
_Avoid_: step, phase, task type

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
`in_progress` and left by resuming (a live worker), re-queueing to `todo` (the worker
stopped; any human comment gets a fresh one) or cancelling — it is not an eighth column.
_Avoid_: pending, on hold, blocked

**Question**:
The `question` comment a worker writes — on entering `awaiting` for an E1–E5, or while
staying `in_progress` for a question the director may answer (the question lane). It
is the payload `awaiting` promises; **any human comment** answers it and the board re-queues
the card. The board does not read the text — the resumed worker judges from its content
whether the answer is a complete decision, and asks again if it is not. A worker asking the
director **holds** the turn with `issue wait` rather than ending it.
_中文_: 提问
_Avoid_: awaiting reason (that is the category, not the question), issue

**Hold**:
A worker's bounded wait inside its own turn for the ladder's answer to its `question`:
`taskctl issue wait` returns `answered` (continue in the same turn, re-claiming the card if
the director released it), or `escalated`/`moved`/`timeout`/`error` (end the turn; the same
session is resumed by id when the answer lands). It is not a claim, a card state or a second
queue.
_中文_: 等待
_Avoid_: poll, sleep, idle, lock

**Question lane**:
The supervisor's path for an unanswered agent `question` on an `in_progress` card: poll
enqueues a question row and the **director** lane answers with a `note` **and releases the
card to `todo`** (or escalates E1–E5 to `awaiting`). The release, not the note, is what
settles the question; a note-only turn is retried. It is not a card state and it never
claims a card.
_中文_: 提问通道
_Avoid_: awaiting (that is the human-only overlay), question queue (the queue is generic)

**Awaiting reason**:
The category of the question being asked — a fixed enumeration, never free text. It says
what kind of answer unblocks the card, not what the answer is.
_Avoid_: question, topic

**Activity**:
An append-only audit row recording that something happened on a card. Activities are the
board's history and its change feed; they are the loosest, most deliberately untyped
surface in the model.
_中文_: 活动
_Avoid_: event, log (that is *Log*)

**Log**:
The process's own operational record — leveled lines written by `taskd`, `taskctl` and the
loop to stderr and, for the daemon and the loop, to a size-rotated file. A log is local and
diagnostic; it is not the board's history and never reaches a client.
_中文_: 日志
_Avoid_: activity, audit log (that is *Activity*)

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
The external **scheduler**. It owns two clocks — ping and continue — and performs no
board I/O of its own. It runs outside the agent application, but it is neither the board service
nor an agent itself. In its resident shape it also runs the **session pool**.
_中文_: 监督进程（调度器）
_Avoid_: daemon (that is the board service), cron; and do not call it the thing that polls

**Session pool**:
The supervisor's long-lived `--session` manager: one **worker session** per card, a
**reviewer session** per directory, and a **director lane** per project directory, opened on
demand. Each session is keyed by its actor kind as well as its card or directory, and a
session records the kind it runs on, so two platforms never share a conversation. It owns
the queues, the ledger, concurrency, idle eviction and resume. It is started by the session
unit and it is the only thing that can dispatch a worker.
_中文_: 常驻会话池
_Avoid_: worker pool, daemon, agent team

**Primary agent kind**:
The explicit `--supervisor=enable` actor kind when one is named, else the first
`claude|codex|pi` in normalized `--target` order (`--target all` → `claude`). It is the kind
`install.sh` gives the team skills — the director, the chat console, `setup-meerkat` and a
fresh install's role skills. An upgrade refreshes a role on the kind that already carries it
instead.
_中文_: 主 agent kind
_Avoid_: main platform, default agent, config key

**Intake request**:
A human's free-text description of work, submitted before any card exists (`0007`). It is
board state — `pending` until the decision lane files the cards (`consumed`, with their
identifiers) or records why it could not (`failed`) — and its activity row is the signal the
supervisor wakes on. A rejected description is resubmitted; there is no reopen. The request
is not a card: it has no assignee, status column or brief.
_中文_: 需求投递
_Avoid_: draft card, create form, inbox item

**Director lane**:
The pool's decision conversation for one project directory — the `meerkat-director` skill
answering question, route, triage, intake and escalation decisions. It is not a role, receives no
card, draws no worker budget, and runs on the kind that carries the director skill (the
primary kind first, then the configured kind order), discovered at session open. Its write
tools are denied: it reads and drives the board, and a fix becomes a card, never an edit.
_中文_: 决策通道
_Avoid_: project session, control lane

**Chat console**:
The human's live view of the board — the `meerkat-chat` skill. It reports progress, surfaces
awaiting questions and pending acceptance, records the human's own answer with `--as-human`,
and reads `taskctl doctor`; it never makes a decision, claims a card or delivers one.
_中文_: 对话台
_Avoid_: director mode, manual mode

**Role skill**:
A standalone skill that is a complete role (`SKILL.md`, `role.json`, `references/`). The
standard team is `jobs`, `linus`, `turing`, `reviewer` and `worker`, but discovery does not
name them: any directory carrying `role.json` with the `meerkat-role` marker is a role.
**Installation location is the routing**: a role present under a kind's `skills/` runs on
that kind. There is no roles root and no team manifest.
_中文_: 角色技能
_Avoid_: team manifest, role prompt, subagent definition

**Role catalog**:
The **local** projection of the discovered roles at `<config root>/roles.json`, written by
`taskctl role sync` and read by `taskctl role list`. It is the assignee range humans and the
`meerkat` skill use; it is never board state and never the routing source (the supervisor
routes by the set it discovered). `MEERKAT_TASKPANEL_CONFIG_DIR` relocates it.
_中文_: 角色目录
_Avoid_: team manifest, role registry (that word also names board identities)

**Kind order**:
The install-time preference when several agent kinds carry the same role:
`MEERKAT_TASKPANEL_AGENT_KIND_ORDER`, written from the normalized `--target` order with the
primary kind first. A kind the order omits is appended at discovery, never excluded.
_中文_: kind 顺序
_Avoid_: platform preference, fallback list

**Writer identity**:
The board identity the loop itself writes as — `--agent` on a scheduling unit, else
`TASKCTL_AGENT`, else the OS user. It is not the claim set: the loop claims for the discovered
worker-lane roles plus every reviewer-lane role.
_中文_: 写入身份
_Avoid_: scan set, assignee (that is the card's routed role)

**Worker session**:
The card's own top-level conversation inside the pool, keyed `worker:<card>:r<round>` and
launched in the card's workspace (its admitted worktree for a git project) on the kind that
carries the card's role. It works exactly one card; a new round gets the full handoff, and a
same-round re-dispatch is resumed by its stored session id — never across a kind.
_中文_: 工作会话
_Avoid_: subagent, worker process

**Replay**:
Opening a fresh session for a card whose native session can no longer be resumed (expired,
deleted, or the resume rejected) and giving it a bounded loop-owned transcript of that
card's last turns, so the work continues instead of restarting. The record is marked
`resumed_by_replay`; a replay that also fails marks the card blocked and raises it to the
operator.
_中文_: 回放
_Avoid_: restore, rehydrate, resync

**Reviewer session**:
The resident conversation for review cards in a project's directory, opened with the
`reviewer` role when a review card is queued. It runs the review itself; when its session
shares the delivery's context it hands the review to one fresh-context reviewer
**subagent** (ADR 0019). Where the adapter can enforce it, the reviewer's write tools are
denied (ADR 0020).
_中文_: 审核会话
_Avoid_: review worker, worker session

**Subagent**:
A fresh-context child spawned through the agent kind's own subagent mechanism (`Agent` on
Claude). Any lane may spawn one; the reviewer's is the independence child, one-shot, never
resumed, read-only, and it returns the verdict, the security table and the evidence while
the parent keeps the board writes (ADR 0019). The supervisor tracks no children. A subagent
takes no per-call cwd, so it does not inherit the card's worktree. Workers are not
subagents: each has its own **worker session**.
_中文_: 子代理
_Avoid_: worker process, child session (that is an agent-kind API term), thread

**Event hub**:
The local process that owns a host's one SSE connection to a board and fans its events out
to the loop's subscriber and to watch registrations. It is per user and per board, binds
loopback, and is started on demand by `taskctl events follow` or `export watch --detach`.
It is a client-side fan-out, not a server-side bus.
_中文_: 事件中枢
_Avoid_: event bus, broker, message queue, listener (a registration is the listener; the hub owns the connection)

**Resident**:
The loop's default shape: a live session pool that can claim and dispatch. Without it —
cron, a stopped session unit, `--resident=no` — poll claims nothing and only patrol and
workflow run. "Resident" describes the pool, not the board service.
_中文_: 常驻
_Avoid_: always-on, online, running

**Ping**:
The high-frequency liveness clock. It prunes worker-registry entries whose pid is gone:
no board read, no claim, no LLM turn.
_中文_: 存活检查
_Avoid_: poll (it finds no work), heartbeat (that is the card's, not the process's)

**Continue**:
The low-frequency tick clock. Each firing runs the deterministic passes — patrol →
workflow → poll — in the supervisor process under one single-flight lock. It spends no LLM
turn; the director lane is opened only when a row needs a decision.
_中文_: 继续节拍
_Avoid_: patrol (patrol is one of the passes the tick runs), wake (a wake is for a card)

**Poll**:
The deterministic entry that scans for new claimable work, claims atomically and writes
the handoff to the card queue. It does **not** spawn a worker: the pool opens or resumes
the card's worker session. It is **not scheduled**; the continue turn runs it, and a human can run it too.
Without a resident pool it claims nothing.
_中文_: 轮询
_Avoid_: tick, scan, sweep; do not call the scheduler's ping clock a poll

**Patrol**:
The deterministic entry for work already *stuck* — stale claims, overdue waits, a silent
inspector. It raises alerts and moves no card. It is not scheduled; the continue turn runs
it. The writing channel is a separate entry, **workflow**.
_中文_: 巡检
_Avoid_: audit, sweep, health check; do not call the whole loop "the patrol"

**Workflow**:
The board's workflow decisions (`issue reconcile --workflow`: reconcile containers, review
outcomes, auto-accept and review dispatch) and the loop's execution of that plan. The board
decides; the loop creates the review card, applies the verdict, auto-accepts a no-review
delivery and closes the review card — as the board's own kind, `system`, under the automation
id `Board`. It is not scheduled; the continue turn runs
it after patrol.
_中文_: 工作流通道
_Avoid_: workflow engine, pipeline; SLA alerts are not part of it

**Review card**:
A `kind='review'` card that audits another card: it records `review_of` (the original's
identifier), `flow=B` and the delivery round it audits, and carries the reviewer's verdict
report. Creation also stamps the immutable structural marker (`review_of_id`,
`review_round`), which is what the acceptance gate reads; the database CHECK
`(kind='review') = (review_of_id IS NOT NULL)` ties the type and the marker together, so
neither can disagree; `meta.review_of` / `meta.review_round` are its readable mirror and are
canonicalized from the columns on update. It reaches `done` through `in_review` like every
other card. Its `acceptance_mode` is always `off` (flow B is never reviewed again), enforced
by the resolver and a database trigger.
_中文_: 审核卡
_Avoid_: approval card, acceptance card

**Reviewer**:
The independent agent a review card is assigned to — the local role catalog's
`default_reviewer`, else the first reviewer-lane role. It reads the original's evidence and
reports a verdict; it moves no card. The loop is the acceptor.
_中文_: 审核员
_Avoid_: approver, acceptor, QA

**Epic triage**:
The worker's Step 0 decision — before starting, does this card contain several independent
deliverables (each landable alone), and should it therefore become an `epic` split into
children? It happens in the worker's own first turn, not in a separate planner.
_中文_: 升格判断
_Avoid_: planning, decomposition, estimation

**Deliverable**:
A change a child card can land on the base branch alone, leaving the tree coherent — every
surface it touches updated, the suite green, and no follow-up cleanup card owed. The layers
a change crosses (core, CLI, web, docs, fixtures) are its scope, not separate deliverables.
_中文_: 可交付项
_Avoid_: layer, slice, sub-task

**Wake**:
Starting one worker, once, with a bounded prompt. A wake is dispatched only for work the
loop actually claimed, and it is idempotent. In the resident shape the wake opens or
resumes the card's **worker session**; the legacy one-shot shape starts an agent process
through the glue.
_中文_: 唤醒
_Avoid_: spawn, launch, trigger

**Handoff**:
The fresh, bounded briefing a new dispatch gives a worker — the card, the exact commands
to run, the identity to record, and the statement that the claim is already held. It is
built again for each **round**; a same-round re-dispatch resumes the worker with a short
resume prompt (or a **Replay**) instead of rebuilding it. It names the task's **process
directory** (`.meerkat/<identifier>/`), relative to the worker session's cwd, and points at
the exported `card.md` inside it.
_中文_: 交接
_Avoid_: prompt, context, briefing

**Handoff block**:
A `## Handoff` section in a producer card's delivery report `conclusion` — the archived
spec/PRD/prototype paths, the acceptance source, the delivery shape and the proposed next
cards. A split prototype card uses the same block for its verdict instead: the product card or
brief, the questions, the verdict, the prototype path, the evidence, the rejected variants,
the commit, the limitations and the open questions; a field that does not apply is
`none — <reason>`. Only a producer card (Jobs design, Linus architecture) writes it; the
director copies it into the downstream card. Distinct from the wake **Handoff** above
and from the role's **Self-check**.
_中文_: 交接块
_Avoid_: handoff, card handoff (both ambiguous here)

**Card brief**:
The loop's export of one card at `.meerkat/<identifier>/card.md`, under the project's
working directory. It is the authoritative snapshot a worker or reviewer is handed; it is
generated only by `taskctl export md` (atomic temp + rename), and an agent never edits it.
The same directory holds the task's other process data — notes, logs, evidence, report
drafts and downloaded attachments.
_中文_: 卡片 brief / 任务过程目录
_Avoid_: workspace, scratch dir, card copy

**Card queue**:
The durable file the poll entry writes a claimed handoff into (`cards.queue.json`), and
the director reads from. Distinct cards are never merged; a handoff is removed only
after its subagent is recorded in the ledger.
_中文_: 交接队列
_Avoid_: job queue, work queue

**Self-check**:
A role's pre-delivery audit. For a worker: re-read the card and frozen acceptance, map every
requirement and acceptance item to evidence, settle each row's disposition — met needs
falsifiable evidence, not_applicable its reason, and partial or not_met is a blocker —
re-run the claimed gates, and confirm the report is complete. Work outside the frozen
acceptance is recorded as a leftover naming its owner. For the reviewer: confirm the verdict
rests on observations — the requirement ledger is complete, every `met` cites an anchor, the
delivered sha is recorded, and the earlier findings are answered. It is internal to the
delivering card (or the review card); it is not the **Handoff block**, which is the
cross-card transfer.
_中文_: 交付前自检
_Avoid_: handoff check, review (the reviewer owns the independent verdict)

**Deliver**:
The terminal worker action: `taskctl issue deliver` a report and stop at `in_review`. The
workflow's last stage is named Deliver; it runs the **Self-check** first and, on a producer
card, writes the **Handoff block**.
_中文_: 交付
_Avoid_: done, approve, close (the reviewer and the loop own those)

**Ledger**:
The supervisor's own record of live subagents (`subagents.state.json`): project directory,
actor kind, subagent id, role, card and status. It is written from agent events, never parsed
from a transcript, and it is what frees a concurrency slot and drives reattach.
_中文_: 子代理台账
_Avoid_: registry (that is the legacy one-shot process registry), log

**Tier**:
A card's hard ordering band within the assignee weight order — movable, stalled, or with
others. Tiers come before any score: a card never outranks one in a better tier.
_Avoid_: bucket, group, level

**Weight order**:
The ordering of a card list by urgency rather than by board position — the only one a
list read returns. It is computed by the server, consumed as-is by the client, and
exposed for inspection on request.
_Avoid_: sort order (a different, stored value), ranking

**SLA row**:
One named rule the patrol checks — a stale heartbeat, an unanswered question
(`question_stale`), a stalled leader, an overdue confirmation — each with its own threshold
and its own repair. The board computes the row; the patrol delivers it.
_Avoid_: rule, check, metric

**Alert tuple**:
The identity of one alert: the card, the SLA row and the severity, plus the moment it began
to be measured. Re-raising the same situation re-uses the same identity, so a repeated
problem does not become a second alert.
_Avoid_: notification, event, message

## Process and repository

Terms about *this repository's* way of working. They are not board concepts, but they are
load-bearing in the same conversations and are easy to mistake for board vocabulary.

**Per-kind config**:
`<program root>/.env.<actor-kind>` (for example `.env.claude`) — the file `taskctl` reads as
a per-agent default layer and `taskctl run` reads for loop policy. It lives beside the
board `.env`, not under the agent directory, and is selected by `--actor-kind`.
_Avoid_: loop config, agent config

**Container gate**:
The authoritative verification run — the whole test suite executed inside a built image. It
runs from `.githooks/pre-push` on a branch push (and in CI), and bakes the tree it finds when
the build starts, so the commit must land before the push.
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

**Session worktree**:
A human session's own tree under `.worktrees/<slug>` on a `<type>/<slug>` branch, created and
swept by `taskctl worktree`. It is not the loop's **workspace** and is never registered in
`workspaces.json`; `lane/` is the loop's namespace and is never touched by it.
_Avoid_: workspace, lane, scratch dir

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
There is no agent type. An agent is an actor id — the role or person recorded on writes
(`--agent jobs`, `TASKCTL_AGENT`), which the shim names on every call. The word names a
role, not a structure.
_Avoid_: `Agent`, `AgentService`, agent object; and do not use it for the application
(that is the actor kind)

**Report digest**:
Does not exist. Reports are stored whole. The word "digest" in this codebase means a hash,
and separately names the loop's batched notification mode — neither is a property of a
report.
_Avoid_: digest, report summary, report hash

**Rollup**:
An epic's delivery report: the one report whose acceptance items name each child (`ref`) and
say whether that child's terminal state is acceptable. It is a behaviour *and* a marker —
`task_reports.is_rollup` (`report.is_rollup` on the wire, 0033) — and it is the epic's
acceptance evidence: `done` and an `APPROVE` refuse a missing (`ROLLUP_REQUIRED`) or stale
(`ROLLUP_STALE`) one. Its evidence is one representative anchor per `done` child, cited by that
child's item (ADR 0024); a child with no report says so explicitly. A stale rollup is repaired
by reworking the epic to a new round.
_中文_: 汇总报告（rollup）
_Avoid_: summary, aggregate, container report

**State**:
Not a synonym for status. A card's status is where it sits in its lifecycle; its execution
state is the coherence of its claim — whether it is claimed, by whom, and whether it is
still fresh.
_Avoid_: using state and status interchangeably

**Migration**:
A numbered, append-only change to the database schema (`src/core/storage/migrations/*.sql`).
It is not a word for moving cards in or out of the board: cards are created through the
board, and `taskctl export md` writes them out.
_中文_: 迁移（仅指数据库结构；不指卡片搬迁）
