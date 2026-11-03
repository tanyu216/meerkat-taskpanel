# taskctl — configuration, global context and operational reads

> The prose behind the command index in `../cli.md`: configuration, board start, `status`,
> `project`, `session`, `token`, `sla` and `events`. The frozen flag table is `../cli.md`.

## Configuration (`.env`)

One file, `<program root>/.env`, is read by `taskctl` and `taskd`. The process
environment wins key by key; CLI flags win over both.

- **Path:** `--env-file <path>` > `$MEERKAT_TASKPANEL_ENV_FILE` > `<program root>/.env`. A
  named `--env-file` that does not exist is an error; a missing default is "no configuration".
- **Address:** `TASKD_URL` is probed — a dead **loopback** address falls through to the runtime
  pointer or a lazy start, a dead **remote** address is an error. `--url` is a pin: never
  probed, never autostarted.
- **Token:** `--token` > `$TASKD_TOKEN` > `$TASKD_TOKEN_FILE` > the pointer's token file. Both
  token keys set in `.env` is an error; an inline `TASKD_TOKEN` requires the file to be `0600`.
- **Server keys:** `TASKD_ALLOW_LIST_ENABLED`, `TASKD_ALLOW_CIDRS`,
  `TASKD_LABEL_GC`, `TASKD_LABEL_TTL_DAYS`, `TASKD_HOST`, `TASKD_PORT`, `TASKD_DATA_DIR`,
  `TASKD_DB`, `TASKD_RUNTIME_POINTER`, `TASKD_NO_AUTOSTART`. Acceptance is board data, not
  config.
- **Identity is not a `.env` key.** `TASKCTL_ACTOR_KIND` / `TASKCTL_SESSION_ID` are refused in
  the file; `TASKCTL_AGENT` / `TASKCTL_HUMAN` may be defaults.
- **Per-kind layer.** Each actor kind also has `<program root>/.env.<actor-kind>` (for
  example `.env.claude`), read by `taskctl` as a per-agent default for `TASKCTL_AGENT`,
  `TASKCTL_HUMAN` and `MEERKAT_TASKPANEL_REPO`. It sits between the process environment and
  `.env` (flag > env > per-kind > `.env` > default), and `MEERKAT_TASKPANEL_CONFIG_DIR`
  relocates the directory — the same one that holds `projects.json`. The same file is the
  loop's policy file; the board path ignores the loop keys in it.
- **Grammar:** `KEY=VALUE`, `#` comments, matching quotes; no inline comments, interpolation,
  escapes or multiline values; absolute paths. An unknown key inside `TASKD_*` / `TASKCTL_*` /
  `MEERKAT_TASKPANEL_*` is an error; other keys are ignored and never merged into the child
  environment.

## Starting the board

Resolution order: `--url` pin → `TASKD_URL` → the runtime pointer → lazy start. With no board
running, `taskctl` starts one (detached, logging to `<dataDir>/logs/taskd.log`) and waits for
`/health`; `TASKD_NO_AUTOSTART=1` forbids that.


### `status` (no group)

`taskctl status [--url <url>] [--json]` — where this `taskctl` believes the board is, and whether
it answers. A **local read**: it reads the runtime pointer and probes `/health`; it never starts a
board, never resolves a token, and needs no `--actor-kind`. `--url` is a pin — the pointer is not
consulted behind it. Output: `{runtime: {pointer, data_dir, pid, url, running, note}, version,
schema_version}`. A board that is not running is `running: false` with **exit 0** — the answer,
not a failure; `note` says why (no pointer, or a stale pid).

### `project`

