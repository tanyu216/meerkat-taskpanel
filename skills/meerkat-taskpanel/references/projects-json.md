# `projects.json` — the local project map

> **What this covers.** Where a project's **worker directory** comes from, how a
> local directory is tied to a **board project identity**, and what else an entry
> may carry for the agent. The file lives **beside this skill** (`projects.json`,
> next to `SKILL.md`) and is the **only** place that answers "which directory
> does work for this project happen in".

## What the file is (and is not)

`projects.json` is a **local, machine/agent-side** map. It is read by the agent on
this machine and **never written into the board** — it is not board state, it is
not sent to `taskd`, it is not imported, and no board table or API carries it. The
board knows nothing about directories.

The directory it names is a **worker's** directory: where a session for that
project starts, so its writes land where they are meant to. It is **not a data
location** — taskpanel neither stores, reads nor cares where a project keeps its
results, whether those results are files at all, or whether anything is kept. See
[the boundaries](#three-things-the-board-deliberately-does-not-do).

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

A single JSON object with a `projects` array. Each entry is keyed by `project` and
may name a directory in one of two ways — or name none at all.

| Key | Type | Meaning |
|---|---|---|
| `project` | string | **Required.** The **board project identity** — its **id** (preferred; the id is what `issue create --project <id>` takes) or its name. |
| `local_path` | string | **Optional.** The project's **own** directory: an **absolute** path that exists and is a directory (see [what is checked](#how-a-project-resolves-to-a-directory--and-what-is-checked)). |
| `run_dir` | string | **Optional.** The **launch directory** a worker for this project starts in. Checked the same way. Only consulted when the entry gives no usable `local_path`. |
| *anything else* | *any* | **Yours.** The skill reads the three keys above and ignores the rest — see [metadata](#metadata-the-rest-of-the-entry). |

One rule, read top to bottom:

```text
dir = local_path ?? run_dir
```

`local_path` is the project's own directory; `run_dir` is the fallback for a
project that has none of its own. A missing key and an explicit `null` mean the
same thing ("not given"), but a key that *is* given and is empty or blank is a
**failure**, not a reason to fall through to the other one — a value someone wrote
and that does not work is a thing to fix, not to route around.

### Examples

```json
{
  "projects": [
    { "local_path": "/Users/you/code/meerkat-taskpanel", "project": "TaskPanel" },
    { "local_path": "/Users/you/code/reporting", "project": "reporting" },
    { "run_dir": "/Users/you/ops-inbox", "project": "Ops" },
    { "project": "Community" }
  ]
}
```

Four entries, four projects: the first two map a checkout to their board project;
`Ops` has no directory of its own and tells its workers to start in an inbox; and
`Community` names no directory at all — a project whose work needs no local
directory (see [below](#a-project-with-no-local-directory-is-a-complete-answer)).

## How a directory resolves to a project

When you need to know **which board project a directory you are in belongs to**,
look the directory up here — and nowhere else:

1. Take the directory (an absolute path).
2. Find the entry whose `local_path` is that directory **or an ancestor of it**.
3. If several match, the **longest** `local_path` wins (the most specific entry).
4. No entry matches ⇒ the directory is **unregistered** (see below).

`run_dir` is deliberately **not** part of this direction. A launch directory can be
a generic place — an inbox, a home directory, a shared workspace — and nothing
about standing in one says which project you are working for; claiming an entire
directory tree for it would be wrong. Project identity in such a session comes
from the session itself (the card, the agent), not from the directory.

This is a convention of this file, not a board rule: the board is not consulted,
because the board holds no directory information to consult.

## How a project resolves to a directory — and what is checked

The other direction is what a **wake** needs: a card names a board project, and the
worker for that card must run somewhere. The lookup runs the rule above, and
whatever key answers is **validated before it is used**:

| Check | Fails when | Reported as |
|---|---|---|
| usable | the key is given but is empty, blank or not a string | `PROJECT_DIR_REQUIRED` |
| absolute | the path is relative | `PROJECT_DIR_NOT_ABSOLUTE` |
| exists | nothing is at that path (a moved or deleted checkout) | `PROJECT_DIR_MISSING` |
| is a directory | something is there, but it is a file | `PROJECT_DIR_NOT_A_DIRECTORY` |

All four are failures, not warnings. **A worker is never started in an unvalidated
directory**: running a session in the wrong checkout looks like work and is worse
than doing nothing, because the writes land in a repository nobody asked about.

So a lookup ends in one of three answers, and they mean different things:

| Answer | When | What it means |
|---|---|---|
| a directory | the entry names one and it checks out | run there |
| `dir: null` | the entry exists and names **no** directory | this project has no local directory — a complete answer |
| `PROJECT_DIR_UNMAPPED` | there is **no entry** for the project | no directory is registered — stop and ask |

Two command surfaces apply this, and they read the same file:

- **`taskctl project dir <project>`** — prints the directory, or prints that the
  entry names none (still a success), or exits non-zero with the question below.
  The local map path is `$MEERKAT_TASKPANEL_PROJECTS_JSON` when a session sets it
  (an installed `taskctl` shim points it at the skill's own copy), else the
  `projects.json` beside this skill.
- **The wake glue** (`wake-<host>.sh`, the script the supervisor starts a worker
  through) — resolves the card's project identity the same way and `cd`s into the
  directory before starting the host CLI. It is handed the identity in
  `TP_PROJECT` (and the map in `TP_PROJECTS_JSON`). A worker needs a directory, so
  **both** of the last two answers refuse the wake: the glue exits 3 and prints
  why. There is no fallback directory, on purpose.

## A project with no local directory is a complete answer

A project whose work needs no checkout — operations, coordination, research, a
project whose results live in the board and nowhere else — is registered by an
entry that names **no directory**:

```json
{ "project": "Community" }
```

That is an answer, not a gap: `taskctl project dir Community` succeeds and says so.
Nothing needs to be invented, and nobody needs to be asked. Do **not** point such a
project at a directory "so the command works" — a directory that is not the
project's is exactly what the validation above exists to prevent.

If a worker does need to start somewhere for such a project, give the entry a
`run_dir` (the launch directory above). Without one, a wake for that project is
refused — the project is worked by hand, or the map gains a `run_dir`.

## Unregistered projects: no fallback — ask

**Directory ownership is decided entirely by this file, and there is no fallback.**
The board provides no directory information — there is no `workspace_path` on a
project, no `context current` command, and no registry `root` anchor. So:

- A project **absent from `projects.json` has no registered directory.** The agent
  must **not invent, guess, or derive** one, and must not look for one on the
  board. When a step needs the project's directory, it **stops and asks the user** —
  it does not continue silently. Say (substituting the real project, and what is
  wrong when an entry exists but is unusable):

  ```text
  No local directory is registered for project <project>.
  Which directory does it work in? I will add it to projects.json beside this skill
  (references/projects-json.md) — the board cannot supply one.
  ```

  If the project needs no directory at all, that is the other answer: register an
  entry with no `local_path`/`run_dir` (see above) and the question is settled.
  If it is the *directory* that is unknown rather than the project — you are in a
  checkout nothing maps — the same question applies with the path you are in.
- Work that does **not** need a directory is unaffected: claiming, moving,
  commenting and delivering a card carry no directory, so they proceed as usual. A
  missing mapping means "no directory known", never "cannot work".

## Metadata: the rest of the entry

Anything beyond `project`, `local_path` and `run_dir` is **yours**. The skill reads
those three and ignores everything else, so an entry is also a fine place to keep
what an agent should know about the project:

```json
{
  "project": "TaskPanel",
  "local_path": "/Users/you/code/meerkat-taskpanel",
  "kind": "code",
  "notes": "public repo, MIT; commits use explicit paths",
  "guides": ["README.md", "CONTRIBUTING.md"]
}
```

**The key set is not defined here, and will not be.** TaskPanel does not
prescribe, validate or interpret it: what an agent needs to know about a project
is a question about *your* work, not about the board, and the answer changes per
project and per team. Read these keys from the file itself — no command surfaces
them, and nothing in the board or the skill depends on any of them.

Two things that follow, so nothing surprises you: the keys are never validated
(a typo'd key is simply not read), and they are never sent anywhere — the file
stays on this machine, like the rest of it.

## Configuring a project: add an entry

1. Open `projects.json` beside this skill (create it if it does not exist — an
   empty `{ "projects": [] }` is a valid starting point).
2. Add one entry per project: the board `project`, plus the directory if the
   project has one — `local_path` for its own, `run_dir` for where its workers
   start when it has none.
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

## Three things the board deliberately does not do

These are the boundaries this file exists to respect:

1. **TaskPanel does no project-directory management.** The board does not store,
   validate, match or resolve a project's directory — not in a column, not in a
   route, not in a command. A project on the board simply has no directory.
   Directories are a *local* concern, and this file is where they live.
2. **TaskPanel does not manage project data.** Where a project's results live —
   a repository, a vault, a drive, nowhere — is the business's decision, not the
   board's. TaskPanel is a task-collaboration board: it keeps task data complete,
   reliable, traceable and auditable, and takes no position on what a task
   produces or where it is kept. The directory above is where a *worker* runs,
   not where anything is stored.
3. **Whether you manage a project's source data with `meta` is your call.**
   TaskPanel does not prescribe it and does not advise it — and neither does this
   skill. `meta` is free-form; use it, or don't, by your own convention. This
   document takes no position, on purpose.
