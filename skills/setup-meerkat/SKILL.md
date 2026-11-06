---
name: setup-meerkat
description: Install, upgrade, configure and extend Meerkat TaskPanel on this machine, one capability at a time — taskctl/taskd install and upgrade, taskctl/taskd configuration and conflict repair, meerkat-director project rules, meerkat project rules under docs/agents, moving Jobs/Linus/Turing/custom roles between agent platforms, and creating a new role from the shipped template. Use whenever the user runs /setup-meerkat or asks to set up, upgrade, repair, configure, migrate or extend Meerkat TaskPanel, even if they do not name the skill.
disable-model-invocation: true
---

# setup-meerkat

Six capabilities, worked as **six steps in a fixed order**, one step at a time:

1. **Install and upgrade** — `taskctl`, the local `taskd`, and the agent skill bundle.
2. **Configuration** — taskctl/taskd env layers, conflict repair and parameter tuning.
3. **The director's project rules** — E1–E5 refinements in `docs/agents/decision-policy.md`.
4. **The board skill's project rules** — `docs/agents/*.md`, then one `init` call for the
   project's agent-instruction entry.
5. **Roles across agent platforms** — which kind carries which role skill, and moves.
6. **Create a role** — a new role skill in an installed agent tree, from the shipped template.

Load only the reference a step needs; detection runs once, before Step 1. This skill is
**command-only** (`disable-model-invocation: true`) because it installs software and writes
files. Card operations are the `meerkat` board skill's contract; the security toolchain is
the Linus role's. This skill installs and configures, and ships no copy of a role's prose.

In the commands below, `<skill-dir>` is the directory containing this `SKILL.md` and
`<checkout>` is the detected source tree. Run the bundled scripts and `install.sh` by
absolute path; the current working directory is the user's project. Ask questions in the
user's language; the skill source stays English.

## Flags

| Flag | Meaning |
|---|---|
| `--dry-run` | detect and plan only; no writes, no daemon, no env merge |
| `--json` | machine-readable report from the bundled scripts |
| `--project <dir>` | the user's project (default: cwd) |
| `--actor-kind <kind>` | the host kind; `all` when detection must cover every kind |
| `--checkout <dir>` | use this source tree instead of discovering one |
| `--home <dir>` | the home to inspect/install (a sandbox form; default: `$HOME`) |
| `--human-name <name>` | the fixed human name, rendered into `TASKCTL_HUMAN` |
| `--yes` | accept the recommended non-destructive answers only |

`--yes` never authorizes a daemon, a different existing file, an unrelated tracker, or a
remote board the user did not name.

## How a run is structured

Run detection once, with autostart disabled so a probe never starts a board:

```bash
TASKD_NO_AUTOSTART=1 node <skill-dir>/scripts/detect.mjs --json --project <dir> --actor-kind all
```

Do not re-detect per step; re-read only the field that step needs. Then work Steps 1 → 6 in
order. Each step has three beats:

1. **Say the facts.** One or two plain-language facts from detection that decide this step,
   and what is at stake.
2. **Ask only what is still a decision.** Detection is the fact source: an answer it already
   establishes is reported as a fact, never asked. Ask only when the answer changes what
   happens next — the source, the target set, an upgrade, a repair, a platform placement or a
   role definition. State the fact that makes it a question in one plain sentence, then ask
   one decision at a time; put the recommended option first and label it `(recommended)`, so
   a bare "yes" accepts it. Give every option one or two plain-language lines saying what
   will happen and what changes as a result — the file written, the process started, the
   platform that then claims the card — not just the flag name; say what stays the same too.
   Ask in the language the user is writing in, even though this skill is written in English.
   A follow-up is allowed only when an answer opens a new real choice.
3. **Act, then report.** No writes before the answer. Report every action as `written` /
   `unchanged` / `skip` / `conflict`, then continue to the next step unless the user said
   skip or stop. Skipping is always valid; record `skipped` and do not nag.

**Safety confirmations are always asked**, even when detection says the end state is already
correct: starting or enabling the daemon or supervisor, `--force` replacing different
content, removing a source role copy, deleting old documents, installing runtime hooks, and
any destructive or remote action. `--yes` accepts recommended non-destructive answers only.

### Fast path

When the request names no specific change (for example "set up meerkat"), a run may stop
early. After the single detection run, take the fast path only when the facts show the
machine and project are already set up: `missing` is empty, `actions` is empty, the fixed
human name is configured, every `docs/agents/` document this run would write already exists
with the same content, and the agent-instruction entry already points card work at
`/meerkat`, the board rules at `docs/agents/`, and states the chosen card scope. Report every
step as `unchanged` in one short block, then go straight to **Verify and finish**. A missing
or different document is not "already set up": run that step. The fast path never skips a
safety confirmation. If the user names one capability or one change, run that step only and
leave the rest `skipped`.

