# `projects.json` — the local project map

`projects.json` is the **only** place that answers "which directory does work for this
project happen in". There is **one file per installation**, at the machine-local config
root: `<config root>/projects.json`, where the config root is
`MEERKAT_TASKPANEL_CONFIG_DIR` (resolved against the current directory) or else the
program root — the checkout, `/app` in the image, or `~/.meerkat-taskpanel` for an
installed tree. It sits beside the per-kind configs (`.env.<kind>`) and, like them, is
never sent to the board.

It is **maintained only through `taskctl project map`**. Read it through
`taskctl project dir` / `project map`; never parse or hand-edit the file — the CLI is what
validates a directory and what keeps the file's shape stable. The schema below is for
operators reading or repairing a map, not for an agent to implement.

The directory is a **worker's** start directory, not a data location. Where a project keeps
its results is the project's own business. The exception is the loop's own process data: the
supervisor exports each dispatched card to `.meerkat/<identifier>/` under this directory
(and the subagent keeps its notes, evidence and downloaded attachments there). That is loop
state, not a project-results store; a project should ignore `.meerkat/` in version control.

## Managed by `taskctl`

| Command | What it does |
|---|---|
| `project map list` | Print the map (the file path, whether it exists, and its entries). A missing file is an empty map, exit 0. |
| `project map show <id>` | Print one entry and the directory it resolves to. A project with **no entry** is `PROJECT_DIR_UNMAPPED`. |
| `project map set <id> --local-path <dir>` | Register the project's own directory. The path must be absolute, exist and be a directory. |
| `project map set <id> --run-dir <dir>` | Register a launch directory for a project with no checkout of its own. |
| `project map set <id> --no-dir` | Register that the project has **no** local directory (clears both keys). |
| `project map remove <id>` | Remove every entry for the project. |

`set` takes exactly one of the three modes. `--local-path` and `--run-dir` are mutually
exclusive by construction (`dir = local_path ?? run_dir`), so setting one removes the other;
`--no-dir` removes both. Everything else on an entry — including keys taskpanel does not
interpret — survives a write. A hand-written map may carry the same `project` twice: `set`
updates the first entry, `remove` removes every one of them (the CLI never silently rewrites
an entry it was not asked about).

These commands are **local**: no identity, no token, no board session. They never send a
path anywhere.

## Schema

A single JSON object with a `projects` array:

| Key | Type | Meaning |
|---|---|---|
| `project` | string | **Required.** The board project identity — its **id** (preferred) or its name. |
| `local_path` | string | **Optional.** The project's own directory: absolute, existing, a directory. |
| `run_dir` | string | **Optional.** The launch directory a worker starts in. Checked the same way; consulted only when `local_path` is not given. |
| `base_ref` | string | **Optional, loop-only.** The ref a card's worktree branches from. Default: the project directory's current branch. The board never reads it. |
| `merge_ref` | string | **Optional, loop-only.** The branch acceptance must merge into. It must be the branch the project directory has checked out, or landing is refused. Default: whatever is checked out. |
| *anything else* | *any* | Copied through unchanged and never interpreted; read it with `project map show`. |

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

## Project → directory: what is checked

| Failure | Meaning |
|---|---|
| `PROJECT_MAP_UNREADABLE` | The file exists but is not `{ "projects": [...] }`, or cannot be read. It is never overwritten from an empty start. |
| `PROJECT_MAP_UNWRITABLE` | `project map set` / `remove` could not write the file (a read-only config root, permissions). Point `MEERKAT_TASKPANEL_CONFIG_DIR` at a writable directory. |
| `PROJECT_DIR_UNMAPPED` | No entry is registered for the project — stop and ask the user. |
| `PROJECT_DIR_REQUIRED` | The key is present but blank / not a string. |
| `PROJECT_DIR_NOT_ABSOLUTE` | A relative path. |
| `PROJECT_DIR_MISSING` | The path does not exist. |
| `PROJECT_DIR_NOT_A_DIRECTORY` | The path is a file or something else. |

Three answers come out of a lookup, and they stay distinguishable:

| Answer | When | Meaning |
|---|---|---|
| a directory | the entry names one and it checks out | run there |
| `dir: null` | the entry exists and names **no** directory | a complete answer |
| `PROJECT_DIR_UNMAPPED` | there is no entry for the project | stop and ask |

The same resolution applies to `taskctl project dir <project>` and to the wake glue, which
`cd`s into the directory before starting an agent. A worker needs a directory, so a wake
refuses both `dir: null` and an unmapped project.

## No directory is an answer

A project whose work needs no checkout — operations, coordination, research — is registered
with `--no-dir` (an entry naming no directory):

```text
taskctl project map set Community --no-dir
```

`taskctl project dir Community` succeeds and says so. Do not point such a project at a
directory "so the command works". If a worker must start somewhere, give the entry a
`--run-dir`; without one, a wake for that project is refused.

## Unregistered: no fallback — ask

A project absent from the file has no registered directory (`PROJECT_DIR_UNMAPPED`), and the
board cannot supply one — no `workspace_path`, no `context` command, no registry anchor. Do
not invent, guess or derive one: stop and ask. `SKILL.md` carries the prompt to use; the same
applies to a registered-but-unusable path, naming what is wrong.

There is deliberately **no reverse lookup**: a directory does not resolve to a project.
`run_dir` can be a generic place (an inbox, `$HOME`), so claiming every directory under it
would be wrong; when you need to know which project a directory belongs to, ask.

## Extra keys are pass-through, not a second store

This map answers one question: which directory does work for this project happen in. The
project's own metadata lives on its board row — `name`, `labels`, `readme`, `reviewer`,
`acceptance` and free-form `meta` (`taskctl project update <id> --meta k=v`).

An entry may still carry other keys: `project map set` copies them through unchanged, and
`project map show` / `project map list` return them. taskpanel never validates or interprets
them. Read them through the CLI; never parse the file.

## A retired override is refused

`MEERKAT_TASKPANEL_PROJECTS_JSON` / `--projects-json` are retired. A leftover key makes the
loader refuse the file (`CONFIG_FILE_INVALID`) rather than ignore it — a silently ignored
override would be worse. `install.sh` migrates an old skill-beside map into the config-root
map and removes it; a map it cannot interpret is left in place with a warning.
