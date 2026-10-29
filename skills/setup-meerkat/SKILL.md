---
name: setup-meerkat
description: Idempotently install and configure Meerkat TaskPanel for this machine — detect the server, taskctl, board/loop skills and supervisor, install what is missing, offer the Matt Pocock issue-tracker integration, and install a Jobs/Linus/Turing plus reviewer team whose role workflows the loop loads. Use when the user runs /setup-meerkat or asks to set up, repair, or add a team to Meerkat TaskPanel.
disable-model-invocation: true
---

# setup-meerkat

One idempotent pass over the things a working Meerkat TaskPanel deployment needs:

1. **Install/repair** the server, `taskctl`, the `meerkat` board skill, the loop skill and
   the supervisor.
2. **Point the CLI at the right board** — local `taskd` or a remote one — and confirm the
   choice before anything starts.
3. **Offer the Matt Pocock integration** (`/setup-matt-pocock-skills`) when that skill is
   present, without overwriting an unrelated tracker.
4. **Leave the task entry** — run the host's init step (`/init`), then give it the required
   content (the `/meerkat` keywords and the card scope) so every later session starts from
   the board. The host owns where it lands.
5. **Install a team** — the standard Jobs/Linus/Turing + reviewer roles, or a custom team —
   into the loop, globally or per project.
6. **Check the security toolchain** — detect the free scanners the project's gates need,
   print the install/upgrade commands, and install or upgrade only on an explicit yes.
7. **Write the fixed human name** so `--as-human` signs the person, never a role.

This skill is **command-only** (`disable-model-invocation: true`). It installs software
and writes files, so it never runs unless the user asks for it.

Card operations themselves are the `meerkat` board skill's contract. This skill installs and
configures, and the team workflows it ships defer every card write to that skill.

In the commands below, `<skill-dir>` is the directory containing this `SKILL.md` and
`<checkout>` is the detected source tree. Run the bundled scripts and `install.sh` by
absolute path; the current working directory is the user's project, not the skill or the
checkout.

## Modes

| Mode | Meaning |
|---|---|
| `--dry-run` | detect, plan and print; **no writes**, no clone, no daemon, no env merge |
| `--json` | machine-readable reports from the bundled scripts |
| `--project <dir>` | the repository/project whose `.meerkat/roles` and `docs/agents` matter (default: cwd) |
| `--scope global\|project` | team install scope (default: global) |
| `--actor-kind <kind>` | the platform to configure (default: `claude`) |
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
- board/loop/setup skills per actor kind; loop state and live pool; supervisor units;
- effective roles root (explicit/project/global) and role count;
- the fixed human name and its source (`env`/`settings`/`config`/`shim`/`env-file`/
  `fallback`);
- the Matt skill and any existing tracker file.

If the JSON is malformed, stop and report; never guess a path.

## The setup interview

Run the setup as one decision round. Detection is the fact-gatherer: never ask the user for
a board URL, role root, actor kind or human name that `detect.mjs` can establish. The
**frontier** is every setup *decision* detection leaves open — the board target, the install
set, the team shape, the role set, the install scope, the identity, the tracker integration
and the card scope.

Ask the whole frontier in **one numbered round**, each question carrying a recommended
answer and worded so "yes" accepts it; `--yes` is the same shorthand for the recommended
non-destructive answers. A question that depends on another open one belongs to a later
round: the daemon question waits for "local + unreachable", and the custom-team questions
wait for "custom". Recompute after the answers.

The team choice is adversarial. Ask what the standard team would get wrong here, demand a
concrete counterexample card — a real card that would fall between two roles or belong to
none — and list the card shapes the project actually has. Require an ownership matrix: every
card shape has exactly one accountable role, and the reviewer is independent of the
producer. Work that belongs outside the roles is not force-fit into one: it goes to a worker
outside them, and that is an answer, not a gap. An unowned card shape is a finding only when
a defined role owns that shape. The matrix is persisted as `ownership.md` in the roles root;
the loop routes work by it.

