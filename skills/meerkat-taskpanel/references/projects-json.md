# `projects.json` — the local project map

> **Scope.** Where a project's **worker directory** comes from, how a local directory is tied
> to a **board project identity**, and what else an entry may carry for the agent. The file
> lives **beside this skill** (`projects.json`, next to `SKILL.md`) and is the **only** place
> that answers "which directory does work for this project happen in".

## What the file is (and is not)

`projects.json` is a **local, machine/agent-side** map. The agent on this machine reads it;
it is **never written into the board** — not board state, not sent to `taskd`, not imported,
and no board table or API carries it. The board knows nothing about directories.

The directory it names is a **worker's** directory: where a session for that project starts,
so its writes land where they are meant to. It is **not a data location** — taskpanel
neither stores, reads nor cares where a project keeps its results, whether those results are
files at all, or whether anything is kept. See
[the boundaries](#three-things-the-board-deliberately-does-not-do).

Two consequences:

- **Losing the file loses only the map.** Board tasks, comments, reports and the dependency
  tree are untouched; re-create the file and the mapping is back.
- **It is not part of the skill's source.** The skill ships `SKILL.md`, `references/` and
  `scripts/`; `projects.json` is created locally, after install. Nothing in this repository
  contains one.

Do not confuse it with the **team registry** at `~/.openclaw/team/projects.json` — a
dispatcher's project registry, a different file at a different layer (see
[migration.md](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/migration.md)).
This document is only about the copy **beside the installed skill**.

## Schema

A single JSON object with a `projects` array. Each entry is keyed by `project` and may name a
directory in one of two ways — or name none at all.

