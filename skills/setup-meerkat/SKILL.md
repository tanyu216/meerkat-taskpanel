---
name: setup-meerkat
description: Idempotently install and configure Meerkat TaskPanel for this machine — detect the server, taskctl, board/chat/director skills, role skills and supervisor, install what is missing, offer the Matt Pocock issue-tracker integration, move a Jobs/Linus/Turing/Reviewer/Worker role skill between agent platforms, and initialize a project's decision rights, ownership map and handoff markers. Use when the user runs /setup-meerkat or asks to set up, repair, or add role skills to Meerkat TaskPanel.
disable-model-invocation: true
---

# setup-meerkat

One idempotent pass over the things a working Meerkat TaskPanel deployment needs:

1. **Install/repair** the server, `taskctl`, the `meerkat` board skill, the
   `meerkat-chat` human console, the `meerkat-director` decision hub and the supervisor.
2. **Point the CLI at the right board** — local `taskd` or a remote one — and confirm the
   choice before anything starts.
3. **Offer the Matt Pocock integration** (`/setup-matt-pocock-skills`) when that skill is
   present, without overwriting an unrelated tracker.
4. **Leave the task entry and the team contract** — run the host's init step (`/init`), then
   give it the required content (the `/meerkat` keywords, the card scope, the ownership map
   and the handoff markers) so every later session starts from the board knowing who owns
   what. The host owns where it lands.
5. **Install and route role skills** — Jobs/Linus/Turing/Reviewer/Worker are standalone
   skills; wherever each is installed is the platform it runs on. Move one between kinds only
   on request.
6. **Initialize decision rights** — point the project's task entry at the director's decision
   policy and the `worker → director → human` ladder (a pointer, never a copy).
7. **Write the fixed human name** so `--as-human` signs the person, never a role.

The security toolchain is not this skill's: it ships with the Linus role skill, which decides
and installs it during system initialization (§6).

This skill is **command-only** (`disable-model-invocation: true`). It installs software
and writes files, so it never runs unless the user asks for it.

Card operations themselves are the `meerkat` board skill's contract. This skill installs and
configures, and the role skills it installs defer every card write to that skill.

In the commands below, `<skill-dir>` is the directory containing this `SKILL.md` and
`<checkout>` is the detected source tree. Run the bundled scripts and `install.sh` by
absolute path; the current working directory is the user's project, not the skill or the
checkout.

## Modes

| Mode | Meaning |
|---|---|
| `--dry-run` | detect, plan and print; **no writes**, no clone, no daemon, no env merge |
| `--json` | machine-readable reports from the bundled scripts |
| `--project <dir>` | the repository/project whose instruction file and detection inputs matter (default: cwd) |
| `--actor-kind <kind>` | the platform to configure: pass the kind this skill is running on. `claude` is only the fallback default; `all` runs detection across every loop platform, which is what the role → platform report reads |
| `--checkout <dir>` | use this checkout instead of discovering one |
| `--human-name <name>` | the fixed local human name; exported as `MEERKAT_TASKPANEL_HUMAN_NAME` |
| `--yes` | accept recommended defaults only; destructive/overwrite/daemon steps still ask |

`--yes` never authorizes: starting a daemon, replacing a different existing file,
overwriting an unrelated issue tracker, or a remote server the user did not name.
Detection always runs with `TASKD_NO_AUTOSTART=1`; a probe must not start a board.

## 1. Detect — no writes

Run:

```bash
node <skill-dir>/scripts/detect.mjs --json --project <dir> --actor-kind <kind>
```

Report the important rows, not the raw JSON:

- `taskctl` path/version; `server.url`, its source (`flag`/`env`/`env-file`/`pointer`/
  `default`), `loopback` vs `remote`, and `/health`;
- board/chat/director/setup skills per actor kind, and the installed skill names each platform
  actually has; loop state and live pool; supervisor units;
- per platform (`platforms`): its `MEERKAT_TASKPANEL_AGENT_KIND_ORDER`, the role skills it
  actually carries (`roles`), and `available`;