| Command | Purpose |
|---|---|
| `project create [--id <id>] [--prefix <p>] --name <n> [--meta k=v]… [--label <l>]… [--readme <text>]` | Create a project. `--prefix` (1-4 characters of A-Z and 0-9, normalized) is the prefix its cards are numbered with (`tp` → `TP-0001`); it beats `--id` and is enough on its own — the server then mints the project id. Without `--prefix` the id supplies the prefix (`demo` → `DEMO-0001`). `--prefix` is `meta.prefix`; passing both with different values is a usage error. A project carries no acceptance default and no reviewer: the review card's assignee selects the role. |
| `project ensure <id> [--name <n>] [--prefix <p>] [--meta k=v]… [--label <l>]… [--readme <text>]` | Create the project if its id is absent; if it exists, return it **untouched** (`created:false`). `--name` is needed only on creation. `--prefix` (1-4 characters of A-Z and 0-9) is the new project's card prefix and beats the id-derived one; it is ignored for an existing project. This is the idempotent form of `project create`; it never updates an existing row. |
| `project update <id> [--name] [--meta k=v]… [--label]… [--readme]` | Update it. `--meta` **merges**; acceptance and reviewer are not project fields. |
| `project list [--include-archived]` | List projects. |
| `project dir <id> [--require-dir]` | Print the local directory work happens in, resolved from the config-root `projects.json`: the entry's `local_path`, else `run_dir`. An entry naming no directory succeeds and says so. Exits non-zero only when no entry is registered, or the path is relative, missing, not a directory, or blank. `--require-dir` is the wake shape: resolve from the map only (no board check) and exit **3** when the map names no usable directory — a wake has to start somewhere. |
| `project map list` / `show <id>` / `set <id> [--local-path <dir> \| --run-dir <dir> \| --no-dir] [--base-ref <ref> \| --no-base-ref] [--merge-ref <ref> \| --no-merge-ref]` / `remove <id>` | Read and edit the machine-local map at the config root. `set` takes at most one of `--local-path` (`<dir>`), `--run-dir` (`<dir>`) and `--no-dir`; the directory must be absolute, existing and a directory. It may also set the loop-only rules in the same write: `--base-ref` must resolve as a commit-ish, `--merge-ref` must be a **local branch** (the loop merges into it); both are probed in the registered directory and fail with `PROJECT_REF_UNRESOLVED` when they do not resolve. A `merge_ref` that is not the checked-out branch is written with a warning, because landing will refuse until it is checked out. `--no-base-ref` / `--no-merge-ref` clear one rule; `--no-dir` is refused while a rule is declared. Local only: no identity, no token, no board. A missing map is an empty map for `list`; `show`/`remove` on an absent entry are `PROJECT_DIR_UNMAPPED`. |
| `project readme <id>` / `project readme <id> --set <text>` / `--file <path\|->` | Print or set the readme. |

**A project carries no directory.** The map is machine-local, at the config root (beside
`.env.<kind>`) — see [`projects-json.md`](../projects-json.md). `project dir` resolves and
validates it and stops to ask rather than guessing; `project map` is the only writer.

### `session`

| Command | Purpose |
|---|---|
| `session set <ref> --seg <seg> --owner-kind <name> [--owner] [--phase] [--pid] [--goal <text>] [--meta k=v]… [--session <id>]` | Register a session (the id is derived from `task, owner, seg`, so a resume keeps it). `--owner-kind` is the owner's platform kind (e.g. `claude`, `codex`); `--goal` is one sentence saying what this session is for. Omit `--goal` on a re-registration to keep the recorded sentence. `--meta` is opaque host metadata (harness, thread id, log path, …); a re-registration **merges** the supplied keys into the recorded object. |
| `session id <ref> --seg <seg> [--owner <name>] [--session <task-id>]` | Print the deterministic session id **without registering a session**. It is the value `session set` would write for the same `(task, owner, seg)`, so it can be handed to an agent before it starts. `--owner` defaults to the caller's actor id, exactly as `session set` does; `--session` replaces the task fed to the derivation. It always derives — a global `--session-id` is ignored. Read-only: no session row and no card change; it still resolves the ref through the board, so `ensureBoard` may start `taskd` (use the script below, or `TASKD_NO_AUTOSTART=1`, for a strict offline read). |
| `session close <ref> [<session-id>] [--seg <seg>] [--owner <name>] [--failed]` | Close it by row id, or by the natural key `(task, seg, owner)` with `--seg` (owner defaults to the acting actor). Exactly one identity is required. |
| `session list [<ref>] [--owner <name>] [--owner-kind <kind>] [--status running\|closed\|failed] [--limit <n>]` | With a ref: a card's sessions (oldest first), including each `goal` and `meta`. Without a ref: the board-wide read, newest first, bounded by `--limit` (default 200); it requires at least one of `--owner` / `--owner-kind` / `--status`, and refuses an unbounded scan. |

