# `taskctl` CLI reference

This is the **contract index**: every command and every declared flag. The prose behind
each group is in the detail pages below; the index stays the frozen surface the CLI
contract test reads.

- [cli/core.md](cli/core.md) — configuration, board start, `status`, `project`, `session`, `token`, `sla`, `events`.
- [cli/issue.md](cli/issue.md) — cards, create, claim, deliver, the gate, awaiting/blocked, review.
- [cli/files.md](cli/files.md) — comments, relations, attachments, reports, export, editing.
- [cli/ops.md](cli/ops.md) — the loop, the workflow plan, `--json` and what each command returns.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Print `{"ok":true,"data":…}` on stdout. Failures print `{"ok":false,"error":{code,message,http,details,hint}}` on **stdout** too, so a pipe needs one stream. |
| `--env-file <path>` | Config file. Default `<program root>/.env`; `$MEERKAT_TASKPANEL_ENV_FILE` overrides it. |
| `--url <url>` | The board to talk to, as a **pin**: never probed, never autostarted. |
| `--token <token>` | Access token. Priority: `--token` > `$TASKD_TOKEN` > `$TASKD_TOKEN_FILE` > the pointer's token file > none (loopback needs no token). Never echoed. |
| `--if-version <n>` | Optimistic concurrency: refuse the write with `VERSION_CONFLICT` if the task moved on. |
| `--actor-kind <name>` | The platform (`claude`, `codex`, `openclaw`, `pi`; automation uses `system`). **Required on every command that talks to the board** — `--help`, `--version`, the local read `status`, and every `project map` action need none. `human` is reserved and refused; use `--as-human`. |
| `--as-human` | Write as the configured human (`$TASKCTL_HUMAN`). Use it when you are in a conversation with the human or the instruction explicitly came from them; never for the loop's or your own writes. Also satisfies the identity requirement. |
| `--session-id <id>` | Agent session identifier. Requires `--actor-kind`. |
| `--agent <name>` | The role/person recorded on writes (`jobs`, `linus`, `turing`, …). Defaults to `$TASKCTL_AGENT` / `$USER`; a team passes it per call. |
| `--version` | Print the release version and exit. |
| `-h`, `--help` | Help for the CLI, a group, or one command. |

**Exit codes:** `0` success · `1` runtime failure (including the delivery gate) · `2` usage
error · `3` `export md --check` found stale cards · `78` permanent startup fault (`EX_CONFIG`:
a missing skill, an unsupported Node) — a service manager must not restart it.

## Commands

### `status` (no group)

| `status [--url <url>] [--json]` | See [cli/core.md](cli/core.md). |

### `project`

| Command | Purpose |
|---|---|
| `project create [--id <id>] [--prefix <p>] --name <n> [--meta k=v]… [--label <l>]… [--readme <text>]` | See [cli/core.md](cli/core.md). |
| `project ensure <id> [--name <n>] [--prefix <p>] [--meta k=v]… [--label <l>]… [--readme <text>]` | See [cli/core.md](cli/core.md). |
| `project update <id> [--name] [--meta k=v]… [--label]… [--readme]` | See [cli/core.md](cli/core.md). |
| `project list [--include-archived]` | See [cli/core.md](cli/core.md). |
| `project dir <id> [--require-dir]` | See [cli/core.md](cli/core.md). |
| `project map list` / `show <id>` / `set <id> [--local-path <dir> \| --run-dir <dir> \| --no-dir] [--base-ref <ref> \| --no-base-ref] [--merge-ref <ref> \| --no-merge-ref]` / `remove <id>` | See [cli/core.md](cli/core.md). |
| `project readme <id>` / `project readme <id> --set <text>` / `--file <path\|->` | See [cli/core.md](cli/core.md). |
### `issue`