- every discovered role with `installedOn`, `effective` and `fallback` — installation
  location is the routing, so this is a report, never a write;
- any retired `meerkat-loop` skill / roles tree / `MEERKAT_TASKPANEL_ROLES_DIR` value
  (`legacy`): report only, never delete;
- the fixed human name and its source (`env`/`settings`/`config`/`shim`/`env-file`/
  `fallback`);
- the Matt skill and any existing tracker file.

If the JSON is malformed, stop and report; never guess a path.

## The setup interview

Run the setup as one decision round. Detection is the fact-gatherer: never ask the user for
a board URL, role location, actor kind or human name that `detect.mjs` can establish. The
**frontier** is every setup *decision* detection leaves open — the board target, the install
set, which kinds carry which role skills, the identity, the tracker integration, and the card
scope. Security tooling is not on it: it belongs to Linus's system initialization (§6).

Ask the whole frontier in **one numbered round**, each question carrying a recommended
answer and worded so "yes" accepts it; `--yes` is the same shorthand for the recommended
non-destructive answers. A question that depends on another open one belongs to a later
round: the daemon question waits for "local + unreachable", and a role-move question waits
for an approved role set. Recompute after the answers.

The routing check is adversarial. Ask what the five roles would get wrong here, demand a
concrete counterexample card — a real card that would fall between two roles or belong to
none — and list the card shapes the project actually has. Every shape needs exactly one
accountable role; a shape none describes goes to **Worker**, and the reviewer must be
independent of the producer. The routing table is generated from each role's `shapes`
(`detect.mjs` reports it; the director receives it in its prompt), so there is no guide file
to persist or let drift.

