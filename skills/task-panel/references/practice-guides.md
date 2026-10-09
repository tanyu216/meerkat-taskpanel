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
assignee *may* claim — `todo`, not an `epic`, every `depends_on` already `done`.
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
| A `depends_on` blocker is not `done` | The work it waits on is unfinished; the candidates read already withholds it. |

`issue candidates --assignee <me>` enforces the last two for you. When a card you
*expected* is missing, `relation list <ref>` shows the blockers behind it.

### 3. One card at a time

Hold **at most one** claimed card. A second concurrent claim is how two agents
end up half-editing the same files, and how a board acquires `in_progress` cards
nobody is actually working. Finish (or explicitly hand back) the current card
before you claim another.

### 4. Keep the heartbeat fresh (≤ 10 minutes)

The board stamps a claim with a **heartbeat** and treats the claim as *fresh* for
**10 minutes**. A claim whose heartbeat goes cold is **stale** — recoverable by
its own holder after 30 minutes and by anyone after 6 hours — so a crashed agent
never wedges a card. The practical obligation while you work is: keep the claim
live, and never leave a card `in_progress` while you go idle. `issue candidates
--stale` is how a later reader surfaces a claim whose heartbeat expired
(`cli.md` §`issue`).

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
gate. The MCP surface is stricter still: `task_deliver` is the only tool that
reaches `in_review`.

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
(`--agent-platform <host> --session-id <id>`). That is what turns a card back into
"which agent session did this", and it is what lets a resumed conversation
re-attach to the same work instead of starting over. Always pass the session id.

## Waking & patrol (唤醒与巡检)

Rule 1 says *claim first*; it does not say *wait to be told*. Work starts when a
small **host-external supervisor** ([`scripts/supervisor.mjs`](../../../scripts/supervisor.mjs))
finds claimable cards and wakes a worker for one. Nothing inside an agent does
the polling — see the full design in
[`docs/scheduling.md`](../../../docs/scheduling.md).

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

Installers drop per-host scheduling units (launchd / systemd / cron) and a wake
script, and print the load command — they never enable a daemon for you. The
installer also asks once whether the supervisor may claim **unassigned** cards
(default yes) and remembers the answer in `<host>/task-panel.env`.

## OpenClaw

### Install

```bash
# 1. skill → ~/.openclaw/skills/task-panel
bash install.sh --target openclaw --link --force

# 2. plugin — OpenClaw consumes the Claude-format bundle
openclaw plugins install "$PWD/plugins/claude" --force --accept-capabilities
openclaw plugins inspect task-panel                 # → task-panel, bundle format: claude
```

(`plugins/openclaw/openclaw.plugin.json` is a *native* manifest — a skill-only pack
that installs through the bundle route above; the repo's `docs/install.md` §OpenClaw
has the native-vs-bundle distinction.)

### Tracing and triggering

- **The rules are applied for you.** OpenClaw is the one host where claiming is not
  the agent's job: the [openclaw-team](https://github.com/tanyu216/openclaw-team)
  framework installs Task Panel by default and runs a per-agent poll that claims
  `todo` / `stale` cards through the board's own criteria. §1–§3 and §7 happen
  around the agent rather than by it.
- **The session id still travels with every write.** Pass
  `--agent-platform openclaw --session-id <id>` so a card's trail points back at the
  session that did the work (§8); the framework keeps that id stable across resumes.
