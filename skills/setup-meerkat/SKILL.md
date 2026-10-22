---
name: setup-meerkat
description: Idempotently install and configure Meerkat TaskPanel for this machine — detect the server, taskctl, board/loop skills and supervisor, install what is missing, offer the Matt Pocock issue-tracker integration, and install a Jobs/Linus/Turing plus reviewer team whose role workflows the loop loads. Use when the user runs /setup-meerkat or asks to set up, repair, or add a team to Meerkat TaskPanel.
disable-model-invocation: true
---

# setup-meerkat

One idempotent pass over the things a working Meerkat TaskPanel deployment needs:

1. **Install/repair** the server, `taskctl`, the board skill, the loop skill and the
   supervisor.
2. **Point the CLI at the right board** — local `taskd` or a remote one — and confirm the
   choice before anything starts.
3. **Offer the Matt Pocock integration** (`/setup-matt-pocock-skills`) when that skill is
   present, without overwriting an unrelated tracker.
4. **Install a team** — the standard Jobs/Linus/Turing + reviewer roles, or a custom team —
   into the loop, globally or per project.
5. **Write the fixed human name** so `--as-human` signs the person, never a role.

This skill is **command-only** (`disable-model-invocation: true`). It installs software
and writes files, so it never runs unless the user asks for it.

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
node scripts/detect.mjs --json --project <dir> --actor-kind <kind>
```

Report the important rows, not the raw JSON:

- `taskctl` path/version; `server.url`, its source (`flag`/`env`/`env-file`/`pointer`/
  `default`), `loopback` vs `remote`, and `/health`;
- board/loop/setup skills per actor kind; loop body; supervisor units and live pool;
- effective roles root (explicit/project/global) and role count;
- the fixed human name and its source (`env`/`settings`/`config`/`shim`/`env-file`/
  `fallback`);
- the Matt skill and any existing tracker file.

If the JSON is malformed, stop and report; never guess a path.

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
node scripts/configure-env.mjs --file <env-file> --key TASKD_URL --value <url> --json
```

Then show the plan with the installer's own dry run, and only then run it:

```bash
bash install.sh --target claude,server --agent-name <name> --dry-run
# local board: the same without --dry-run
# remote board: bash install.sh --target claude --no-automation
```

- **Local + reachable**: skip the server install; do not restart what is healthy.
- **Local + unreachable**: propose `--target claude,server`; the taskd guard loads a
  keepalive, so ask separately before enabling it.
- **Remote + reachable**: `--target claude --no-automation` (no local server, no guard),
  then confirm the remote URL in the env file. Never fall back to localhost.
- **Remote + unreachable**: report the failure and ask for a corrected URL; stop.
- **No URL/pointer**: report `source: "default"` and confirm
  `http://localhost:9527` before installing.

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
`## Agent skills` block in the existing `CLAUDE.md`/`AGENTS.md`). Never create board
labels: the registry is read-only and grows when a card names a label.

## 4. Team

Ask: **standard** / **custom** / **skip**.

The standard template is `assets/team/standard/`:

| Role | Board agent | Native agent | Scope |
|---|---|---|---|
| Jobs | `Jobs` | `jobs` | product planning, visual/interaction design, prototypes |
| Linus | `Linus` | `linus` | architecture, implementation, bugs, ops, code review, dead code |
| Turing | `Turing` | `turing` | unit/integration acceptance, real scenarios, UI/boundary, security |
| Reviewer | `Reviewer` | `reviewer` | independent fourth role; verdict only |

The template also ships `decision-policy.md` and the native agent templates.

For a custom team, start from the standard template in a temporary staging directory,
change role names/responsibilities/workflows with the user, show the manifest and each
role's summary, then install with `--source <staging>`.

### Scope and precedence

- **global** (default): `<home>/<agent-dir>/skills/meerkat-loop/roles/`; requires the loop
  skill to be installed.
- **project**: `<project>/.meerkat/roles/`; wins as a whole manifest over global.

Install:

```bash
node scripts/install-roles.mjs --scope global|project --project <dir> \
  --actor-kind <kind> --source <dir> --dry-run --json
# then without --dry-run, after showing the file list
```

Files are written atomically, the manifest last; an existing different file is a
**conflict** and needs `--force` (ask first). No file is deleted.

After installation, offer to merge (with consent) into
`<home>/<agent-dir>/meerkat-taskpanel.env`:

```text
MEERKAT_TASKPANEL_AGENTS=Jobs,Linus,Turing
MEERKAT_TASKPANEL_REVIEWER=Reviewer
```

Use `configure-env.mjs`; a different existing value is a conflict, not an overwrite.
Without `MEERKAT_TASKPANEL_AGENTS` the loop scans only its default agent and a role card
is never claimed.

Native agent definitions are written for Claude (`.claude/agents/<name>.md`) and Codex
(`.codex/agents/<name>.toml`), globally or in the project. Other actor kinds are skipped
with a warning; their layer-2 workflow still reaches them through the handoff.

## 5. Verify and finish

1. Re-run `detect.mjs --json`; report roles present and the selected agents.
2. Run `install-roles.mjs --validate <roles-root>`; it must be `ok`.
3. Print the next command to load/restart the supervisor
   (`install.sh --supervisor=enable` for the actor kind), and note that a running pool
   picks up role edits on its next dispatch.
4. Summarize: what was installed, where, the effective roles root, the human name, and
   what was skipped and why.
5. A second run must perform **no writes**; report every action as
   `written` / `unchanged` / `skip` / `conflict`.

## Identity and decision rights (what the team inherits)

- Every agent write carries `--agent <Role> --actor-kind <kind>`; a named assignee or
  reporter also carries `--assignee-kind agent` / `--reporter-kind agent`. The creator,
  assignee and report/comment author are the role, not a human.
- A human decision or constraint is recorded only with `--as-human`; it signs the fixed
  `TASKCTL_HUMAN`. Never use it for a role's own view.
- The ladder is **subagent → main session → human**. A subagent asks with an agent
  `question` comment and stops; the project session decides what it can, or escalates
  E1-E5. Only a human decision resumes an awaiting card.
- The reviewer never enters awaiting; insufficient evidence is a `VERDICT: REJECT`.

## Files

```text
skills/setup-meerkat/
├── SKILL.md
├── references/{detection,install,matt-pocock,roles,evals}.md
├── scripts/{detect,install-roles,configure-env}.mjs
├── scripts/lib/{agent-kinds,atomic,env-merge,validate,entry-guard}.mjs
└── assets/team/standard/{manifest.json,decision-policy.md,jobs/,linus/,turing/,reviewer/,agents/}
```

The scripts are standalone: Node builtins and their own `lib/` only. They must never
import `src/core`, `src/cli` or `src/server` — the installed skill has no checkout.