One of those questions is the **card scope**: what work becomes a card here? Ask it as a
real question, not a formality — a board that accepts every request stops being a signal, and
a card costs a claim, an acceptance and a delivery report, so work that needs no trail
should not pay for one. The recommended answer is **the work a role owns**: product design,
development and architecture, bug fixes and refactors, test design, regression, performance
and independent review — whatever the role skills' shapes assign to a role. Outside the roles is outside the board: a question, a lookup, a one-off command, a
scratch experiment, the change being made in this conversation right now, or work the human
is doing themselves has no owner, so it does not become a card. A narrower answer ("only work
that crosses sessions") or a wider one ("every change, chores included") is valid: record it,
because the baseline carries it and every later session follows it.

The round closes only when the frontier is empty. Do not install, write a file or start a
daemon before that, and never treat an incomplete answer as consent. `--yes` never authorizes
starting a daemon, replacing a different existing file, overwriting an unrelated tracker, or
a remote server the user did not name.

When detection reports more than one **available** agent kind, add one later-round
question — **which kinds carry which role skills** — after the install set is settled:

1. Show each kind's facts: the chat and director skills and the role skills it carries.
   Never guess these.
2. Recommend **one kind for all roles** (one supervisor per machine), chosen as the kind
   whose capabilities best cover the team.
3. Offer a move as the explicit alternative — a role skill copied to another kind and
   removed from this one only with an explicit yes (`rolePlatforms` is the advisory
   capability proposal; `detect.mjs`'s `roles` report is the truth). Say the cost plainly:
   the role then runs on that kind's CLI, and a role installed on no available kind is not
   claimed at all.
4. The user may accept the recommendation, name a move, or decline and keep one
   platform. Never assign a role to a platform the user did not approve, and never enable a
   second supervisor without the explicit `--supervisor-actor-kinds`.

## 2. Install or repair

Pick the source, in this order:

1. `--checkout` / `MEERKAT_TASKPANEL_ROOT` / `MEERKAT_TASKPANEL_REPO`;
2. the cwd, if it is a checkout (`src/cli/index.mjs` + `skills/`);
3. the published installer, when `npx meerkat-taskpanel` is available;
4. a shallow clone of `https://github.com/tanyu216/meerkat-taskpanel.git` into
   `~/.cache/meerkat-taskpanel/checkout`.

The npm package is not live yet (the registry currently returns 404), so a clone is the
normal non-checkout fallback. Try the published path **once**; on failure fall back
immediately, never loop.

Before installing, merge the board address into the effective env file
(`<home>/.meerkat-taskpanel/.env` for an installed server, the checkout `.env` for a
source run, or `MEERKAT_TASKPANEL_ENV_FILE`):

```bash
node <skill-dir>/scripts/configure-env.mjs --file <env-file> --key TASKD_URL --value <url> --json
```

Then show the plan with the installer's own dry run, and only then run it:

```bash
# <kind> is the platform this skill is running on (claude, codex or pi).
bash <checkout>/install.sh --target <kind>,server --agent-name <name> --dry-run
# local board: the same without --dry-run
# remote board: bash <checkout>/install.sh --target <kind> --no-automation
```

The first `claude|codex|pi` in `--target` is the primary kind and receives the team skills;
an upgrade refreshes a role on the kind that already carries it.

Always drive the installer with explicit flags (or `--non-interactive`); never `-i`, and
never a bare `install.sh` from a terminal — with no options on a TTY it opens a wizard and
waits for a human.

- **Local + reachable**: skip the server install; do not restart what is healthy.
- **Local + unreachable**: propose `--target <kind>,server`; the taskd guard loads a
  keepalive, so ask separately before enabling it.
- **Remote + reachable**: `--target <kind> --no-automation` (no local server, no guard),
  then confirm the remote URL in the env file. Never fall back to localhost.
- **Remote + unreachable**: report the failure and ask for a corrected URL; stop.
- **No URL/pointer**: report `source: "default"` and confirm
  `http://localhost:9527` before installing.
- **No frontend toolchain**: a checkout without `web/node_modules` or a built `web/dist`
  can install an API-only server with `--skip-web-build`; say so rather than hiding the
  missing board UI.

Pass the human name as `MEERKAT_TASKPANEL_HUMAN_NAME=<name>` to `install.sh`; the
installer renders it into `TASKCTL_HUMAN`. If the name is a fallback (`USER`/`LOGNAME`),
ask for the fixed name and set it explicitly. A token goes in `TASKD_TOKEN` or
`TASKD_TOKEN_FILE` (mode 0600); never print it.

`install.sh` copies `setup-meerkat` onto the **primary kind** (the first `claude|codex|pi`
in `--target`); other actor kinds get the board skill only. OpenClaw gets the board only by
design. The runtime finds `meerkat-director` wherever it is installed, so no config records
its location.

## 3. Matt Pocock integration

Check `<home>/.claude/skills/setup-matt-pocock-skills/SKILL.md`.

Tracker candidates, in order: `docs/agents/issue-tracker.md` (canonical),
`docs/agents/issue-tracer.md`, `team/issue-tracer.md`, `team/issue-tracker.md`.

- exists and mentions `meerkat` / `taskctl` / `taskpanel` → already integrated; skip.
- exists and is unrelated → **ask** before overwriting; `--yes` does not authorize it.
  Back up to `<file>.bak-<timestamp>` before writing.
- missing → offer two paths:
  1. print the command for the user:
     `/setup-matt-pocock-skills  — integrate meerkat-taskpanel as this repository's issue tracker`
  2. with the user's agreement, read that skill's `SKILL.md` and follow its process
     manually (Section A = Other, describing the `taskctl` board workflow).

The Matt skill is `disable-model-invocation: true`; it is user-invoked only, so this skill
cannot invoke it. Say which route was taken; never claim a skill ran when it did not.
Write only the per-repository outputs (`docs/agents/issue-tracker.md`,
`docs/agents/domain.md`, optionally `docs/agents/triage-labels.md`, and the
`## Agent skills` block in the existing `CLAUDE.md`/`AGENTS.md`). The `## Agent skills` block
is the tracker's; the task entry §4 requires goes in the same instruction file, in that
file's own shape. Never create board labels: the registry is read-only and grows when a card
names a label.

## 4. The project's task entry

The board is the entry only when the project's own instruction file says so. Run the host's
init step over `--project` first — `/init` where the host has one (Claude Code and Codex do) —
so the file describes the real tree. That step reads the code, not the board or the installed
role skills, and does not carry the task entry or the team contract: give it both requirements
in the same turn. Without an init step, write the requirements yourself.

**What the file must say** — requirements, not a template:

- `/meerkat` is the entry for every card on the local Meerkat TaskPanel board: a card is
  created, claimed, kept alive with a heartbeat and delivered through that skill, never
  through a side-channel queue (a TODO file, a chat list, a private plan).
- A card stops at `in_review`; the card's `acceptance_mode` names who moves it to `done` —
  `human`: a person, after the review finishes; `auto`: the loop after a current-round
  `APPROVE`; `off`: the deliverer.
- The card scope: what work becomes a card here, and what stays out — a question, a lookup or
  a one-off command has no owner, so it is not a card; the recommended default is the work a
  role owns (the setup interview's answer).
- How a session routes its own work: role skills are discoverable (`skills/<role>/`), so a
  session that takes work a role owns reads that role's `SKILL.md` and follows its workflow.
  The supervisor injects the handoff only for cards it dispatches; the installed copy is
  authoritative. The card is still created and delivered through `/meerkat`.
- **The team contract** — one compact map of ownership and handoff, generated from the
  installed role skills, not a copy of their workflows:
  - each role and the work shapes it owns (Jobs / Linus / Turing / Reviewer / Worker), read
    from the installed `role.json`; the Reviewer is never routed an ordinary card;
  - who lands and cleans up: the supervisor's acceptance pass merges the lane and removes
    the worktree; the card's `acceptance_mode` names who may close it; no role creates a
    downstream or fix card — the director does;
  - the handoff markers and their writers: `stage_handoff=required` (the producer role),
    `design_stage` and `product_change=none` (the creator or the director's triage), the
    project's `review_gate` (Linus), and `handoff_consumed_round` / `handoff_declined_round`
    (the director's triage).
  Point at each installed `skills/<role>/SKILL.md` and the director's
  `references/decision-policy.md` for the detail; the map is an index, not a copy.
- **Decision rights**, initialized here and owned by `meerkat-director`: the ladder is
  worker → director → human; a worker asks with an agent `question` and holds (`issue
  wait`); the director answers with an agent `note` and returns the card to `todo`, or escalates E1–E5 to
  `awaiting` (scope, acceptance, design direction, security/data, architecture); only a human
  comment resumes `awaiting`. Point at the installed director skill's
  `references/decision-policy.md`; never copy the policy into the project instruction file.
  A project may instead add its own refinement at `docs/agents/decision-policy.md`, which the
  director reads before applying the default E1–E5 map.

Keep the keywords — `/meerkat`, `card`, `claim`, `heartbeat`, `deliver`, `in_review` and
`done` — because a later session greps for them, and they are what sends it to the board
skill instead of an invented queue.

**Where and how it lands is the host's call.** Write it in the file the host reads —
`CLAUDE.md`, or `AGENTS.md` where that is the read order — in that file's own idiom, and
merge it into an existing task or tracker section when one is there: one statement of the
board, never a second section. Ship no marker, managed block or fixed heading; the init step
owns placement, this skill owns the requirements. Ask before the first write to an existing
file, and leave everything the requirements do not name alone.

A second run reports the entry `unchanged` when the file already states it — never restate or
duplicate it. **The scope is the interview's answer.** When the user narrowed or widened it in
the setup round, rewrite the scope requirement before the write and say so in the summary — a
scope that lives only in the conversation is lost on the next session.

## 5. Role skills and the team

The standard team is five **standalone role skills** shipped in this repository:

| Role | Skill | Board agent | Owns |
|---|---|---|---|
| Jobs | `jobs` | `Jobs` | product planning, prototype validation, PRD, product glossary/ADRs, visual/interaction design |
| Linus | `linus` | `Linus` | architecture and project initialization, the security toolchain, implementation, refactoring, bugs, the agent-instruction baseline |
| Turing | `turing` | `Turing` | test design, post-fix regression (incl. production), optional performance, security assessment |
| Reviewer | `reviewer` | `Reviewer` | independent review; verdict only |
| Worker | `worker` | `Worker` | the fallback: any work no other role owns, and every unassigned card |

Each role skill carries `SKILL.md` (the workflow entry a session reads), `role.json`
(the machine-readable identity: `schema: "meerkat-role"`, `agent`, `lanes`, `shapes`,
`self_check`, `reviewer_prompt`) and `references/` (branch workflows and the self-check).
The decision hub is `meerkat-director`, installed beside them; its
`references/decision-policy.md` is the only decision-authority source.

**Installation location is the routing.** A role skill present under
`<home>/<agent-dir>/skills/<role>/` is carried by that kind; the supervisor scans every
installed kind, prefers its own primary kind, then the configured
`MEERKAT_TASKPANEL_AGENT_KIND_ORDER` (written by `install.sh` from the `--target` order; the
default is claude → codex → pi). There is no roles root, no manifest and no
platform-mapping config key.

`install.sh` puts the director, the chat console, this skill and every role skill on the
**primary kind** — the explicit `--supervisor=enable` actor kind when one was named, else the
first `claude|codex|pi` in `--target` order (`all` → claude). On an upgrade it scans for each
role and refreshes every copy that is in `--target`; a role whose only home is outside
`--target` is reported and left alone, and a role added by a later release defaults to the
primary kind. Role skills are always **copied**, never linked. The runtime finds
`meerkat-director` by scanning the installed kinds (primary first), so its location is never
a config value.

### Defaults the installer writes

`install.sh` seeds each kind's config (and this skill may re-assert them), never as an
overwrite without consent:

```text
MEERKAT_TASKPANEL_AGENT_KIND_ORDER=claude,codex,pi
MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes
```

`CLAIM_UNASSIGNED=yes` is the Worker default: an unassigned card is claimed as `Worker`,
never as whichever role the scan names first. The claim set is **discovered**, not configured:
there is no scan-set key, and a custom name with no role skill writes without being claimable.
There is no reviewer key either: a review card's assignee is the role catalog's
`default_reviewer` (normally `Reviewer`).
The scheduling units carry the loop's writer identity (`--agent`); the catalog
(`<config root>/roles.json`, read with `taskctl role list`) is the assignee range.

Creating a team card is the routing step: pass the role's board name
(`--assignee Jobs --assignee-kind agent`).

### Moving a role between platforms

`detect.mjs --actor-kind all --json` reports, per role, `installedOn`, `effective` and
`fallback`. Installation location *is* the answer: a role installed on one kind runs there.

To move a role — for example Turing onto codex — copy its skill directory from the source
kind to the target kind's `skills/` tree with the bundled script (the director is not moved
by this skill; the runtime finds it wherever it is installed):

```bash
node <skill-dir>/scripts/route-role.mjs --role turing --to codex --home <home> --dry-run
# then without --dry-run, after showing the copy; add --confirm-remove only on an explicit yes
```

- **show the copy, then ask before deleting the source**; a role the user did not name is
  never deleted, and a source is deleted only with `--confirm-remove` (never in a dry run);
- re-run `install.sh --target <kind>` to refresh native agent definitions for the new location;
- a re-run reports the same state as `unchanged`, and a differing target is a conflict
  unless `--force` is given.

**Retired structures are reported, never read or deleted.** `detect.mjs` names a legacy
`meerkat-loop` skill, a `meerkat-loop/roles/` tree, a project `.meerkat/roles/`, or an
old-shape `MEERKAT_TASKPANEL_ROLES_DIR` value: all are deprecated, and the skill removes
none of them. One distinction matters: a `MEERKAT_TASKPANEL_ROLES_DIR` that points at a
directory of `role.json` directories is still honored as an explicit discovery override by
the supervisor; a roles tree without `role.json` files is not read. The new role skills
already ship their own workflows; an old file is copied into a role skill only when the user
asks for that specific file, after reviewing it — nothing is copied or deleted automatically.

The team's prose (each role's workflow, self-check, the reviewer protocol and the security
checklist) lives only in those skills. This skill installs them and initializes the project;
it ships no copy of their content.

## 6. Security toolchain — Linus owns it

The security toolchain (the four arms, their floors, the `toolchain.json` inventory, the CI
templates, `scripts/security-tools.mjs`) ships with the **Linus role skill**, not here.
Deciding which scanners the architecture needs and installing missing tools during system
initialization is Linus's `architecture-workflow.md` § Security toolchain and self-check
A19. This skill does not check, install or upgrade a scanner; if the machine must be
pre-provisioned, run `<linus-skill-dir>/scripts/security-tools.mjs --check` from that skill
and follow its printed commands with the user's consent.

## 7. Verify and finish

1. Re-run `<skill-dir>/scripts/detect.mjs --json`; report every discovered role with
   `installedOn`, `effective` and `fallback`, and the discovered scan set (worker roles plus
   the configured reviewer) the supervisor will use.
2. Check the director's decision policy exists at the installed `meerkat-director` skill —
   the kind `detect.mjs` reports as carrying it (the runtime scans, so it need not be the
   primary kind) — at `references/decision-policy.md`; its absence is a finding, not a pass.
3. Check that every kind a role is expected to run on has its CLI available; an unavailable
   kind is a fallback or a reported gap, never a silent one.
4. Run `install.sh --supervisor=enable` for the primary actor kind. Then read
   `taskctl loop status --actor-kind <kind>`: the `scan set:` must name the Worker role and
   every role whose cards are created, and its role lines must show the effective platform.
   A name the loop does not scan can never claim its cards, so a mismatch is a **finding to
   report**, never "ready".
5. Re-read the host's instruction file: the task entry is stated once, names `/meerkat`, and
   carries the card scope, the team contract (role shapes and the marker writers) and the
   decision-rights pointer.
6. Summarize: what was installed, where, each role's effective platform (and any fallback),
   the human name, the instruction file that received the task entry and the team contract,
   and what was skipped and why.
7. A second run must change **no managed content**: role skills, native definitions and env
   keys report `unchanged`, and the task entry reports `unchanged` rather than being restated
   or duplicated; `install.sh` may re-copy identical runtime bytes, which is still idempotent.
   Report every action as `written` / `unchanged` / `skip` / `conflict`.

## Identity and decision rights (what the team inherits)

The card identity rules — the agent signature, the reporter and the assignee kind — are the
`meerkat` board skill's contract; the creator, assignee and report/comment author are the
role, not a human. A human decision or constraint is recorded only with `--as-human`, which
signs the fixed `TASKCTL_HUMAN`; never use it for a role's own view.

The ladder is **worker → director → human** and lives in the `meerkat-director` skill's
`references/decision-policy.md` — this skill points the project at it and copies nothing. A
worker asks with an agent `question` comment and holds (`issue wait`); the director decides
what it can with an agent `note` and the ladder's move, or escalates E1-E5 to `awaiting` with
the question.
Only a human comment resumes an awaiting card, whatever its kind; the resumed worker judges
from its content whether it is a complete decision. The reviewer never enters awaiting;
insufficient evidence is a `VERDICT: REJECT`.

## Files

```text
skills/setup-meerkat/
├── SKILL.md
├── references/{detection,install,matt-pocock,evals}.md
├── evals/evals.json
├── scripts/{detect,configure-env,route-role}.mjs
└── scripts/lib/{agent-kinds,atomic,env-merge,entry-guard}.mjs
```

The scripts are standalone: Node builtins and their own `lib/` only. They must never
import `src/core`, `src/cli` or `src/server` — the installed skill has no checkout.