For a derivation that never touches the board, the skill ships
[`scripts/session-id.mjs`](../../scripts/session-id.mjs):
`node scripts/session-id.mjs --task-id <uuid> --owner <name> --seg <seg>` prints the same id
and does not start `taskd`. It cannot resolve an identifier to a UUID — pass the **resolved**
`data.task.id` from `issue get <ref> --json`, not `PROJ-0007`; hashing the identifier produces
an id `session set` will not match.


### `token`

| Command | Purpose |
|---|---|
| `token rotate [--show]` | Rotate the access token. **Loopback only** (403 `loopback_only` otherwise). |

Prints `td_****` and the token file; `--show` prints the value and says what it just did.

### `sla`

The board's computed SLA rows: one alert tuple per open wait, with its
tier (`warn` / `overdue` / `escalate`), elapsed working minutes and threshold. Read-only;
it moves no card.

| Command | Purpose |
|---|---|
| `sla list [--period <sec>] [--leader <id>] [--limit <n>] [--trail-limit <n>]` | Every open SLA row on the board. |
| `sla get <id\|identifier> [--period <sec>] [--leader <id>]` | One card's rows — the pre-emit re-read before a notification. |

`--period` sets the mechanism's measurement period for this call (`warn = L − P`); it
defaults to the board's `TASKD_SLA_PERIOD_SECONDS` (300). `--leader` names the actor id
the leader writes under; the default is the board's human decision authority. The
published table is visible at `GET /api/v1/sla` and under `/meta` → `capabilities.sla`.

### `events`

The board's live activity stream — a cursor over `task_activities`, not an event bus.
Read-only; it moves no card.

| Command | Purpose |
|---|---|
| `events hub` | Run the local event hub: one board SSE connection for every local consumer. |
| `events hub --stop` | Stop the running local event hub for this board and exit. |
| `events follow [--after <rev>] [--idle <ms>]` | Follow the hub as **newline-delimited JSON**; the same line types as `events tail`. |
| `events tail [--after <rev>] [--idle <ms>]` | Direct board SSE (diagnostic/fallback), the same NDJSON shape. |

`events hub` is normally started on demand by `export watch` or `events follow`; running it
in the foreground is for a service manager or a debugging session. The hub is **per user and
per board**: it binds `127.0.0.1` and publishes a 0600 pointer file in the runtime directory
(`MEERKAT_HUB_DIR`, else `$XDG_RUNTIME_DIR/meerkat-taskpanel`). It reconnects to the board
with the loop's 1 s→30 s ladder, keeps a bounded ring of recent events for a reconnecting
follower, and refreshes every watch registration. Nothing else on the host should open its
own board stream.

`events hub --stop` retires a hub that is running an older code generation, or one that is
wedged. It does not speak the socket protocol: it reads the pointer, requires the owner lock
to name the same pid, sends `SIGTERM`, and escalates to `SIGKILL` after five seconds. It
succeeds when no hub is running; a persisted detached registration is kept and the next
consumer rehydrates it. Like every board command it resolves the board first; with the board
down, pass `--url <board>` so resolving it cannot start one.

`events follow` is the consumer the loop uses. `--after` replays from the hub's ring when it
still retains the cursor (otherwise it starts live; the next board rescan is the fallback),
and `--idle` ends the local stream after that many milliseconds with no records (heartbeats
count, exactly like the direct stream); the default is **45 000 ms**. Output is the same NDJSON
as `events tail`.

`events tail` remains the direct implementation: no hub, one SSE connection, the same output.
Use it to diagnose the board stream itself; do not run it as a background consumer.

**Like `export watch`, these commands do not write the `{ok,data}` envelope.** Each line is
one JSON object:

```json
{"type":"open"}
{"type":"event","id":12,"data":{"event":"task_created","task_id":"…","revision":12,…}}
{"type":"idle","data":{"idle_ms":45000}}
{"type":"shutdown","data":{"reason":"…"}}
{"type":"eof"}
{"type":"error","data":{"code":"CLI_IO","message":"…"}}
```

`open` is written once the stream (or the hub) has answered; `event.id` is the cursor to pass
back as `--after`. `idle`, `shutdown` and `eof` exit 0; `error` exits 1. A failure **before**
the stream opens (unreachable board, auth refusal, a bad `--after`, a hub that cannot start)
is still the normal `{ok:false}` error document with a nonzero exit — no `open` line is
written.