A later step may depend on an earlier one: a remote board removes the server half of Steps 1
and 2; the approved role set decides Step 6's write locations. `--yes` accepts the
recommended **non-destructive** answers only. It never authorizes starting a daemon,
replacing different content, overwriting an unrelated tracker, or a remote server the user
did not name.

There is **no state file**. Every run re-detects: finished steps report `unchanged`, a skipped
step can be done later, and an interrupted run resumes without appending twice.

## 1. Install and upgrade

Read `references/install-upgrade.md`.

Compare `taskctl.version`, a local `server.health.version`, and `checkout.version` (numeric
`major.minor.patch`, never string order). Report the versions and locations as facts: equal
versions are `unchanged`; a newer source is the only reason to ask about an upgrade; an older
source is reported and never downgraded silently. Ask about the source only when more than one
is usable or none is; ask about the target kinds only when the install would widen beyond the
kinds detection already shows; ask for the fixed human name only when detection reports a
fallback. A source, token or name the user did not give is never assumed.

When `server.class` is `remote`, **skip the server entirely**: install or upgrade only
`taskctl` and the agent skill bundle with
`install.sh --target <kind> --no-automation`, and never write a taskd guard. When local,
propose `--target <kind>,server`, show the installer's `--dry-run` plan first, and ask
separately before starting or restarting the daemon. Never run a bare `install.sh`: its
default target is `all` (every kind plus the server), and it can start a daemon.

An agent-only run started from the source checkout writes `.env.<kind>` and the project map
into that checkout and points the shim and units at it. When the machine already has an
installed tree, pin the install to it:

```bash
MEERKAT_TASKPANEL_REPO=<home>/.meerkat-taskpanel \
MEERKAT_TASKPANEL_CONFIG_DIR=<home>/.meerkat-taskpanel \
MEERKAT_TASKPANEL_ENV_FILE=<home>/.meerkat-taskpanel/.env \
bash <checkout>/install.sh --target <kind> --agent-name <name> --dry-run
```

After the run, verify `kindConfig.programRoot`, `kindConfig.path`, `.env.<kind>` and the
shim's `exec node` line all name the installed tree.

## 2. Configuration

Read `references/config.md`.

Run the read-only audit:

```bash
node <skill-dir>/scripts/audit-config.mjs --home <home> --actor-kind <kind> --json
```

It reports the layering across process env, the shared `.env`, `.env.<kind>` and the shim:
hard errors the board loader will refuse, silent last-wins duplicates, mislaid loop keys,
the token pair, and deprecated keys. Every secret is shown as `<set>`. **No conflicts is a
fact**: report `unchanged` and ask nothing. When there are conflicts, show each with its file,
line and consequence, ask which to repair, and repair only through `configure-env.mjs` — a
different value is a `conflict` (exit 3) until the user consents to `--force`, and a mislaid or
duplicated key is removed with `--remove`. Keep `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes` so an unassigned card
is claimed as `Worker`, never as whichever role scans first. When the board is remote, skip
`TASKD_HOST/PORT/DATA_DIR/ALLOW_*`; only the address, token and per-kind loop keys apply.

## 3. The director's project rules

Read `references/director-project.md`.

The only project hook the director reads is `docs/agents/decision-policy.md`. Report the
E1–E5 defaults and any entries the project already carries as facts, and ask one gate: "Does
this project change any of the director's five decision areas?" Recommended: no — keep the
defaults and write nothing. If yes, ask only the items the user names. For each item offer:
**Keep the default (recommended)** — same behaviour, no entry; **Change the subject** — the
project's wording, same decider; **Make it director-decided** — the director answers without
stopping for the human; **Make it human** — every such decision stops for a person. Ask
whether a project-specific reserved matter should join the human list. Write **only the items
the user changed**, never the whole default table; the codes stay E1–E5 and the ladder,
round protocol and recording rules are fixed. Point at the installed `meerkat-director` skill's
`references/decision-policy.md`; never copy the default policy into the project.

## 4. The board skill's project rules

Read `references/board-project.md`.

Work in this order — the order matters, because the worktree guard blocks writes to the
primary checkout once `docs/agents/worktrees.md` exists.

