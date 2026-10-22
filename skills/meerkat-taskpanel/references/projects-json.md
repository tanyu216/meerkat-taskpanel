# `projects.json` — the local project map

`projects.json`, kept **beside this skill** (next to `SKILL.md`), is the **only** place that
answers "which directory does work for this project happen in". It is local and agent-side:
never written into the board, never sent to `taskd`. Losing it loses only the map — board
tasks, comments and reports are untouched.

The directory is a **worker's** start directory, not a data location. Where a project keeps
its results is the project's own business. The exception is the loop's own process data: the
supervisor exports each dispatched card to `.meerkat/<identifier>/` under this directory
(and the subagent keeps its notes, evidence and downloaded attachments there). That is loop
state, not a project-results store; a project should ignore `.meerkat/` in version control.

## Schema

A single JSON object with a `projects` array:

| Key | Type | Meaning |
|---|---|---|
| `project` | string | **Required.** The board project identity — its **id** (preferred) or its name. |
| `local_path` | string | **Optional.** The project's own directory: absolute, existing, a directory. |
| `run_dir` | string | **Optional.** The launch directory a worker starts in. Checked the same way; consulted only when `local_path` is not given. |
| *anything else* | *any* | **Yours.** The skill reads the three keys above and ignores the rest. |

```text
dir = local_path ?? run_dir
```

A missing key and an explicit `null` both mean "not given". A key that **is** given but is
empty, blank or not a string is a **failure**, not a reason to fall through.

```json
{
  "projects": [
    { "project": "TaskPanel", "local_path": "/Users/you/code/meerkat-taskpanel" },
    { "project": "reporting", "local_path": "/Users/you/code/reporting" },
    { "project": "Ops", "run_dir": "/Users/you/ops-inbox" },
    { "project": "Community" }
  ]
}
```

## Directory → project

Take the directory (absolute); find the entry whose `local_path` is that directory **or an
ancestor of it**; the **longest** match wins; no match means the directory is unregistered.

`run_dir` deliberately takes no part in this direction: an inbox, a home directory or a shared
workspace says nothing about which project you work for. Project identity in such a session
comes from the session itself (the card, the agent).

## Project → directory: what is checked

| Check | Fails when | Code |
|---|---|---|
| usable | the key is given but empty, blank or not a string | `PROJECT_DIR_REQUIRED` |
| absolute | the path is relative | `PROJECT_DIR_NOT_ABSOLUTE` |
| exists | nothing is at that path | `PROJECT_DIR_MISSING` |
| is a directory | something is there, but it is a file | `PROJECT_DIR_NOT_A_DIRECTORY` |

All four are failures, not warnings: a worker is never started in an unvalidated directory.

A lookup ends in one of three answers:

| Answer | When | Meaning |
|---|---|---|
| a directory | the entry names one and it checks out | run there |
| `dir: null` | the entry exists and names **no** directory | a complete answer |
| `PROJECT_DIR_UNMAPPED` | there is no entry for the project | stop and ask |

Two surfaces apply the same file: `taskctl project dir <project>` (the map path is
`$MEERKAT_TASKPANEL_PROJECTS_JSON` — which may also be set in the install-root `.env`, the
process environment winning — else the copy beside the skill), and the wake glue, which
`cd`s into the directory before starting an agent. A worker needs a directory, so a wake refuses
both `dir: null` and an unmapped project.

## No directory is an answer

A project whose work needs no checkout — operations, coordination, research — is registered
with an entry naming **no** directory:

```json
{ "project": "Community" }
```

`taskctl project dir Community` succeeds and says so. Do not point such a project at a
directory "so the command works". If a worker must start somewhere, give the entry a
`run_dir`; without one, a wake for that project is refused.

## Unregistered: no fallback — ask

A project absent from the file has no registered directory, and the board cannot supply one —
no `workspace_path`, no `context` command, no registry anchor. Do not invent, guess or derive
one. When a step needs the directory, stop and ask:

```text
No local directory is registered for project <project>.
Which directory does it work in? I will add it to projects.json beside this skill
(references/projects-json.md) — the board cannot supply one.
```

The same prompt applies to a registered-but-unusable path, naming what is wrong. Work that
needs no directory — claiming, moving, commenting, delivering — is unaffected.

## Metadata: the rest of the entry

Anything beyond `project`, `local_path` and `run_dir` is **yours**; the skill reads the three
and ignores the rest. Use it for what an agent should know about the project:

```json
{
  "project": "TaskPanel",
  "local_path": "/Users/you/code/meerkat-taskpanel",
  "kind": "code",
  "notes": "public repo, MIT; commits use explicit paths"
}
```

The key set is not defined here and will not be: taskpanel neither prescribes nor interprets
it, and nothing in the board or the skill depends on any of it.

## Installing, re-installing and `--force`

`projects.json` sits inside the installed skill directory:

- **A plain re-run leaves it alone** — `install.sh` merges, never clobbers.
- **`--force` replaces the whole directory**, so back the file up first.
- **`--link` points the skill at a checkout**; the map then lands in that checkout — keep it
  out of version control.

## Three boundaries

1. **No project-directory management.** The board does not store, validate, match or resolve a
   project's directory — not in a column, not in a route, not in a command.
2. **No project-data management.** Where results live is the business's decision; the board
   keeps task data complete, reliable, traceable and auditable.
3. **`meta` is optional.** Whether you manage a project's source data with it is your own
   convention; this skill takes no position.
