# `taskctl` CLI reference

> **Status: implemented (M2).** The command surface below is real, and is what
> `taskctl --help` prints. It is aligned with **`task-interface v1`**, grouped by
> the card's own vocabulary.

`taskctl` is an **HTTP client** for `taskd`, the local board service. There is no
second copy of the rules in the CLI: a refusal you see here is the one the service
raised, with the same code, the same details and the same repair command.

```bash
taskctl <group> <command> [options]
```

Global form, and the two flags that always work (they never contact a board):

```bash
taskctl --help
taskctl --version
```

## Starting the board

If no board is running, `taskctl` starts one (`node src/server/main.mjs`, detached,
logging to `<dataDir>/logs/taskd.log`) and waits for its `/health`. Set
`TASKD_NO_AUTOSTART=1` to forbid that — then a missing board is a clear error
rather than a surprise process.

The service writes a **runtime pointer** (its URL, port, data dir and token file —
never the token itself) so any shell in any directory finds the same board.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Print `{"ok":true,"data":…}` on stdout. Failures print `{"ok":false,"error":{code,message,http,details,hint}}` on **stdout** too, so a pipe only needs one stream. |
| `--url <url>` | Board to talk to. Wins over the runtime pointer, and never triggers autostart. |
| `--token <token>` | Access token. Priority: `--token` > `$TASKD_TOKEN` > the pointer's token file > none (loopback needs no token). |
| `--if-version <n>` | Optimistic concurrency: the write is refused with `VERSION_CONFLICT` if the task moved on. |
| `--agent-platform <name>` | Host platform (`claude`, `codex`, …). Makes the actor an `agent`. |
| `--session-id <id>` | Agent session identifier. Also makes the actor an `agent`. |
| `--agent <name>` | Name the actor without claiming to be an agent platform. |
| `-h`, `--help` | Help for the CLI, a group, or one command. |

**Exit codes:** `0` success · `1` runtime failure (including the delivery gate) ·
`2` usage error · `3` `export md --check` found stale cards.

The token never appears in any output — not in `--json`, not in a warning, not in
an error message.

## Commands

### `project`

| Command | Purpose |
|---|---|
| `project create --id <id> --name <n> --workspace-path <abs> [--meta k=v]… [--label <l>]… [--readme <text>]` | Create a project. The id becomes the identifier prefix (`demo` → `DEMO-0001`). |
| `project update <id> [--name] [--workspace-path] [--meta k=v]… [--label]… [--readme]` | Update it. `--meta` **merges**. |
| `project list [--include-archived]` | List projects. |
| `project readme <id>` | Print the readme. |
| `project readme <id> --set <text>` / `--file <path\|->` | Set it. |

### `context`

| Command | Purpose |
|---|---|
| `context current [--path <dir>]` | The project that owns this directory (default: cwd), by longest-prefix match. |

A miss returns a **synthetic** `local` project with `matched: false` and a hint —
it does not create a row. Reads never write.

### `issue`

| Command | Purpose |
|---|---|
| `issue create --project <id> --title <t> [--acceptance <text>]… [--assignee <text>] [--reporter <text>] …` | Create a task. |
| `issue list [--project] [--status <s>]… [--assignee-id] [--limit] [--include-archived]` | List tasks. |
| `issue get <id\|identifier>` | One task, plus `report_waivers[]`. |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]…` | Patch. `--status` is refused here on purpose. |
| `issue move <ref> <status> [--no-report --reason "<why>"]` | Move, subject to the delivery gate. |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--force-create]` | Assign. |
| `issue archive <ref> [--days <n>]` | Archive finished work (done/canceled; 7-day window by default). |
| `issue deliver <ref> --report-file <file\|->` | **Write the report and move to `in_review`, in one transaction.** |

### The delivery gate

A card may not enter `in_review` without a report **for the current delivery
round**. Leaving `in_review` (except to `done`) starts the next round, so last
round's report — or waiver — is history, not evidence.

```console
$ taskctl issue move PROJ-0007 in_review
REPORT_REQUIRED: cannot move PROJ-0007 to in_review: no report for delivery round 1 (rounds on file: none)
try: taskctl issue deliver PROJ-0007 --report-file -
  or: taskctl issue move PROJ-0007 in_review --no-report --reason "<why this is audited>"
$ echo $?
1
```

The **compliant path is the short one**: `issue deliver` writes the report and
performs the move atomically, and `report template` prints a report that `deliver`
accepts without editing.

The second line is the **audited waiver** (F-B1). It is not a bypass: the reason
must be at least 8 characters, the waiver is stamped on the task row, and a
`report_waived` activity is recorded — `issue get` shows it in `report_waivers[]`.

### `comment`

