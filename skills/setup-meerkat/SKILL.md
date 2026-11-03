---
name: setup-meerkat
description: Install, upgrade, configure and extend Meerkat TaskPanel on this machine, one capability at a time — taskctl/taskd install and upgrade, taskctl/taskd configuration and conflict repair, meerkat-director project rules, meerkat project rules under docs/agents, moving Jobs/Linus/Turing/custom roles between agent platforms, and creating a new role from the shipped template. Use whenever the user runs /setup-meerkat or asks to set up, upgrade, repair, configure, migrate or extend Meerkat TaskPanel, even if they do not name the skill.
disable-model-invocation: true
---

# setup-meerkat

Six capabilities, worked as **six rounds in a fixed order**, one round at a time:

1. **Install and upgrade** — `taskctl`, the local `taskd`, and the agent skill bundle.
2. **Configuration** — taskctl/taskd env layers, conflict repair and parameter tuning.
3. **The director's project rules** — E1–E5 refinements in `docs/agents/decision-policy.md`.
4. **The board skill's project rules** — `docs/agents/*.md`, then one `init` call for the
   project's agent-instruction entry.
5. **Roles across agent platforms** — which kind carries which role skill, and moves.
6. **Create a role** — a new role skill in an installed agent tree, from the shipped template.

Load only the reference a round needs; detection runs once, before round 1. This skill is
**command-only** (`disable-model-invocation: true`) because it installs software and writes
files. Card operations are the `meerkat` board skill's contract; the security toolchain is
the Linus role's. This skill installs and configures, and ships no copy of a role's prose.

In the commands below, `<skill-dir>` is the directory containing this `SKILL.md` and
`<checkout>` is the detected source tree. Run the bundled scripts and `install.sh` by
absolute path; the current working directory is the user's project.

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

Do not re-detect per round; re-read only the field that round needs. Then work rounds 1 → 6
in order. Each round has four beats:

1. **Say the facts.** One short line from detection for this capability, and what is at
   stake.
2. **Ask.** Put this round's questions to the user, each with a recommended answer worded so
   "yes" accepts it. The question list in each round is a **floor, not a ceiling**: every
   listed question is mandatory, and any follow-up the facts or the answers raise must also
   be asked. The round closes only when its own frontier is empty — never just read the list
   aloud and move on.
3. **Act only on the answers just given.** No writes before the answer. Report every action
   as `written` / `unchanged` / `skip` / `conflict`.
4. **Report the round**, then ask whether to continue to the next round. Skipping is always
   valid; record `skipped` and do not nag.

A later round may depend on an earlier one: a remote board removes the server half of rounds
1 and 2; the approved role set decides round 6's write locations. `--yes` accepts the
recommended **non-destructive** answers only. It never authorizes starting a daemon,
replacing different content, overwriting an unrelated tracker, or a remote server the user
did not name.

There is **no state file**. Every run re-detects: finished rounds report `unchanged`, a
skipped round can be done later, and an interrupted run resumes without appending twice.

## 1. Install and upgrade

Read `references/install-upgrade.md`.

Compare `taskctl.version`, a local `server.health.version`, and `checkout.version` (numeric
`major.minor.patch`, never string order). Upgrade only when the source is newer; never
downgrade silently. When `server.class` is `remote`, **skip the server entirely**: install or
upgrade only `taskctl` and the agent skill bundle with
`install.sh --target <kind> --no-automation`, and never write a taskd guard. When local,
propose `--target <kind>,server`, show the installer's `--dry-run` plan first, and ask
separately before starting or restarting the daemon.

The questions are the source, the target kinds, whether to upgrade, whether to enable the
local guard, and the fixed human name when detection reports a fallback. A source, token or
name the user did not give is never assumed.

## 2. Configuration

Read `references/config.md`.

Run the read-only audit:

```bash
node <skill-dir>/scripts/audit-config.mjs --home <home> --actor-kind <kind> --json
```

It reports the layering across process env, the shared `.env`, `.env.<kind>` and the shim:
hard errors the board loader will refuse, silent last-wins duplicates, mislaid loop keys,
the token pair, and deprecated keys. Every secret is shown as `<set>`. Show the conflicts,
ask which to repair, and repair only through `configure-env.mjs` — a different value is a
`conflict` (exit 3) until the user consents to `--force`, and a mislaid or duplicated key is
removed with `--remove`. Keep `MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes` so an unassigned card
is claimed as `Worker`, never as whichever role scans first. When the board is remote, skip
`TASKD_HOST/PORT/DATA_DIR/ALLOW_*`; only the address, token and per-kind loop keys apply.

## 3. The director's project rules

Read `references/director-project.md`.