1. Write `create-card.md` and the tracker files (`issue-tracker.md`, `triage-labels.md`,
   `domain.md`) through the Matt Pocock process. Read the installed `meerkat` skill's
   `references/scenarios/create.md` first so you know the default answer, then ask which card shapes
   take `human` or `off` (there is **no project default**; omitted falls back to `auto`) and
   the card scope (the default is the work a role owns; a question, a lookup or a one-off
   command has no owner and is not a card). Write only the user's answers into
   `create-card.md` — not a copy of that manual — and skip any item the user declines.
2. Offer `docs/agents/epic-graphs.md`: show the bundled `assets/epic-graphs.md` default
   template (`dev-verify` and `requirement`) and ask which graphs to keep or change. Write
   **only on an explicit yes**; the file is absent by default, and a re-run reports
   `written` / `unchanged` / `conflict`.
3. Declare the project's rules in the map:
   `taskctl project map set <id> --base-ref <ref> --merge-ref <ref>` (recommended:
   `base_ref = merge_ref =` the integration branch). The refs are probed at write time; a bad
   value is `PROJECT_REF_UNRESOLVED`. The page points at the map, never copies the values.
4. Call the `init` skill for the project's agent-instruction entry, and require it to point
   card work at the `/meerkat` skill and board rules at `docs/agents/` (`create-card.md`,
   `worktrees.md`, `issue-tracker.md`, `triage-labels.md`, `domain.md`, `epic-graphs.md`
   when present, and `decision-policy.md` when present), and to state this step's card scope.
   It must also say that a task or plan which is **not** a card is still role work:
   load the matching role skill (`jobs`, `linus` or `turing`) before the first edit, not only
   when a card handoff names it.
   The entry and the rules are project content shared by every platform: call `init` once,
   write the rules once under `docs/agents/`, never copy them per platform, and never write an entry yourself; report `skip` when the host has no `init` skill.
5. Write `worktrees.md` (see `references/worktree-guard.md`), after every other
   primary-checkout write. The page points at the map, never copies the ref values.
