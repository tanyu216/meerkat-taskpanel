# `projects.json` — the local project ↔ board project map

> **What this covers.** Where a project's **local target directory** is configured,
> and how a local project is tied to a **board project identity**. The file lives
> **beside this skill** (`projects.json`, next to `SKILL.md`) and is the **only**
> place that answers "which directory is this project working in".

## What the file is (and is not)

`projects.json` is a **local, machine/agent-side** map. It is read by the agent on
this machine and **never written into the board** — it is not board state, it is
not sent to `taskd`, it is not imported, and no board table or API carries it. The
board knows nothing about directories.

Two consequences worth stating plainly:

- **Losing the file loses only the map.** Board tasks, comments, reports and the
  dependency tree are untouched; you re-create the file and the mapping is back.
- **It is not part of the skill's source.** The skill ships `SKILL.md`,
  `references/` and `scripts/`; `projects.json` is created locally, on this
  machine, *after* install. Nothing in this repository contains one.

Do not confuse it with the **team registry** at
`~/.openclaw/team/projects.json`. That one is a dispatcher's project registry, a
different file at a different layer (see
[migration.md](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/migration.md)).
This document is only about the copy **beside the installed skill**.

## Schema

A single JSON object with a `projects` array. Each entry needs at least the two
keys below.

| Key | Type | Meaning |
|---|---|---|
| `local_path` | string | **Required, and checked.** The project's target directory: an **absolute** path that exists and is a directory (see [what is checked](#how-a-project-resolves-to-a-directory--and-what-is-checked)). |
| `project` | string | **Required.** The **board project identity** — its **id** (preferred; the id is what `issue create --project <id>` takes) or its name. |

Extra keys are **yours** — the skill reads the two above and ignores the rest, so
you can keep notes in the same entry.

### Minimal example

```json
{
  "projects": [
    { "local_path": "/Users/you/code/meerkat-taskpanel", "project": "TaskPanel" },
    { "local_path": "/Users/you/code/reporting", "project": "reporting" }
  ]
}
```

Two entries, two projects: the first maps a checkout to the board project whose id
is `TaskPanel`; the second maps another checkout to the project whose id is
`reporting`.

## How a directory resolves to a project

When you need to know **which board project a directory you are in belongs to**,
look the directory up here — and nowhere else:

1. Take the directory (an absolute path).
2. Find the entry whose `local_path` is that directory **or an ancestor of it**.
3. If several match, the **longest** `local_path` wins (the most specific entry).
4. No entry matches ⇒ the directory is **unregistered** (see below).

This is a convention of this file, not a board rule: the board is not consulted,
because the board holds no directory information to consult.

## How a project resolves to a directory — and what is checked

The other direction is what a **wake** needs: a card names a board project, and the
worker for that card must run in that project's directory. The lookup runs the same
way in reverse, and its result is **validated before it is used**:

| Check | Fails when | Reported as |
|---|---|---|
| present | the entry has no `local_path` | `PROJECT_DIR_REQUIRED` |
| absolute | `local_path` is a relative path | `PROJECT_DIR_NOT_ABSOLUTE` |
| exists | nothing is at that path (a moved or deleted checkout) | `PROJECT_DIR_MISSING` |
| is a directory | something is there, but it is a file | `PROJECT_DIR_NOT_A_DIRECTORY` |

All four are failures, not warnings. **A worker is never started in an unvalidated
directory**: running a session in the wrong checkout looks like work and is worse
than doing nothing, because the writes land in a repository nobody asked about.

Two command surfaces apply this rule, and they read the same file:

- **`taskctl project dir <project>`** — prints the directory, or exits non-zero
  with the question below. The local map path is `$MEERKAT_TASKPANEL_PROJECTS_JSON`
  when a session sets it (an installed `taskctl` shim points it at the skill's own
  copy), else the `projects.json` beside this skill.
- **The wake glue** (`wake-<host>.sh`, the script the supervisor starts a worker
  through) — resolves the card's project identity the same way and `cd`s into the
  directory before starting the host CLI. It is handed the identity in
  `TP_PROJECT` (and the map in `TP_PROJECTS_JSON`); if the directory cannot be
  resolved it **refuses the wake and exits 3**, printing the same reason. There is
  no fallback directory, on purpose.

## Unregistered projects: no directory, no fallback — ask

**Directory ownership is decided entirely by this file, and there is no fallback.**
The board provides no directory information — there is no `workspace_path` on a
project, no `context current` command, and no registry `root` anchor. So:

- A project **absent from `projects.json` has no target directory.** That is a
  complete answer, not a missing one.
- The agent must **not invent, guess, or derive** a directory for it, and must not
  look for one on the board. When a step needs the project's directory, it **stops
  and asks the user** — it does not continue silently. Say (substituting the real
  project, and what is wrong when an entry exists but is unusable):

  ```text
  No local directory is registered for project <project>.
  Which directory does it work in? I will add it to projects.json beside this skill
  (references/projects-json.md) — the board cannot supply one.
  ```

  If it is the *directory* that is unknown rather than the project — you are in a
  checkout nothing maps — the same question applies with the path you are in.
- Work that does **not** need a directory is unaffected: claiming, moving,
  commenting and delivering a card carry no directory, so they proceed as usual. A
  missing mapping means "no directory known", never "cannot work".

## Configuring a project: add an entry

1. Open `projects.json` beside this skill (create it if it does not exist — an
   empty `{ "projects": [] }` is a valid starting point).
2. Add one entry per project: the absolute `local_path` and the board `project`.
3. Keep the paths absolute and machine-local; never write a path the board would
   have to interpret.
4. If the same checkout serves one board project, one entry is enough; a directory
   nested under a registered parent resolves to that parent (rule 3 above).

## Installing, re-installing and `--force`

`projects.json` sits **inside** the installed skill directory, so its fate is the
skill directory's fate
([install.md](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/install.md)):

- **A plain re-run leaves it alone.** `install.sh` treats an existing skill
  directory as the desired end state (merge, never clobber) and re-running is a
  no-op, so your map survives. This is the "does not overwrite an existing file"
  behaviour.
- **`--force` replaces the whole skill directory.** `--force` deletes and re-copies
  the skill, so a `projects.json` inside it is removed with it — back it up before a
  forced re-install, or re-create it afterwards.
- **`--link` points the skill directory at a checkout.** With a symlinked install
  the skill directory *is* the repository's `skills/meerkat-taskpanel/`, so your
  `projects.json` lands there; keep it out of version control.

## Two things the board deliberately does not do

These are the boundaries this file exists to respect:

1. **TaskPanel does no project-directory management.** The board does not store,
   validate, match or resolve a project's directory — not in a column, not in a
   route, not in a command. A project on the board simply has no directory.
   Directories are a *local* concern, and this file is where they live.
2. **Whether you manage a project's source data with `meta` is your call.**
   TaskPanel does not prescribe it and does not advise it — and neither does this
   skill. `meta` is free-form; use it, or don't, by your own convention. This
   document takes no position, on purpose.