| Key | Type | Meaning |
|---|---|---|
| `project` | string | **Required.** The **board project identity** — its **id** (preferred; what `issue create --project <id>` takes) or its name. |
| `local_path` | string | **Optional.** The project's **own** directory: an **absolute** path that exists and is a directory (see [what is checked](#how-a-project-resolves-to-a-directory--and-what-is-checked)). |
| `run_dir` | string | **Optional.** The **launch directory** a worker for this project starts in. Checked the same way; consulted only when there is no usable `local_path`. |
| *anything else* | *any* | **Yours.** The skill reads the three keys above and ignores the rest — see [metadata](#metadata-the-rest-of-the-entry). |

One rule:

```text
dir = local_path ?? run_dir
```

`local_path` is the project's own directory; `run_dir` is the fallback for a project that has
none. A missing key and an explicit `null` both mean "not given", but a key that *is* given
and is empty or blank is a **failure**, not a reason to fall through — a value someone wrote
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

Four entries, four projects: two map a checkout to their board project; `Ops` has no directory
of its own and tells its workers to start in an inbox; `Community` names no directory at all —
a project whose work needs no local directory (see
[below](#a-project-with-no-local-directory-is-a-complete-answer)).

## How a directory resolves to a project

To learn **which board project a directory belongs to**, look it up here — and nowhere else:

1. Take the directory (an absolute path).
2. Find the entry whose `local_path` is that directory **or an ancestor of it**.
3. If several match, the **longest** `local_path` wins (the most specific entry).
4. No entry matches ⇒ the directory is **unregistered** (see below).

`run_dir` is deliberately **not** part of this direction. A launch directory can be generic —
an inbox, a home directory, a shared workspace — and standing in one says nothing about which
project you work for; claiming a whole directory tree for it would be wrong. Project identity
in such a session comes from the session itself (the card, the agent), not the directory.

This is a convention of this file, not a board rule: the board holds no directory information
to consult.

## How a project resolves to a directory — and what is checked

The other direction is what a **wake** needs: a card names a board project, and its worker
must run somewhere. The lookup runs the rule above, and whichever key answers is **validated
before use**:

| Check | Fails when | Reported as |
|---|---|---|
| usable | the key is given but is empty, blank or not a string | `PROJECT_DIR_REQUIRED` |
| absolute | the path is relative | `PROJECT_DIR_NOT_ABSOLUTE` |
| exists | nothing is at that path (a moved or deleted checkout) | `PROJECT_DIR_MISSING` |
| is a directory | something is there, but it is a file | `PROJECT_DIR_NOT_A_DIRECTORY` |

All four are failures, not warnings. **A worker is never started in an unvalidated
directory**: running a session in the wrong checkout looks like work and is worse than doing
nothing, because the writes land in a repository nobody asked about.

So a lookup ends in one of three answers:

| Answer | When | What it means |
|---|---|---|
| a directory | the entry names one and it checks out | run there |
| `dir: null` | the entry exists and names **no** directory | this project has no local directory — a complete answer |
| `PROJECT_DIR_UNMAPPED` | there is **no entry** for the project | no directory is registered — stop and ask |

Two command surfaces apply this, reading the same file:

- **`taskctl project dir <project>`** — prints the directory, or prints that the entry names
  none (still a success), or exits non-zero with the question below. The map path is
  `$MEERKAT_TASKPANEL_PROJECTS_JSON` when a session sets it (an installed `taskctl` shim
  points it at the skill's own copy), else the `projects.json` beside the skill.
- **The wake glue** (`wake-<host>.sh`, started by the supervisor) — resolves the card's
  project identity the same way and `cd`s into the directory before starting the host CLI.
  It is handed the identity in `TP_PROJECT` (map in `TP_PROJECTS_JSON`). A worker needs a
  directory, so **both** of the last two answers refuse the wake: the glue exits 3 and prints
  why. There is no fallback directory, on purpose.

## A project with no local directory is a complete answer

A project whose work needs no checkout — operations, coordination, research, a project whose
results live in the board and nowhere else — is registered by an entry naming **no
directory**:

```json
{ "project": "Community" }
```

That is an answer, not a gap: `taskctl project dir Community` succeeds and says so. Do **not**
point such a project at a directory "so the command works" — a directory that is not the
project's is exactly what the validation above exists to prevent.

If a worker must start somewhere for such a project, give the entry a `run_dir`. Without one,
a wake for that project is refused — the project is worked by hand, or the map gains a
`run_dir`.

## Unregistered projects: no fallback — ask

**Directory ownership is decided entirely by this file, and there is no fallback.** The board
provides no directory information — no `workspace_path` on a project, no `context current`
command, no registry `root` anchor. So:

- A project **absent from `projects.json` has no registered directory.** The agent must
  **not invent, guess, or derive** one, and must not look for one on the board. When a step
  needs the directory, it **stops and asks the user**. Say (substituting the real project and,
  when an entry exists but is unusable, what is wrong):

  ```text
  No local directory is registered for project <project>.
  Which directory does it work in? I will add it to projects.json beside this skill
  (references/projects-json.md) — the board cannot supply one.
  ```

  If the project needs no directory at all, that is the other answer: register an entry with
  no `local_path`/`run_dir` (see above) and the question is settled. If the *directory* is
  unknown rather than the project — you are in a checkout nothing maps — the same question
  applies with the path you are in.
- Work that does **not** need a directory is unaffected: claiming, moving, commenting and
  delivering carry no directory, so they proceed as usual. A missing mapping means "no
  directory known", never "cannot work".

## Metadata: the rest of the entry

Anything beyond `project`, `local_path` and `run_dir` is **yours**. The skill reads those
three and ignores the rest, so an entry is also a fine place to keep what an agent should
know about the project:

```json
{
  "project": "TaskPanel",
  "local_path": "/Users/you/code/meerkat-taskpanel",
  "kind": "code",
  "notes": "public repo, MIT; commits use explicit paths",
  "guides": ["README.md", "CONTRIBUTING.md"]
}
```

**The key set is not defined here, and will not be.** TaskPanel does not prescribe, validate
or interpret it: what an agent needs to know is a question about *your* work, not the board,
and the answer changes per project and team. Read these keys from the file itself — no
command surfaces them, and nothing in the board or the skill depends on any of them.

Two things follow: the keys are never validated (a typo'd key is simply not read), and never
sent anywhere — the file stays on this machine, like the rest of it.

## Configuring a project: add an entry

1. Open `projects.json` beside this skill (create it if it does not exist — an empty
   `{ "projects": [] }` is a valid starting point).
2. Add one entry per project: the board `project`, plus the directory if the project has one —
   `local_path` for its own, `run_dir` for where its workers start when it has none.
3. Keep the paths absolute and machine-local; never write a path the board would have to
   interpret.
4. If one checkout serves one board project, one entry is enough; a directory nested under a
   registered parent resolves to that parent (rule 3 above).

## Installing, re-installing and `--force`

`projects.json` sits **inside** the installed skill directory, so its fate is the skill
directory's fate
([install.md](https://github.com/tanyu216/meerkat-taskpanel/blob/main/docs/install.md)):

- **A plain re-run leaves it alone.** `install.sh` treats an existing skill directory as the
  desired end state (merge, never clobber) and re-running is a no-op, so your map survives.
- **`--force` replaces the whole skill directory** — a `projects.json` inside it is removed
  with it. Back it up before a forced re-install, or re-create it afterwards.
- **`--link` points the skill directory at a checkout.** With a symlinked install the skill
  directory *is* the repository's `skills/meerkat-taskpanel/`, so your `projects.json` lands
  there; keep it out of version control.

## Three things the board deliberately does not do

These are the boundaries this file exists to respect:

1. **TaskPanel does no project-directory management.** The board does not store, validate,
   match or resolve a project's directory — not in a column, not in a route, not in a
   command. A project on the board simply has no directory. Directories are a *local*
   concern, and this file is where they live.
2. **TaskPanel does not manage project data.** Where a project's results live — a repository,
   a vault, a drive, nowhere — is the business's decision, not the board's. TaskPanel is a
   task-collaboration board: it keeps task data complete, reliable, traceable and auditable,
   and takes no position on what a task produces or where it is kept. The directory above is
   where a *worker* runs, not where anything is stored.
3. **Whether you manage a project's source data with `meta` is your call.** TaskPanel does
   not prescribe it and does not advise it — and neither does this skill. `meta` is
   free-form; use it, or don't, by your own convention. This document takes no position, on
   purpose.