6. Only then, if the user accepts, install the worktree guard through
   `scripts/worktree-init.mjs` (show its `--dry-run` report first). This is the only
   initialization point — never add the wiring to an installer. Codex hooks must be reviewed
   and trusted in `/hooks`; report that step as still open until the user confirms it. The
   script merges hooks and writes the pi extension; it never writes `docs/agents/worktrees.md`
   (that page is the project's rule, written above).

If a guard is already active from an earlier run, writing `docs/agents/worktrees.md` arms it
immediately. Finish the remaining writes from a session worktree under `.worktrees/<slug>` if
a primary-checkout write is denied; the guard is a guardrail, not a sandbox.

## 5. Roles across agent platforms

Read `references/roles-platforms.md`.

**Installation location is the routing.** A role skill present under
`<home>/<agent-dir>/skills/<role>/` runs on that kind; the supervisor scans every installed
kind, prefers its own primary kind, then `MEERKAT_TASKPANEL_AGENT_KIND_ORDER`. There is no
roles root and no manifest. Every discovered role counts, including a custom one.

Show each kind's facts and recommend **one kind for all roles** — one supervisor per machine.
If every role already sits on one available kind and the user asked for no move, report that
placement as `unchanged` and ask nothing. Otherwise ask **which kinds carry which role skills**.
Offer two plain-language options: **One kind for all roles (recommended)** — one
supervisor; every role claims there; if that kind is unavailable, nothing is claimed. **Split
across kinds** — needs the explicit `--supervisor-actor-kinds`; more than one supervisor risks
racing for the same cards. A move copies the skill and removes the source only on an explicit
yes. Never assign a role to a platform the user did not approve. Say the cost: a role
installed on no available kind is **not claimed at all**. A kind reported `available: false`
has no director skill, so it must not receive a role until the team skills are installed. The
user may decline and keep one platform. The director, chat and setup skills follow the primary
kind and are not moved by this step.

After a move, refresh the native definitions and read `taskctl loop status`; the scan set
must name Worker and every role whose cards are created. Retired `meerkat-loop` trees are
reported, never read or deleted. `MEERKAT_TASKPANEL_ROLES_DIR` pointing at directories that
carry `role.json` is still a valid discovery override, not a retired key.

## 6. Create a role

Read `references/new-role.md`.

Run this step only when the user asks for a new role; otherwise report the installed roles
and `skip`. Before asking, read every installed `role.json`: the new id, agent and
`native_agent` must not collide, and its shapes must not overlap an existing role. A shape has
**exactly one accountable role**; a shape none describes goes to **Worker**. The reviewer must
be independent of the producer.

Ask only the fields that cannot be defaulted: id, board agent, title, summary and shapes.
Offer defaults for the rest — `native_agent` (the id), lane (`worker`), responsibilities,
boundaries, `system_prompt` (the static card-session board text), workflow branches and
self-check — and ask the user to confirm or edit. Say what the lane changes: **worker** claims
ordinary work; **reviewer** takes only review cards and never an ordinary card. Write the
answers as the spec JSON the
reference documents, then render and validate:

```bash
node <skill-dir>/scripts/scaffold-role.mjs --spec <spec> --skills-dir <home>/<agent-dir>/skills --dry-run --json
# then without --dry-run, after showing the paths
```

The script writes the role skill **only into an installed kind's skills tree** — never the
repository's `skills/`. It validates the `meerkat-role` schema, the id grammar, the lanes,
the shapes, the self-check path and the same caps the supervisor reads. A re-run is
`unchanged`; different content is a `conflict` until `--force`. After writing, let the
supervisor sync the role catalog and read `taskctl role list --json` to confirm the new role
is assignable. An installed-tree-only role is not refreshed or deleted by a later
`install.sh` run, and gets no native agent definition; the supervisor still injects the skill.
A role installed before the `reviewer_prompt` → `reviewer_handoff` rename keeps the old key
(the installer never clobbers an existing skill); the loader does not read `reviewer_prompt`
and logs a rename warning, and `install.sh --force` refreshes the skill.

## Invariants every step keeps

- **One accountable role per work shape.** A shape none describes goes to **Worker**; the
  reviewer must be independent of the producer. Outside the roles is outside the board: a
  question, a lookup, a one-off command or a scratch experiment is not a card.
- **Card operations belong to the `meerkat` board skill.** A card is created and claimed
  through it, kept alive with a heartbeat, and delivered to `in_review`; acceptance moves it
  to `done`. Never restate its verbs here or invent a side-channel queue.
- **The decision ladder is worker → director → human**, owned by `meerkat-director`'s
  `references/decision-policy.md`. Point at it; never copy it, and never record a human
  decision as an agent's.
- **The roles are standalone skills; installation location is the routing.** This skill
  ships **no copy of their content** — no role workflow, self-check or reviewer protocol.
- **The security toolchain is Linus's.** If the machine must be pre-provisioned, point at
  `<linus-skill-dir>/scripts/security-tools.mjs --check`; never install a scanner here.
- **Second run changes no managed content.** Role skills, env keys, docs and the
  instruction entry report `unchanged` rather than being restated.

## Verify and finish

1. Re-run `detect.mjs --json`; report every discovered role with `installedOn`, `effective`
   and `fallback`, and the platform facts each step touched.
2. Check `docs/agents/decision-policy.md` as project content, and that the `meerkat` skill
   is installed on every kind the user expects to use.
3. Read-only check only: show the installer's plan with
   `bash <checkout>/install.sh --target <primary-kind> --dry-run` if a plan is needed, and
   read `taskctl loop status --actor-kind <kind>`: the scan set must name Worker and every
   role whose cards are created. A name the loop does not scan is a finding, never "ready".
   Do not use `--supervisor=status` as a read-only check: it still walks the install path and
   writes. A daemon starts or is enabled only in Step 1, after a separate explicit yes.
4. Re-read the project's agent-instruction entry: the `init` step ran, and it points card
   work at `/meerkat` and the rules at `docs/agents/`. If `init` was unavailable, report
   `skip` with the reason — never claim it ran.
5. Summarize: what was installed or changed, where, each role's effective platform and any
   fallback, the human name, the docs written, what was skipped and why. Name open items:
   Codex `/hooks` trust, an old hand-installed guard kept as a second layer, and any taskd
   guard plist the installer left unrefreshed.

## Files

```text
skills/setup-meerkat/
├── SKILL.md
├── references/{detection,install-upgrade,config,director-project,board-project,
│               worktree-guard,roles-platforms,new-role,matt-pocock,evals}.md
├── assets/epic-graphs.md
├── assets/role-template/{SKILL.md,role.json,references/{workflow,self-check,reviewer-handoff}.md}
├── evals/evals.json
├── scripts/{detect,configure-env,audit-config,route-role,scaffold-role,worktree-init}.mjs
└── scripts/lib/{agent-kinds,atomic,env-merge,entry-guard}.mjs
```

The scripts are standalone: Node builtins and their own `lib/` only. They must never import
`src/core`, `src/cli` or `src/server` — the installed skill has no checkout.