| Command | Purpose |
|---|---|
| `comment list <ref> [--kind <kind>] [--limit <n>]` | Oldest first. |
| `comment add <ref> --body <text> [--kind discuss\|decision\|confirm\|change\|note\|defect] [--file <path\|->]` | Append. |

Append-only: there is no edit and no delete, by design.

### `relation`

| Command | Purpose |
|---|---|
| `relation add <ref> --type parent\|blocks\|related --target <ref> [--force]` | Add an edge. For `parent`, **the task you name is the parent** and only an `epic` may be one. |
| `relation remove <ref> <relation-id>` | Remove it. |
| `relation list <ref>` | Edges, children, ancestors, blockers. |

### `session`

| Command | Purpose |
|---|---|
| `session set <ref> --seg <seg> --backend <name> [--owner] [--phase] [--pid]` | Register (the id is derived from `task, owner, seg`, so a resume keeps it). |
| `session close <ref> <session-id> [--failed]` | Close it. |
| `session list <ref>` | List them. |

### `assignees list` / `reporters list`

Read-only dictionaries, with `--query <text>` and `--limit <n>`. Every row carries
`display_name` **and** `id`.

There is **no** `assignees add`, `assignees rm` or `assignees rename` — not
"unimplemented", but absent: the dictionary grows when a task names somebody new
(`--assignee "<text>"`), and that is the whole interface.

Names are resolved in the same transaction as the task write: an exact or unique
prefix match is reused (the dictionary's spelling wins); several matches are
refused with `DICTIONARY_AMBIGUOUS` and the candidates listed; `--force-create`
skips the fuzzy step; `--assignee-id` bypasses the dictionary entirely.

### `report`

| Command | Purpose |
|---|---|
| `report template <ref> [--commit <sha>] [--path <p>]… [--command <cmd:exit>]… [--coverage <pct[@scope]>]…` | Print a report to fill in. |

The template is built from the card: `meta.acceptance` (what `--acceptance`
writes), then the imported card's `meta.acceptance_legacy` checkboxes, then an
empty list with a warning. Every item starts **`not_met`** — a ticked box on an
imported card is the author's intent, not this delivery's evidence — and
`leftovers` gets a `TODO:` placeholder so the shape is valid.

Evidence anchors are explicit flags first, then a read-only `git rev-parse HEAD`,
then the task's `source_path`, then a placeholder you must replace. It never fails
because git is missing (a container has no `.git`).

### `export`

| Command | Purpose |
|---|---|
| `export md [--out <dir>] [--project <id>] [--check]` | Write one markdown card per identifier. |

`--check` writes nothing and exits **3** when any card is missing or differs —
the same convention `migrate-cli check` uses. `taskctl export --md` is accepted
as the same command.

The service renders and the CLI writes: `POST /api/v1/export` returns markdown
and never touches a path the caller named.

### `token`

| Command | Purpose |
|---|---|
| `token rotate [--show]` | Rotate the access token. **Loopback only** (403 `loopback_only` otherwise). |

Prints `td_****` and the token file; `--show` prints the value and says what it
just did.

## `--json`

Wire names are `snake_case` (the card's vocabulary). A task looks like:

```json
{
  "ok": true,
  "data": {
    "task": {
      "id": "…uuid…",
      "identifier": "PROJ-0007",
      "project_id": "proj",
      "title": "…",
      "status": "in_review",
      "priority": "high",
      "labels": [],
      "version": 4,
      "delivery_round": 1,
      "report_latest_id": 3,
      "report_waiver": null,
      "status_changed_at": "2026-10-09T…Z",
      "assignee": { "id": "…", "display_name": "linus", "kind": "agent" },
      "reporter": { "id": "…", "display_name": "elon", "kind": "human" }
    },
    "report_waivers": [],
    "token_source": "file"
  }
}
```

An actor always carries `display_name` **and** `id`. `token_source` says which of
the four token sources was used (`flag`, `env`, `file`, `none`) and never carries
a value.

Errors are the domain error verbatim:

```json
{ "ok": false, "error": { "code": "REPORT_REQUIRED", "message": "…", "http": 422,
                          "details": { "round": 1, "existingRounds": [] },
                          "hint": { "command": "taskctl issue deliver PROJ-0007 --report-file -" } } }
```

Bind scripts to `error.code` and `error.hint.command`, never to the prose.

## Notes

- Everything is **local**. The command surface performs no network access beyond
  loopback to your own board.
- Every write that mutates state is safe under concurrent agents — the service
  owns that guarantee (transactions and compare-and-swap), not the CLI.
- Data lives in the board's SQLite file (`<dataDir>/board.sqlite`, default
  `<repo>/.data`, override with `TASKD_DATA_DIR` / `TASKD_DB`).