One of those questions is the **card scope**: what work becomes a card here? Ask it as a
real question, not a formality — a board that accepts every request stops being a signal, and
a card costs a claim, an acceptance and a delivery report, so work that needs no trail
should not pay for one. The recommended answer is **the work a role owns**: product design,
development and architecture, bug fixes and refactors, test design, regression, performance
and independent review — whatever the ownership matrix the team question just settled assigns
to a role. Outside the roles is outside the board: a question, a lookup, a one-off command, a
scratch experiment, the change being made in this conversation right now, or work the human
is doing themselves has no owner, so it does not become a card. A narrower answer ("only work
that crosses sessions") or a wider one ("every change, chores included") is valid: record it,
because the baseline carries it and every later session follows it.

The round closes only when the frontier is empty. Do not install, write a file or start a
daemon before that, and never treat an incomplete answer as consent. `--yes` never authorizes
starting a daemon, replacing a different existing file, overwriting an unrelated tracker, or
a remote server the user did not name.

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
bash <checkout>/install.sh --target claude,server --agent-name <name> --dry-run
# local board: the same without --dry-run
# remote board: bash <checkout>/install.sh --target claude --no-automation
```

Always drive the installer with explicit flags (or `--non-interactive`); never `-i`, and
never a bare `install.sh` from a terminal — with no options on a TTY it opens a wizard and
waits for a human.

- **Local + reachable**: skip the server install; do not restart what is healthy.
- **Local + unreachable**: propose `--target claude,server`; the taskd guard loads a
  keepalive, so ask separately before enabling it.
- **Remote + reachable**: `--target claude --no-automation` (no local server, no guard),
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

`install.sh` copies `setup-meerkat` only for **Claude**; other actor kinds keep the board
and loop skills. OpenClaw gets the board only by design.

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

The Matt skill is `disable-model-invocation: true`; this skill cannot call it through
the Skill tool. Say which route was taken; never claim a skill ran when it did not.
Write only the per-repository outputs (`docs/agents/issue-tracker.md`,
`docs/agents/domain.md`, optionally `docs/agents/triage-labels.md`, and the
`## Agent skills` block in the existing `CLAUDE.md`/`AGENTS.md`). The `## Agent skills` block
is the tracker's; the task entry §4 requires goes in the same instruction file, in that
file's own shape. Never create board labels: the registry is read-only and grows when a card
names a label.

## 4. The project's task entry

The board is the entry only when the project's own instruction file says so. Run the host's
init step over `--project` first — `/init` where the host has one (Claude Code and Codex do) —
so the file describes the real tree. That step reads the code, not the board, and does not
carry the task entry: give it the requirements below in the same turn. Without an init step,
write the requirements yourself.

**What the file must say** — requirements, not a template:

- `/meerkat` is the entry for every card on the local Meerkat TaskPanel board: a card is
  created, claimed, kept alive with a heartbeat and delivered through that skill, never
  through a side-channel queue (a TODO file, a chat list, a private plan).
- A card stops at `in_review`; the card's `acceptance_mode` names who moves it to `done` —
  `human`: a person; `agent`: the loop after a current-round `APPROVE`; `off`: the deliverer.
- The card scope: what work becomes a card here, and what stays out — a question, a lookup or
  a one-off command has no owner, so it is not a card; the recommended default is the work a
  role owns (the setup interview's answer).
- When the setup installed a team, how a session routes its own work: taking on work a role
  owns, it reads that team's `ownership.md` from the loop's roles root (§5) and follows the
  workflow the guide names for that work shape — the loop injects the guide only for cards it
  dispatches, so a session that takes the work itself has to read it. The installed copy is
  authoritative; the template the team was installed from is only a seed. The card is still
  created and delivered through `/meerkat`.

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

## 5. Team

The team shape is one frontier question in the setup round (§The setup interview):
**standard** / **custom** / **skip**, with a recommendation and the trade-off. Ask it once,
with the rest of the frontier; the standard template below is the recommended answer unless
the project's card shapes contradict it.

The standard template is `assets/team/standard/`:

| Role | Board agent | Native agent | Scope |
|---|---|---|---|
| Jobs | `Jobs` | `jobs` | product planning, prototype validation, PRD, product glossary/ADRs, visual/interaction design |
| Linus | `Linus` | `linus` | system architecture and project foundation (system-init design), the technical specification, implementation, refactoring, bugs, agent-instruction baseline, code glossary/ADRs |
| Turing | `Turing` | `turing` | test design, post-fix regression (incl. production), optional performance, security, canonical terms |
| Reviewer | `Reviewer` | `reviewer` | independent fourth role; verdict only |

The template also ships `ownership.md` (the work→role routing guide) and the native agent
templates.

Each role's `self-check.md` is its **pre-delivery audit** — for a worker it maps the card's
requirements and acceptance to evidence and re-runs the gates; for the reviewer it audits the
verdict (the ledger is complete, every `met` cites an anchor, the delivered sha is recorded,
the earlier findings are answered). It is not the `## Handoff` block: only a producer card
(Jobs design, Linus architecture) writes that block, to carry cross-card inputs to the
project session. The last stage of every workflow is **Deliver**: run the self-check, add the
handoff block on a producer card, then deliver at `in_review` (the `meerkat` board skill owns
the delivery command).

A Jobs card keeps its working artifacts in `.meerkat/<id>/` — `spec.md`, `prototype/` and
`prd.md` — and the workflow's **mandatory archive stage** promotes them to the **project's**
`design/` tree under one content slug: `design/specs/<content-slug>.md`,
`design/prototype/<content-slug>/` and `design/prds/<content-slug>.md`. A design filename
never carries the task id; a same-topic artifact is updated, not duplicated. Jobs also keeps
`design/glossary.md` (product language) and `design/adr/NNNN-<slug>.md` (product decisions).
`.meerkat/<id>/plan.md` stays the card index and links the archived paths. The cross-card
channel is the `## Handoff` block in the delivery report: it names the archived paths, the
acceptance source, the delivery shape and the proposed next cards.

Before creating a downstream card the project session triages the target: a small change or
bug with no product archive gets a plain task with `meta.product_change=none` and no design
artifacts; a feature with an archive gets a task (or one per downstream stage) carrying the
`## Handoff` and `meta.design_stage`; a large feature with several independently verifiable
deliverables becomes an `epic` with one child per deliverable. Every card's worker writes
its own `.meerkat/<id>/plan.md`; no card inherits another card's plan.

Every worker workflow carries the same decision round before it freezes a direction: a
decision tree, the frontier of questions whose prerequisites are settled, one round at a
time with a recommended answer, and no building while a decision is open. Jobs keeps the
product glossary at `design/glossary.md` and product ADRs under `design/adr/`; Linus keeps
the codebase `GLOSSARY.md`, `docs/adr/` and the project document set (`README.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, plus the community files on a community open-source
project), and the root glossary links the product one without copying it. `ui-workflow.md`
also runs standalone for a single feature or prototype change.

Linus establishes the project's agent-instruction baseline (the host's `CLAUDE.md` or
`AGENTS.md`) as a foundation outcome. It is the file every role reads, not an optional step,
and it carries the entry commands, layout pointers, gates, the six principles, the working
agreement, the change and integration policy and the operational invariants. The
architecture flow records the project's standard technical specification at
`docs/tech-spec.md` — the stack, naming, layering, errors, configuration, constants and
enumerations, logging, tests and gates, each rule with its enforcement point — and the
baseline points at it for the
conventions rather than restating them.
The `/meerkat` task entry and its scope are the project-init stage's job (§4), not the
architecture flow's.
The project owns its own working-tree, branch and integration contract; the team's role
workflows do not restate it.

The architecture branch is the project's **system-initialization design flow**, not a
feature or module design. It decides the architecture style (DDD or a named simpler style),
the external contract when one exists, the configuration surface, the logging contract and
the planned directory tree against the design stance — simple, reliable, efficient, elegant,
not over-engineered, and high cohesion / low coupling — records the standard at
`docs/tech-spec.md` and the evidence in the architecture document and ADRs, and carries the
top-level tree map, the six design principles, the working agreement, the change and
integration policy and the operational invariants into the agent-instruction baseline, where
they bind every agent. A feature or
module inside the recorded architecture is
implementation work. The same six principles are applied as questions in
`implementation-workflow.md` Step 2 and audited by the implementation branch of
`self-check.md`.

Test execution and the security scan are the **review card's** gate, not a worker test
card: the project session seeds the gates into the card's acceptance, and the reviewer
re-runs all applicable suites (unit, integration, API and browser-based) and requires 100%
pass,
line/branch/function coverage >80%, the mock boundary
(http/websocket/db/redis only; never an internal module or function) and the project's
security scan (no unaddressed high/critical), then issues the verdict. A separate Turing
card is for test design and authoring (unit, integration, API and browser-based suites),
performance testing and a security assessment; it does not replace the gate. The reviewer
audits the changed surface against CWE Top 25, OWASP Top 10 and OWASP ASVS.

For a custom team, start from the standard template in a temporary staging directory,
change role names/responsibilities/workflows with the user, show the manifest and each
role's summary, then install with `--source <staging>`.

### Scope and precedence

- **global** (default): `<home>/<agent-dir>/skills/meerkat-loop/roles/`; requires the loop
  skill to be installed.
- **project**: `<project>/.meerkat/roles/`; wins as a whole manifest over global.

Install:

```bash
node <skill-dir>/scripts/install-roles.mjs --scope global|project --project <dir> \
  --actor-kind <kind> --source <dir> --dry-run --json
# then without --dry-run, after showing the file list
```

Files are written atomically, the manifest last; an existing different file is a
**conflict** and needs `--force` (ask first). No file is deleted. This skill is the **only**
path that installs or upgrades a team: `install.sh` ships no roles root and never creates,
writes or deletes one. Re-running the skill is the upgrade.

After installation, offer to merge (with consent) into the per-kind config that
`detect.mjs` reports as `kindConfig.path` (`<program root>/.env.<actor-kind>`):

```text
MEERKAT_TASKPANEL_AGENTS=Jobs,Linus,Turing
MEERKAT_TASKPANEL_REVIEWER=Reviewer
MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=no
```

Use `configure-env.mjs`; a different existing value is a conflict, not an overwrite. Get
an explicit yes for each key before writing it: an empty installer default (for example
`MEERKAT_TASKPANEL_REVIEWER=`) is **not** consent, and `--force` is never implied by an
empty value — ask before replacing it. Without `MEERKAT_TASKPANEL_AGENTS` the loop scans
only its default agent and a role card is never claimed. Creating a team card is the routing
step: pass the role's board name as `--assignee <role> --assignee-kind agent`; an unassigned
team card is unowned. A team is therefore **assignee-only**: ask before flipping an existing
`MEERKAT_TASKPANEL_CLAIM_UNASSIGNED=yes` to `no`, because an unassigned card is a defect to
report, not work for whichever role scans first.

Native agent definitions are written for every host with a native format: Claude
(`.claude/agents/<name>.md`), Codex (`.codex/agents/<name>.toml`) and Pi
(`~/.pi/agent/agents/<name>.md`, or `.pi/agents/<name>.md`). Pi's subagents come from the
`pi-subagents` extension (`pi install npm:pi-subagents`); the definition is inert until
that extension is installed. The loop's project session also uses that extension to spawn
one subagent per card; `detect.mjs` reports a missing extension and `install.sh --target pi`
prints the install command. `--native-agent-defs none` writes none of them.

## 6. Security toolchain

The team's security scan is three arms — dependency audit, secret scan and SAST — plus an
optional SBOM. The free defaults, their official sources and the per-manager install
commands are in `references/security-tools.md`; the machine-readable floors are
`assets/security/toolchain.json`.

Detect first. The check never installs and never reaches the network:

```bash
node <skill-dir>/scripts/security-tools.mjs --check --json --project <dir>
```

It reports each tool as `ok`, `update-available`, `outdated`, `missing`, `unknown` or `ci`
(CodeQL on a public GitHub repository runs in CI, not on this machine). When anything is
not `ok`, show the commands and ask:

```bash
node <skill-dir>/scripts/security-tools.mjs --print --project <dir>
```

Only after an explicit yes, act on the named tools:

```bash
node <skill-dir>/scripts/security-tools.mjs --install --tool <id> --project <dir>
node <skill-dir>/scripts/security-tools.mjs --upgrade --json --project <dir>
```

`--dry-run` prints what those two would run and executes nothing. The host comes from
`<dir>/.git/config`; `--host` overrides it. A tool this host cannot install prints its
official URL instead. A `.vue` (or Svelte) single-file component has no SAST extractor in
either default: say so, and let the reviewer's manual checklist cover it.

## 7. Verify and finish

1. Re-run `<skill-dir>/scripts/detect.mjs --json`; report roles present and the selected agents.
2. Run `<skill-dir>/scripts/install-roles.mjs --validate <roles-root>`; it must be `ok`.
3. Re-run `<skill-dir>/scripts/security-tools.mjs --check --json --project <dir>`; report
   what is missing, behind its floor, and what the project's CI provides.
4. Print the next command to load/restart the supervisor
   (`install.sh --supervisor=enable` for the actor kind), and note that a running pool
   picks up role edits on its next dispatch.
5. Re-read the host's instruction file: the task entry is stated once, names `/meerkat`, and
   carries the card scope.
6. Summarize: what was installed, where, the effective roles root, the human name, the
   instruction file that received the task entry, and what was skipped and why.
7. A second run must change **no managed content**: role files, native definitions and
   env keys report `unchanged`, and the task entry reports `unchanged` rather than being
   restated or duplicated; `install.sh` may re-copy identical runtime bytes, which
   is still idempotent. Report every action as `written` / `unchanged` / `skip` /
   `conflict`.

## Identity and decision rights (what the team inherits)

The card identity rules — the agent signature, the reporter and the assignee kind — are the
`meerkat` board skill's contract; the creator, assignee and report/comment author are the
role, not a human. A human decision or constraint is recorded only with `--as-human`, which
signs the fixed `TASKCTL_HUMAN`; never use it for a role's own view.

The ladder is **subagent → main session → human**. A subagent asks with an agent `question`
comment and stops; the project session decides what it can, or escalates E1-E5. Any human
comment resumes an awaiting card, whatever its kind; the resumed worker judges from its
content whether it is a complete decision. The reviewer never enters awaiting; insufficient
evidence is a `VERDICT: REJECT`.

## Files

```text
skills/setup-meerkat/
├── SKILL.md
├── references/{detection,install,matt-pocock,roles,evals,security-tools}.md
├── evals/evals.json
├── scripts/{detect,install-roles,configure-env,security-tools}.mjs
├── scripts/lib/{agent-kinds,atomic,env-merge,validate,entry-guard}.mjs
├── assets/security/toolchain.json
└── assets/team/standard/{manifest.json,ownership.md,jobs/,linus/,turing/,reviewer/,agents/}
```

The scripts are standalone: Node builtins and their own `lib/` only. They must never
import `src/core`, `src/cli` or `src/server` — the installed skill has no checkout.