- **No supervisor to build.** OpenClaw is the one host that installs **no**
  scheduler of its own: `install.sh --target openclaw` writes the skill only, and
  the [openclaw-team](https://github.com/tanyu216/openclaw-team) framework's
  `poll` / `patrol` automations *are* the [Waking & patrol](#waking--patrol-唤醒与巡检)
  design. Install that framework instead of wiring anything by hand.

## Claude Code

### Install

```bash
bash install.sh --target claude --link --force     # skill → ~/.claude/skills/task-panel

# or, as a plugin from the marketplace:
claude plugin marketplace add "$PWD"
claude plugin install task-panel@task-panel-marketplace -y
claude plugin list                                 # → task-panel, enabled
```

### Tracing and triggering

- **Session scoping is per-directory.** Claude Code loads the skill from the
  project you are in, so run `node scripts/run.mjs context current` first to learn
  which board project owns this directory (`cli.md` §`context`).
- **Stamp every write with the host and session:** `--agent-platform claude
  --session-id <id>`. Use the id of the Claude Code session, so the card's trail
  points back at the conversation that did the work.
- **Bind the card to the branch / worktree** you are working in: record it once
  when you claim (`session set <ref> --seg <seg> --backend claude`), so a card
  names the checkout it belongs to.
- **No timers of its own — the loop lives outside.** Claude Code hooks fire only
  on session events, so the claim in §1 is driven by the supervisor
  ([Waking & patrol](#waking--patrol-唤醒与巡检)): a launchd / systemd / cron unit
  runs `scripts/supervisor.mjs`, which wakes a headless `claude -p` session
  (`--resume <sid>` to continue one). `install.sh` drops the units and the
  `wake-claude.sh` glue and prints the load command.

## Codex

### Install

```bash
bash install.sh --target codex --link --force      # skill → ~/.codex/skills/task-panel

# or, as a plugin from the marketplace:
codex plugin marketplace add "$PWD"
codex plugin add task-panel@task-panel-marketplace
codex plugin list                                  # → task-panel
```

(The `pi` / Agent Skills target installs the same skill to `~/.agents/skills/task-panel`.)

### Tracing and triggering

- **Session ownership comes from the thread.** Codex exposes the running thread as
  **`CODEX_THREAD_ID`**; read it and use it as the session id, so a card's trail
  is attributable at the conversation level:
  `--agent-platform codex --session-id "$CODEX_THREAD_ID"`.
- **Same claim-first order**, same board checks (§1). Resolve the project with
  `context current` before creating or claiming anything.
- **No timers of its own either.** Codex does not poll the board, so §1 is driven
  by the supervisor ([Waking & patrol](#waking--patrol-唤醒与巡检)) waking a
  `codex exec` turn, or by a Codex app automation
  (`intervalMinutes` / `quotaAware` / `model` / `reasoningEffort`). The bundled
  `~/.codex/task-panel-claim.sh` trigger remains the minimal fallback.

## A minimal worked example

From the skill directory, the shortest complete loop (Claude Code shown; on Codex
swap the actor flags for `--agent-platform codex --session-id "$CODEX_THREAD_ID"`).

**Prerequisites for the placeholder names below.** `PROJ-0007` stands for a real
card on *your* board and `linus` for the assignee it belongs to — substitute the
identifier `issue candidates` prints for you. `$SESSION` is the host's session id
(see your host's *Tracing and triggering* section): the Claude Code session id you
launched with, or `$CODEX_THREAD_ID` on Codex.

```bash
# 0. which project owns this directory?
node scripts/run.mjs context current

# 1. claim-first: read the claimable set, then take exactly one
node scripts/run.mjs issue candidates --assignee linus --agent-platform claude --session-id "$SESSION"
node scripts/run.mjs issue move PROJ-0007 in_progress --agent-platform claude --session-id "$SESSION"

# 2. register the session (which conversation is on this card) — the resume key
node scripts/run.mjs session set PROJ-0007 --seg seg1 --backend claude \
  --agent-platform claude --session-id "$SESSION"

# 3. …do the work; leave a decision trail while you go…
node scripts/run.mjs comment add PROJ-0007 --kind decision --body "Chose the SQLite trigger path."

# 4. deliver with a report — the gate refuses an empty round
node scripts/run.mjs report template PROJ-0007
node scripts/run.mjs issue deliver PROJ-0007 --report-file - \
  --agent-platform claude --session-id "$SESSION"
# → status in_review; a human accepts to done (self-review ≠ acceptance, §6)
```

## See also

- [`cli.md`](cli.md) — the command surface, the delivery gate, the `--json` contract.
- [`reports.md`](reports.md) — daily / weekly / monthly reports and statistics.
- [`SKILL.md`](../SKILL.md) — the agent-facing entry point; §Claiming work restates
  rules 1–2 as a checklist.
- [openclaw-team](https://github.com/tanyu216/openclaw-team) — the dispatcher that
  applies these same rules automatically on an OpenClaw host.
