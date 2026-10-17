# Practice guides — Claude Code, Codex & OpenClaw

> **What this covers.** How to *operate* this skill well once it is installed into
> a host — **Claude Code**, **Codex**, or **OpenClaw** — the habits that keep a
> fleet of agents from tripping over each other on one shared board. The commands
> themselves are in [`cli.md`](cli.md); the periodic reports are in
> [`reports.md`](reports.md). This file is the *practice*: eight rules every host
> shares, each host's install / trigger differences, and a minimal worked example.

The rules are host-independent on purpose. A board driven from Claude Code, from
Codex, or from any other host earns the same guarantees, because the guarantees
live in the **board** — the host only decides *how* an agent is told to claim.
OpenClaw users get these rules *automatically*, because the
[openclaw-team](https://github.com/tanyu216/openclaw-team) framework ships the
dispatcher that applies them; on Claude Code and Codex the same rules are the
agent's own responsibility, which is what this document is for.

## The shared kernel — eight rules

Every agent on the board follows the same eight rules. The first three decide
**what** it works on; the rest decide **how** it finishes and how the board stays
honest.

### 1. Claim first (claim-first)

Never edit before the board says the card is yours. The order is read, then claim:

```bash
node scripts/run.mjs issue candidates --assignee <me>   # what may I claim?
node scripts/run.mjs issue move <ref> in_progress       # take exactly one
```

`issue candidates` is **read-only** (`cli.md` §`issue`): it lists the cards this
assignee *may* claim — `todo`, not an `epic`, not a `deploy`, every `depends_on`
already `done`.
Picking one and moving it to `in_progress` is the claim; from that moment the
card is yours and the board shows it as live.

**Claim only what is assigned to you.** The board's claim criterion is
`assignee == the claiming actor`: a card assigned to somebody else is refused at
the claim, not silently reassigned. `issue candidates --assignee <me>` is built on
that criterion, so the read is not optional politeness — it is the step that tells
you which cards will accept you.

### 2. Only claim what you should

A card is claimable only when **all** of these hold. Each failing case is a "do
not touch it", not a "try anyway":

| Situation | Why it is not yours |
|---|---|
| Assigned to somebody else | The board refuses a claim by a different actor (§1). |
| Sitting in `backlog` | Unauthorised — `backlog` has not been released for work; only the dispatcher (or a human) moves it to `todo`. |
| An `epic` | An epic is a container, not a unit of work; its leaf children are what gets claimed. `issue candidates` excludes epics. |
| A **deployment card** (`kind: deploy`) | Deployment work runs against a live instance, so it is dispatched explicitly by a human or the leader; the candidates read never offers one. |
| A `depends_on` blocker is not `done` | The work it waits on is unfinished; the candidates read already withholds it. |

`issue candidates --assignee <me>` enforces the last three for you. When a card
you *expected* is missing, `relation list <ref>` shows the blockers behind it —
and `issue get <ref>` shows whether it is a deployment card, which is the other
reason it will not appear. A `deploy` card is still claimable when it is
dispatched to you: wait for the dispatch rather than looking for it yourself.

**When the card turns out to be a container, promote it — do not claim it.** A card a human
filed is a `task`; if it holds several deliverables, `issue update <ref> --kind epic` makes it
the container (only an `epic` may be a parent), then one `issue create` per deliverable — each
with its own `--target`, or the create guard reads the second as a retry of the first — and a
`relation add <ref> --type parent --target <child>` per edge. An epic can never be claimed, but
**the board drives it**: the first child entering `in_progress` moves the container
`todo → in_progress` (a system move, with a `kind=note` comment), and when the last child is
accepted to `done` the rollup report is written and the container delivered to `in_review` for
you. `todo → in_review` is still the epic's own edge (a task's `todo` row does not have it) —
it is the repair path for a child attached after the fact, which `issue reconcile` replays. The
full order, and the three commands that surprise people, are in
[`SKILL.md`](../SKILL.md#when-the-card-is-a-container-promote-it-to-an-epic).

### 3. One card at a time

Hold **at most one** claimed card. A second concurrent claim is how two agents
end up half-editing the same files, and how a board acquires `in_progress` cards
nobody is actually working. Finish (or explicitly hand back) the current card
before you claim another.

A **container** you promoted is not a second card: an epic carries no work of its
own, so parking it (§2) leaves your budget untouched — its children are the cards
you claim, one at a time.

### 4. Keep the heartbeat fresh (≤ 10 minutes)

The board stamps a claim with a **heartbeat** and treats the claim as *fresh* for
**10 minutes**. A claim whose heartbeat goes cold is **stale** — recoverable by
its own holder after 30 minutes and by anyone after 6 hours — so a crashed agent
never wedges a card. The practical obligation while you work is: keep the claim
live, and never leave a card `in_progress` while you go idle.

**The pulse is a command you run — the board never sends one for you:**

```bash
node scripts/run.mjs issue heartbeat <ref> --agent <me> --actor-kind <host>
```

Run it at least every 10 minutes while a card is `in_progress`. It resets the
heartbeat and **nothing else** — the status, the claimer and the delivery round
are untouched — and only the holder may send it. Nothing else knows the work is
still going; a claim you stop pulsing is meant to read as abandoned, so a card
parked in `in_progress` over a long task alerts until you pulse it or take it out
of the cycle. `issue candidates --stale` is how a later reader surfaces a claim
whose heartbeat expired (`cli.md` §`issue`).

### 5. Deliver with a report (the delivery gate)

A card cannot enter `in_review` without a **report for the current delivery
round**; the refusal prints the exact command that fixes it. Use the short path —
`report template` then `deliver` — which writes the report and performs the move
in one transaction:

```bash
node scripts/run.mjs report template <ref>            # fill the TODO lines
node scripts/run.mjs issue deliver <ref> --report-file -
```

Leaving `in_review` (except to `done`) starts the next round, so last round's
report is history, not evidence. The audited waiver (`--no-report --reason`) is an
escape hatch for the rare case, not the normal path — see `cli.md` §The delivery
gate.

### 6. Self-review is not acceptance

An agent takes a card **at most to `in_review`**. Only a human (or a designated
acceptance role) moves it to `done`. Reporting your own work as delivered is not
the same as the work being accepted, and the board keeps the two apart on
purpose: `in_review` is "evidence attached, awaiting a verdict", `done` is "a
verdict was given".

### 7. Never preempt on conflict or staleness

If a write comes back `VERSION_CONFLICT` (the card moved under you) or the claim
you were about to take looks stale, **do not force it**. Re-read the card once,
decide from the fresh state whether it is still claimable, and only then retry —
with the current `--if-version`. A stale read that you retry blindly is how two
agents overwrite each other.

### 8. Stay traceable — carry the session id

Every write can name the actor and the conversation behind it
(`--actor-kind <host> --session-id <id>`). That is what turns a card back into
"which agent session did this", and it is what lets a resumed conversation
re-attach to the same work instead of starting over. Always pass the session id.

> **Stuck on a question for a human?** That is an `awaiting` move with an
> `E1..E5` reason — `issue move <ref> awaiting --awaiting-reason E3` — not a
> `blocked` and not a chat message. The card stays *running* while the person
> answers, and the answer resumes the same attempt without starting a new
> delivery round. The eight rules above still hold; see `cli.md` §The `awaiting`
> state.

## Where a directory's project lives (目录归属)

**The board holds no directories.** A board project carries no target directory: no
`workspace_path`, no `context current`, no registry `root` anchor. TaskPanel does no
project-directory management, on purpose — so the answer to "which board project is
this directory?" comes **only** from the `projects.json` kept **beside this skill**
(next to `SKILL.md`):

```json
{
  "projects": [
    { "local_path": "/Users/you/code/meerkat-taskpanel", "project": "TaskPanel" }
  ]
}
```

A directory resolves to the entry whose `local_path` is that directory or an ancestor
of it; the **longest** match wins. `local_path` is a local absolute path; `project` is
the board project's **id** (preferred) or name. The file is **local and agent-side —
it is never written into the board**, and it is not part of the skill's source. The
full schema is in [`projects-json.md`](projects-json.md).

That directory is where a **worker starts** — not where the project's results live.
Where a project keeps what it produces (a repository, a vault, nowhere at all) is its
own business; see the boundaries below.

**No directory is an answer — and the map says so.** A project whose work needs no
checkout is registered with an entry that names no directory
(`{ "project": "Community" }`), and `taskctl project dir <project>` reports that and
succeeds. Do not invent a directory for it; if a worker must start somewhere, give the
entry a `run_dir` — the launch directory, consulted only when `local_path` is absent
(`dir = local_path ?? run_dir`).

**There is no fallback — ask.** A project **absent** from `projects.json` has no
registered directory — the board cannot supply one. Do not invent, guess, or derive a
directory, and do not go looking for one on the board. When a step needs the directory,
stop and **ask the user**, rather than continuing without an answer:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will add it to projects.json beside this skill
(references/projects-json.md) — the board cannot supply one.
```

A directory that *is* named is checked (absolute, exists, is a directory): an entry
that points nowhere — a moved checkout, a typo, a file — is as unusable as no entry,
and gets the same question with what is wrong named. `taskctl project dir <project>` is
the command form: it prints the directory, prints that the entry names none, or exits
non-zero asking rather than proceeding. A directory that maps to nothing gets the same
prompt. Work that needs no directory — claiming, moving, commenting, delivering (§1–§6)
— is unaffected; a missing mapping is "no directory known", never "cannot work".

Three boundaries this respects, on purpose:

1. **TaskPanel does no project-directory management** — not a column, not a route, not
   a command. A board project simply has no directory; directories are a local concern.
2. **TaskPanel does not manage project data** — where a task's results live, and
   whether they are kept at all, is the business's decision. The board keeps task data
   complete, reliable, traceable and auditable, and nothing else.
3. **Whether you manage a project's source data with `meta` is your own call.**
   TaskPanel does not prescribe it and does not advise it — and **this skill takes no
   position either**. Use `meta`, or don't, by your own convention. The metadata keys
   an entry in `projects.json` carries beyond `project`/`local_path`/`run_dir` are the
   same kind of call: yours, read by the agent from the file.

## Waking & patrol (唤醒与巡检)

Rule 1 says *claim first*; it does not say *wait to be told*. Work starts when a
small **host-external supervisor** finds claimable cards and wakes a worker for
one. Nothing inside an agent does the polling.

That supervisor is **not part of this skill**. It ships as its own skill,
[`meerkat-loop`](https://github.com/tanyu216/meerkat-taskpanel/blob/main/skills/meerkat-loop/SKILL.md)
— its execution body is installed under `<host>/meerkat-taskpanel/`, and its
`references/operation.md` is the operator's view of install, paths, flags and the
headless permission boundary. The host-agnostic design is at
[scheduling.md](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/scheduling.md).

Two layers, kept apart:

| Layer | Cadence | Job | Cost |
|---|---|---|---|
| **poll** | 1 minute | `issue candidates` → claim → wake a worker | the scan is a $0 local CLI; a model turn starts **only** when a card was actually claimed |
| **patrol** | 5 minutes | `issue list --status in_progress` → escalate a stale claim; report an unreadable heartbeat | $0 (no LLM by default) |

Three things that keep it honest:

- **The atomic claim is the only dispatch.** `issue move <ref> in_progress` is
  compare-and-swap: whoever wins the claim is who works the card, and the loser
  starts **no** worker. A wake is therefore idempotent and bounded by a
  concurrency cap (`--max-concurrency`, default 8).
- **A fresh heartbeat means do nothing.** An empty poll tick starts no worker at
  all; a live claim is invisible to the next scan.
- **A broken heartbeat is never silent.** If patrol cannot read a heartbeat, it
  *reports* that instead of going quiet — the state that used to vanish.
- **A woken worker runs in the directory the map names — or is not woken at all.** The
  wake goes through the host's own glue, which resolves the card's project against
  this skill's `projects.json` (its `local_path`, else its `run_dir` launch directory)
  and `cd`s there; a project with no usable directory — an unregistered one, or an
  entry that names none — refuses the wake instead of running somewhere unintended
  ([§Where a directory's project lives](#where-a-directorys-project-lives-目录归属)).

Installers drop per-host scheduling units (launchd / systemd / cron) and a wake
script, and print the load command — they never enable a daemon for you. The
installer also asks once whether the supervisor may claim **unassigned** cards
(default yes) and remembers the answer in `<host>/meerkat-taskpanel.env`.

They install the loop for **claude, codex and pi only**. OpenClaw is excluded on
purpose — the openclaw-team framework already runs an equivalent poll / patrol, and a
second supervisor would only race the first.

A wake runs the worker **headlessly**, so it runs under a pre-declared tool
allowlist / permission mode / sandbox and must **not** default to bypassing
permissions (`--dangerously-skip-permissions` or equivalent); a bypass needs
explicit written authorization, documented at the point of use — see
[scheduling.md §Headless permission boundary](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/scheduling.md#headless-permission-boundary).

## OpenClaw

### Install

```bash
# 1. skill → ~/.openclaw/skills/meerkat-taskpanel
bash install.sh --target openclaw --link --force

# 2. plugin — OpenClaw consumes the Claude-format bundle at the repository root
openclaw plugins install "$PWD" --force --accept-capabilities
openclaw plugins inspect meerkat-taskpanel                 # → meerkat-taskpanel, bundle format: cursor
```

(The board ships no native `openclaw.plugin.json`: a skill-only pack installs through the
bundle route above. The repo's `docs/install.md` §OpenClaw has the reasoning.)

### Tracing and triggering

- **The rules are applied for you.** OpenClaw is the one host where claiming is not
  the agent's job: the [openclaw-team](https://github.com/tanyu216/openclaw-team)
  framework installs Meerkat TaskPanel by default and runs a per-agent poll that claims
  `todo` / `stale` cards through the board's own criteria. §1–§3 and §7 happen
  around the agent rather than by it.
- **The session id still travels with every write.** Pass
  `--actor-kind openclaw --session-id <id>` so a card's trail points back at the
  session that did the work (§8); the framework keeps that id stable across resumes.
- **No supervisor to build.** OpenClaw is the one host that installs **no**
  scheduler of its own: `install.sh --target openclaw` writes this skill only — not
  the `meerkat-loop` skill, not a scheduling unit — and the
  [openclaw-team](https://github.com/tanyu216/openclaw-team) framework's `poll` /
  `patrol` automations *are* the [Waking & patrol](#waking--patrol-唤醒与巡检)
  design. Install that framework instead of wiring anything by hand.

## Claude Code

### Install

```bash
bash install.sh --target claude --link --force     # skill → ~/.claude/skills/meerkat-taskpanel

# or, as a plugin from the marketplace:
claude plugin marketplace add "$PWD"
claude plugin install meerkat-taskpanel@meerkat-taskpanel-marketplace -y
claude plugin list                                 # → meerkat-taskpanel, enabled
```

### Tracing and triggering

- **Session scoping is per-directory.** Claude Code loads the skill from the
  project you are in; to learn which board project a directory belongs to, look it up
  in the `projects.json` beside this skill
  ([§Where a directory's project lives](#where-a-directorys-project-lives)). The board
  holds no directory, so there is nothing to ask it.
- **Stamp every write with the host and session:** `--actor-kind claude
  --session-id <id>`. Use the id of the Claude Code session, so the card's trail
  points back at the conversation that did the work.
- **Bind the card to the branch / worktree** you are working in: record it once
  when you claim (`session set <ref> --seg <seg> --backend claude`), so a card
  names the checkout it belongs to.
- **No timers of its own — the loop lives outside.** Claude Code hooks fire only
  on session events, so the claim in §1 is driven by the supervisor
  ([Waking & patrol](#waking--patrol-唤醒与巡检)): a launchd / systemd / cron unit
  runs the **host-installed** copy of the loop's `scripts/supervisor.mjs`, which wakes a
  headless `claude -p` session (`--resume <sid>` to continue one). `install.sh` installs
  the `meerkat-loop` skill, drops the units and the `wake-claude.sh` glue, and prints the
  load command.

## Codex

### Install

```bash
bash install.sh --target codex --link --force      # skill → ~/.codex/skills/meerkat-taskpanel

# or, as a plugin from the marketplace:
codex plugin marketplace add "$PWD"
codex plugin add meerkat-taskpanel@meerkat-taskpanel-marketplace
codex plugin list                                  # → meerkat-taskpanel
```

(The `pi` / Agent Skills target installs the same skill to `~/.agents/skills/meerkat-taskpanel`.)

### Tracing and triggering

- **Session ownership comes from the thread.** Codex exposes the running thread as
  **`CODEX_THREAD_ID`**; read it and use it as the session id, so a card's trail
  is attributable at the conversation level:
  `--actor-kind codex --session-id "$CODEX_THREAD_ID"`.
- **Same claim-first order**, same board checks (§1). Resolve a directory's project
  from the `projects.json` beside this skill before creating or claiming anything
  ([§Where a directory's project lives](#where-a-directorys-project-lives)).
- **No timers of its own either.** Codex does not poll the board, so §1 is driven
  by the supervisor ([Waking & patrol](#waking--patrol-唤醒与巡检)) waking a
  `codex exec` turn — resumed with `codex exec resume <sid>` when the thread id
  is known — or by a Codex app automation
  (`intervalMinutes` / `quotaAware` / `model` / `reasoningEffort`). The bundled
  `~/.codex/meerkat-taskpanel-claim.sh` trigger remains the minimal fallback.

## A minimal worked example

From the skill directory, the shortest complete loop (Claude Code shown; on Codex
swap the actor flags for `--actor-kind codex --session-id "$CODEX_THREAD_ID"`).

**Prerequisites for the placeholder names below.** `PROJ-0007` stands for a real
card on *your* board and `linus` for the assignee it belongs to — substitute the
identifier `issue candidates` prints for you. `$SESSION` is the host's session id
(see your host's *Tracing and triggering* section): the Claude Code session id you
launched with, or `$CODEX_THREAD_ID` on Codex.

```bash
# 0. which project owns this directory? — look it up in the projects.json beside
#    this skill (references/projects-json.md); the board holds no directory

# 1. claim-first: read the claimable set, then take exactly one
node scripts/run.mjs issue candidates --assignee linus --actor-kind claude --session-id "$SESSION"
node scripts/run.mjs issue move PROJ-0007 in_progress --actor-kind claude --session-id "$SESSION"

# 2. register the session (which conversation is on this card) — the resume key
node scripts/run.mjs session set PROJ-0007 --seg seg1 --backend claude \
  --actor-kind claude --session-id "$SESSION"

# 3. …do the work; leave a decision trail while you go…
node scripts/run.mjs comment add PROJ-0007 --kind decision --body "Chose the SQLite trigger path."

# 4. deliver with a report — the gate refuses an empty round
node scripts/run.mjs report template PROJ-0007
node scripts/run.mjs issue deliver PROJ-0007 --report-file - \
  --actor-kind claude --session-id "$SESSION"
# → status in_review; a human accepts to done (self-review ≠ acceptance, §6)
```

## See also

- [`cli.md`](cli.md) — the command surface, the delivery gate, the `--json` contract.
- [`reports.md`](reports.md) — daily / weekly / monthly reports and statistics.
- [`projects-json.md`](projects-json.md) — the local directory ↔ board project map.
- [`SKILL.md`](../SKILL.md) — the agent-facing entry point; §Claiming work restates
  rules 1–2 as a checklist.
- [openclaw-team](https://github.com/tanyu216/openclaw-team) — the dispatcher that
  applies these same rules automatically on an OpenClaw host.