| Command | Purpose |
|---|---|
| `issue create` | See [cli/issue.md](cli/issue.md). |
| `issue list [--project] [--status <s>]… [--assignee <name>\|--assignee-id <id>] [--parent <ref>] [--kind <kind>] [--label <label>]… [--target <value>] [--meta <key>=<value>]… [--review-of <ref>] [--limit] [--include-archived] [--order-debug]` | See [cli/issue.md](cli/issue.md). |
| `issue candidates --assignee <name> [--stale] [--include-unassigned] [--order-debug]` | See [cli/issue.md](cli/issue.md). |
| `issue get <id\|identifier> [--include comments\|reports\|relations\|sessions]… [--limit <n>]` | See [cli/issue.md](cli/issue.md). |
| `issue update <ref> [--title] [--description] [--priority] [--kind] [--label]… [--meta k=v]… [--acceptance <text>]… [--drop-acceptance <text>]… [--acceptance-revision <n>] [--acceptance-mode off\|auto\|human [--reason "<why>"]]` | See [cli/issue.md](cli/issue.md). |
| `issue move <ref> <status> [--allow-steal --reason "<why>"] [--no-report --reason "<why>"] [--awaiting-reason E1..E5] [--question "<text>"] [--blocked-reason <word>]` | See [cli/issue.md](cli/issue.md). |
| `issue reopen <ref> --reason "<why>"` | See [cli/issue.md](cli/issue.md). |
| `issue claim <ref> [--check-blockers] [--allow-steal --reason "<why>"]` | See [cli/issue.md](cli/issue.md). |
| `issue heartbeat <ref>` | See [cli/issue.md](cli/issue.md). |
| `issue wait <ref> [--question <comment-id>] [--timeout <ms>] [--interval <ms>] [--heartbeat <sec>]` | See [cli/issue.md](cli/issue.md). |
| `issue assign <ref> [--assignee <text>] [--assignee-id <id>] [--reporter <text>] [--reporter-id <id>] [--force-create]` | See [cli/issue.md](cli/issue.md). |
| `issue archive <ref> [--days <n>]` | See [cli/issue.md](cli/issue.md). |
| `issue meta <ref> --meta <k>=<v>…` | Read-modify-write merge; the global `--if-version` is forwarded and refuses a stale merge with `VERSION_CONFLICT`. See [cli/issue.md](cli/issue.md). |
| `issue deliver <ref> --report-file <file\|-> [--to done] [--no-report --reason "<why>"] [--seg <seg>]` | See [cli/issue.md](cli/issue.md). |
| `issue reconcile [--dry-run] [--workflow] [--assignee <agent>] [--reviewer <agent>] [--review-aging-ms <n>] [--rework-max-rounds <n>] [--max-actions <n>] [--board-limit <n>]` | See [cli/issue.md](cli/issue.md). `--reviewer` is a deprecated alias. |
#### `issue create`

| Flag | Meaning |
|---|---|
| `--project <id>` | See [cli/issue.md](cli/issue.md). |
| `--title <t>` | See [cli/issue.md](cli/issue.md). |
| `--acceptance-mode off\|auto\|human` | See [cli/issue.md](cli/issue.md). |
| `--acceptance <text>` | See [cli/issue.md](cli/issue.md). |
| `--assignee <text>` / `--assignee-id <id>` / `--assignee-kind <agent\|human>` | See [cli/issue.md](cli/issue.md). |
| `--reporter <text>` / `--reporter-id <id>` / `--reporter-kind <agent\|human>` | See [cli/issue.md](cli/issue.md). |
| `--description <md>` | See [cli/issue.md](cli/issue.md). |
| `--priority <low\|medium\|high\|urgent>` | See [cli/issue.md](cli/issue.md). |
| `--kind task\|epic` | See [cli/issue.md](cli/issue.md). |
| `--label <l>` / `--meta k=v` | See [cli/issue.md](cli/issue.md). |
| `--target <t>` | See [cli/issue.md](cli/issue.md). |
| `--parent <ref>` | See [cli/issue.md](cli/issue.md). |
| `--status <s>` | See [cli/issue.md](cli/issue.md). |
| `--idem <key>` | See [cli/issue.md](cli/issue.md). |
| `--allow-dup` / `--force-create` | See [cli/issue.md](cli/issue.md). |
| `--review-of <ref> [--review-round <n>]` | See [cli/issue.md](cli/issue.md). |
### `comment`

| Command | Purpose |
|---|---|
| `comment list <ref> [--kind <kind>] [--limit <n>]` | See [cli/files.md](cli/files.md). |
| `comment add <ref> (--body <text> \| --file <path\|->) [--kind discuss\|decision\|confirm\|confirm_request\|change\|note\|defect\|question] [--ref <kind:id>]…` | See [cli/files.md](cli/files.md). |
### `relation`