The only project hook the director reads is `docs/agents/decision-policy.md`. Ask each
E1–E5 item: keep the default, change its subject, or make it director-decided? Ask whether
to add a project-specific reserved matter. Write **only the items the user changed**, never
the whole default table; the codes stay E1–E5 and the ladder, round protocol and recording
rules are fixed. Point at the installed `meerkat-director` skill's
`references/decision-policy.md`; never copy the default policy into the project.

## 4. The board skill's project rules

Read `references/board-project.md`.

Write the project's board rules once, under `docs/agents/`: `acceptance-mode.md`,
`epic-cards.md`, and the tracker files (`issue-tracker.md`, `triage-labels.md`,
`domain.md`) through the Matt Pocock process. Ask which card shapes take `human` or `off`
(there is **no project default**; omitted falls back to `auto`), the project's epic-splitting
boundary, and the card scope (the default is the work a role owns; a question, a lookup or a
one-off command has no owner and is not a card). Skip any item the user declines.

Call the `init` skill for the project's agent-instruction entry, and require it to point
card work at the `/meerkat` skill and board rules at `docs/agents/` (`acceptance-mode.md`,
`epic-cards.md`, `issue-tracker.md`, `triage-labels.md`, `domain.md`, and
`decision-policy.md` when present), and to state this round's card scope. The entry and the
rules are project content shared by every platform: call `init` once, write the rules once
under `docs/agents/`, never copy them per platform, never write an entry yourself, and report `skip` when the host has no `init` skill.

## 5. Roles across agent platforms

Read `references/roles-platforms.md`.

**Installation location is the routing.** A role skill present under
`<home>/<agent-dir>/skills/<role>/` runs on that kind; the supervisor scans every installed
kind, prefers its own primary kind, then `MEERKAT_TASKPANEL_AGENT_KIND_ORDER`. There is no
roles root and no manifest. Every discovered role counts, including a custom one.

Show each kind's facts and recommend **one kind for all roles** — one supervisor per machine.
Ask **which kinds carry which role skills**; a move copies the skill and removes the source
only on an explicit yes. Never assign a role to a platform the user did not approve, and
never enable a second supervisor without the explicit `--supervisor-actor-kinds`. Say the
cost: a role installed on no available kind is **not claimed at all**. The user may decline and keep one platform. The director, chat and setup skills follow the primary kind and are
not moved by this round.

After a move, refresh the native definitions and read `taskctl loop status`; the scan set
must name Worker and every role whose cards are created. Retired `meerkat-loop` trees are
reported, never read or deleted. `MEERKAT_TASKPANEL_ROLES_DIR` pointing at directories that
carry `role.json` is still a valid discovery override, not a retired key.

## 6. Create a role

Read `references/new-role.md`.

Before asking, read every installed `role.json`: the new id, agent and `native_agent` must
not collide, and its shapes must not overlap an existing role. A shape has **exactly one
accountable role**; a shape none describes goes to **Worker**. The reviewer must be
independent of the producer.

Interview the role's id, board agent, lane (`worker` or `reviewer`), title, summary, shapes,
responsibilities, boundaries, workflow branches and self-check. Write the answers as the spec
JSON the reference documents, then render and validate:

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

## Invariants every round keeps

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
   and `fallback`, and the platform facts each round touched.
2. Check `docs/agents/decision-policy.md` on the carrying kind, and that the `meerkat`
   skill is installed on every kind the user expects to use.
3. Run `install.sh --supervisor=enable` for the primary kind, then read
   `taskctl loop status --actor-kind <kind>`: the scan set must name Worker and every role
   whose cards are created. A name the loop does not scan is a finding, never "ready".
4. Re-read the project's agent-instruction entry: the `init` step ran, and it points card
   work at `/meerkat` and the rules at `docs/agents/`. If `init` was unavailable, report
   `skip` with the reason — never claim it ran.
5. Summarize: what was installed or changed, where, each role's effective platform and any
   fallback, the human name, the docs written, what was skipped and why.

## Files

```text
skills/setup-meerkat/
├── SKILL.md
├── references/{detection,install-upgrade,config,director-project,board-project,
│               roles-platforms,new-role,matt-pocock,evals}.md
├── assets/role-template/{SKILL.md,role.json,references/{workflow,self-check,reviewer-prompt}.md}
├── evals/evals.json
├── scripts/{detect,configure-env,audit-config,route-role,scaffold-role}.mjs
└── scripts/lib/{agent-kinds,atomic,env-merge,entry-guard}.mjs
```

The scripts are standalone: Node builtins and their own `lib/` only. They must never import
`src/core`, `src/cli` or `src/server` — the installed skill has no checkout.