| Command | Purpose |
|---|---|
| `relation add <ref> --type parent\|blocks\|related --target <ref> [--force]` | See [cli/files.md](cli/files.md). |
| `relation remove <ref> <relation-id>` | See [cli/files.md](cli/files.md). |
| `relation list <ref>` | See [cli/files.md](cli/files.md). |
### `attachment`

| Command | Purpose |
|---|---|
| `attachment add <ref> --file <path> [--name <filename>] [--content-type <type>]` | See [cli/files.md](cli/files.md). |
| `attachment list <ref>` | See [cli/files.md](cli/files.md). |
| `attachment download <attachment-id> --out <file>` | See [cli/files.md](cli/files.md). |
| `attachment remove <attachment-id>` | See [cli/files.md](cli/files.md). |
### `session`

| Command | Purpose |
|---|---|
| `session set <ref> --seg <seg> --owner-kind <name> [--owner] [--phase] [--pid] [--goal <text>] [--meta k=v]… [--session <id>]` | See [cli/core.md](cli/core.md). |
| `session id <ref> --seg <seg> [--owner <name>] [--session <task-id>]` | See [cli/core.md](cli/core.md). |
| `session close <ref> [<session-id>] [--seg <seg>] [--owner <name>] [--failed]` | See [cli/core.md](cli/core.md). |
| `session list [<ref>] [--owner <name>] [--owner-kind <kind>] [--status running\|closed\|failed] [--limit <n>]` | See [cli/core.md](cli/core.md). |
### `actors list` / `labels list`

| Command | Purpose |
|---|---|
| `actors list [--query <text>] [--limit <n>]` | See [cli/core.md](cli/core.md). |
| `labels list [--query <text>] [--limit <n>]` | See [cli/core.md](cli/core.md). |
### `report`

| Command | Purpose |
|---|---|
| `report list <ref> [--round <n>]` | See [cli/files.md](cli/files.md). |
| `report template <ref> [--commit <sha>] [--path <p>]… [--command <cmd:exit>]… [--coverage <pct[@scope]>]…` | See [cli/files.md](cli/files.md). |
### `export`

| Command | Purpose |
|---|---|
| `export md [<ref>] [--out <dir\|file.md>] [--project <id>] [--check] [--md] [--watch]` | See [cli/files.md](cli/files.md). |
| `export watch [<ref>] [--ref <ref>]… [--dir <dir>\|--out <file>] [--after <rev>] [--idle <ms>] [--ttl <ms>] [--once] [--detach] [--watch-status] [--stop] [--standalone]` | See [cli/files.md](cli/files.md). |
### `token`

| Command | Purpose |
|---|---|
| `token rotate [--show]` | See [cli/core.md](cli/core.md). |
### `sla`

| Command | Purpose |
|---|---|
| `sla list [--period <sec>] [--leader <id>] [--limit <n>] [--trail-limit <n>]` | See [cli/core.md](cli/core.md). |
| `sla get <id\|identifier> [--period <sec>] [--leader <id>]` | See [cli/core.md](cli/core.md). |
### `events`

| Command | Purpose |
|---|---|
| `events hub` | See [cli/core.md](cli/core.md). |
| `events hub --stop` | See [cli/core.md](cli/core.md). |
| `events follow [--after <rev>] [--idle <ms>] [--hold <ms>] [--event <name>[:<path>=<value>]]…` | See [cli/core.md](cli/core.md). |
| `events tail [--after <rev>] [--idle <ms>]` | See [cli/core.md](cli/core.md). |
### `loop`

| Command | Purpose |
|---|---|
| `loop patrol` | See [cli/ops.md](cli/ops.md). |
| `loop workflow` | See [cli/ops.md](cli/ops.md). |
| `loop poll` | See [cli/ops.md](cli/ops.md). |
| `loop tick [--passes <list>]` | See [cli/ops.md](cli/ops.md). |
| `loop console` | See [cli/ops.md](cli/ops.md). |
| `loop doctor` | See [cli/ops.md](cli/ops.md). |
| `loop status [--take-over] [--stop] [--json]` | See [cli/ops.md](cli/ops.md). |
| `loop run [--ping-once] [--continue-once]` | See [cli/ops.md](cli/ops.md). |
| `loop subscribe` | See [cli/ops.md](cli/ops.md). |
| `loop session` | See [cli/ops.md](cli/ops.md). |
<!-- shared-flags:loop:begin -->
**Paths and state.** `--state-dir <dir>` places the loop's runtime state — `supervisor.state.json`,
the queue, the ledger, `session.lock`, `continue.state.json`; `--state <file>` is the older
explicit spelling of the registry file. `--roles-dir <dir>` names an explicit custom-team directory (a directory of role directories; it replaces discovery for this loop);
`--home <dir>` the home the agent directories derive from; `--repo <dir>` the board checkout the loop drives; `--cli <path>`
the `taskctl` entry its child calls use; `--config <file>` the per-kind config (`<program root>/.env.<actor-kind>`);
`--log <file>` the loop log; `--continue-state`, `--session-state`, `--sla-ledger`,
`--workflow-ledger`, `--sla-last-ok` and `--sla-peer` override the individual state files.

**Cadence and policy.** `--ping-interval <sec>` and `--continue-interval <sec>` set the two
clocks; `--continue <yes|no>` enables the tick clock. `--opened-by <human|supervisor>`
records who opened the loop; `--resident <auto|no>` says whether a resident pool is expected.
`--control <internal|external>` marks a pool started by a live session (`external`); it changes neither the pool's lifetime nor what it dispatches, and there is no LLM control turn. `--session-max-age`,
`--session-turn-timeout` (1200..7199 s), `--session-poll-ms`, `--session-pool-max`,
`--project-concurrency` and `--project-idle-ms` bound the pool. `--max-concurrency` caps the
whole fleet; `--claim-unassigned <yes|no>` (or the shorthand `--assignee-only`) decides the
claim pool; `--recover-stale <yes|no>` recovers stale in-progress claims, and
`--recover-wedged <yes|no>` lets the ping clock stop a wedged pool one minute past its
phase deadline (`turn + 3 min`, or the 5-minute start budget plus one); it SIGTERMs once per
wedge, SIGKILLs on a later ping if the pool survives, and the service manager restarts it. `--workflow <yes|no>` applies the
board's plan; the review card's assignee selects the reviewer role, and `--reviewer` is a
deprecated no-op;
`--workflow-max-actions` and `--review-aging-minutes` bound workflow execution and
silent-review escalation, and `--rework-max-rounds` sets how many delivery rounds since the
last hold before the loop parks a card as `blocked`/`decision`. `--workspace <worktree|shared>` says where a card runs: its own
worktree and lane branch (the default) or the project checkout. `--allow-all-tools` gives
spawned agents the unrestricted tool set and **requires** a non-empty
`--allow-all-tools-reason` naming who authorized it.

**SLA, events and notifications.** `--patrol-interval <sec>` sets the SLA measurement
period; `--patrol-llm` lets the patrol move a card (default: notify only); `--notify <cmd>`
is the notification command (alert JSON on stdin); `--sla-leader <id>` names the actor the
SLA leader writes under; `--sla-peer <file>` and `--sla-last-ok <file>` keep the peer
liveness markers. `--sse-idle-ms`, `--event-debounce-ms`, `--event-debounce-max-ms`,
`--event-continue <yes|no>` and `--event-continue-min-ms` tune the subscriber.
`--board-limit` and `--trail-limit` cap the board snapshot and comment-trail reads, and
`--dry-run` plans every write-only verb without writing anything.
<!-- shared-flags:loop:end -->

### `role`

| Command | Purpose |
|---|---|
| `role list [--json]` | See [cli/ops.md](cli/ops.md). |
| `role sync --file <path\|->` | See [cli/ops.md](cli/ops.md). |
### `worktree`

| Command | Purpose |
|---|---|
| `worktree create <slug> [--project <id>] [--base <ref>] [--branch <name>]` | See [cli/ops.md](cli/ops.md). |
| `worktree status [--project <id>] [--into <ref>]` | See [cli/ops.md](cli/ops.md). |
| `worktree leave <slug> [--keep\|--remove] [--project <id>] [--into <ref>]` | See [cli/ops.md](cli/ops.md). |
| `worktree sweep [--older-than <hours>] [--project <id>] [--into <ref>] [--dry-run]` | See [cli/ops.md](cli/ops.md). |
| `worktree guard --runtime claude\|codex\|pi` | See [cli/ops.md](cli/ops.md). |

The full prose for each group is in `cli/core.md`, `cli/issue.md` and `cli/ops.md`.