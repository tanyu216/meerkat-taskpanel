# taskctl — the loop, the workflow plan and the JSON envelope

> The prose behind the command index in `../cli.md`: the loop verbs, the board's workflow
> plan, `--json` and what each command returns. The frozen flag table is `../cli.md`.

### `loop`

The external loop: the process that makes the board move on its own. It patrols SLA and
heartbeats, applies the board's workflow plan, claims ready cards and hands them to agent
CLIs, and keeps a resident session pool. The implementation lives in the toolkit
(`src/orchestrator/`), not in the agent skill — the skill carries decisions, `taskctl`
carries the machinery.

Every verb is **local** (`local: true`): it resolves its own board context from `--url` /
`--env-file` / the runtime pointer, and its runtime state lives in the loop state directory.
`--as-human`, `--session-id` and `--if-version` are refused with `CLI_USAGE` (exit 2) — the
loop is never a human, never inherits a caller's session and never uses the CLI's
optimistic-concurrency guard. `--actor-kind` is required on every verb that writes to the
board (`patrol`, `workflow`, `poll`, `tick`, `run`, `subscribe`, `session`); the reads
(`console`, `doctor`, `status`) work without it, and `status` needs no board at all.

| Command | Purpose |
|---|---|
| `loop patrol` | One SLA / heartbeat pass. Notify-only unless `--patrol-llm` is set. |
| `loop workflow` | Apply the board's `issue reconcile --workflow` plan. |
| `loop poll` | Scan, admit, claim and enqueue ready cards; writes the queue. |
| `loop tick [--passes <list>]` | Run `patrol,workflow,poll` (or `--passes` order) in one command — the cron/unit entry. |
| `loop console` | One read-only question / frontier cycle. |
| `loop doctor` | One read-only daily-inspection report: supervisor verdict, the resolved scan set, the patrol's last-successful-run marker, the log tail, queue and ledger depth, the cards whose heartbeat is stale or unreadable, the stale claims whose handoff rows are all terminal or absent (`undispatched_claims` — nothing can re-dispatch them; only a human release frees the card), the `in_review` cards waiting on a human (age only — review aging stays the workflow pass's judgement), and the cards carrying an acceptance marker for their current round while still `in_review` (`blocked_acceptance` — the board refused the close), and the `done` cards whose lane branch is not in the project's current branch (`unlanded`), and the cards that keep going round the same loop (`looping`: rework rounds, review reopens, dispatch retries, subagent failures — read-only facts, with the loop's own queue/ledger windows). Writes nothing and exits 0 whenever it produced a report — read `attention` from `--json`. |
| `loop status [--take-over] [--stop] [--json]` | Report the loop's runtime verdict (including `unresponsive` and `wedged`), the pool's tick age, the boot ledger (`lastCrash`, the consecutive failed-start streak, the recent starts), the agent platform (`--actor-kind`), the discovered role platforms and the scan set it resolved; `--take-over` starts the pool in external-control mode, `--stop` stops the pool this session started. |
| `loop run [--ping-once] [--continue-once]` | The two clocks as a daemon; either `--*-once` runs one pass and exits. |
| `loop subscribe` | The event subscriber daemon; it requests an early tick. |
| `loop session` | The resident session pool daemon. |

`loop tick` stops at the first failing pass and returns its exit code. `loop run` refuses
`--ping-once` together with `--continue-once`. `loop status`, `loop console` and `loop doctor` are the
verbs a human runs while the daemons are up. Every verb writes its **own** output: `loop status --json` is the
loop's JSON, not the `{ok:true,data}` envelope, and none of them adds `token_source`.
`loop status --json` carries `platform` (`claude|codex|pi`) and `agents` (the resolved scan
set); the human output prints the same two facts as `platform:` and `scan set:` lines. It
also carries `pool.tickAgeMs` (the in-flight tick's age, `null` when idle) and `health` —
the `supervisor.health.json` projection `{startedAt, pid, version, lastCrash, starts,
bootFailures}`, or `null` when no long-lived entry has ever run. The human output prints
those as `tick:` and `health:` lines. They are output fields, not new flags.


The retired single-purpose flags are gone: `--once` (bare poll), `--poll-interval`,
`--ping-only`, `--continue-only`, `--patrol-only`, `--subscribe` and `--session` are the
verbs (`loop poll`, `loop run --ping-once`, `loop subscribe`, `loop session`). `--state` is
still accepted; `--state-dir` is the documented spelling.

## reconcile --workflow — the board's workflow plan

```bash
taskctl issue reconcile --workflow --assignee jobs \
  --review-aging-ms 3600000 --rework-max-rounds 4 --max-actions 20 --board-limit 500 --json
```

`--json` returns `{dry_run, scanned, actions, workflow}`, where `workflow` is
`{alerts, actions, changes, summary}` in snake_case. `--board-limit` bounds the snapshot; a
truncated snapshot still applies outcomes but dispatches nothing. `--rework-max-rounds`
bounds the delivery rounds since the last hold before the plan emits a `hold_card` (the card
is parked as `blocked` with a question; the loop's configured liveness bounds apply).
The actions are decisions the loop executes, not effects; what each one means, and the
fail-safe rules behind them, are in
[`lifecycle/workflow.md` §11](../lifecycle/workflow.md#11-the-boards-workflow-decisions).

### `role`

The **local role catalog** — a host-local projection of the roles the supervisor discovered
(`<config root>/roles.json`), never board state. Both verbs are local: no board, no token, no
`--actor-kind`.

| Command | What it does |
|---|---|
| `role list [--json]` | Print `data.roles[].agent`, `id`, `title`, `lanes` and `installed_on`. This is the valid `--assignee` range for `issue create`/`issue assign`. An absent or malformed file reads as no roles (with a warning), never as a partial range. |
| `role sync --file <path\|->` | **Supervisor-only.** Replace the catalog with a discovered set (stdin with `-`). Identical content is a no-op; a removed role disappears. |

A card's assignee is checked against this catalog when it is non-empty (`ASSIGNEE_NOT_IN_CATALOG`,
exit 1). The check is a **CLI guard**, not a board invariant: a direct HTTP write bypasses it.
The writer identity (`system`/`Orchestrator`) is never exempt — the guard looks at the
assignee. A review card is stricter still: its assignee must name a **reviewer-lane** role
(`ASSIGNEE_NOT_REVIEWER`), so the loop creates it with the catalog's `default_reviewer` and
never needs `--force-create`.

### `worktree`

The **local session-worktree lifecycle** — the human half of the loop's isolation. It is local
by construction: no board, no token, no `--actor-kind`. A session tree is
`<project>/.worktrees/<slug>` on its own branch; `git worktree list` is the registry, so a
crashed session leaves no state file to reconcile. The branch namespace is the ownership rule:
`lane/` belongs to the loop and is never touched here.

| Command | What it does |
|---|---|
| `worktree create <slug> [--project <id>] [--base <ref>] [--branch <name>]` | Create `.worktrees/<slug>` on a new branch. The base is `--base`, else the `base_ref` of the project named by `--project`, else the primary checkout's current branch. `.worktrees/` must already be ignored; a lane branch, an invalid slug, an existing path or an existing branch is refused. |
| `worktree status [--project <id>] [--into <ref>]` | List session trees with `dirty`, `merged` (against `--into`, else the `merge_ref` of `--project`, else the current branch), `loop_owned` and `current`. |
| `worktree leave <slug> [--keep\|--remove] [--project <id>] [--into <ref>]` | `--keep` (the default) reports. `--remove` deletes the tree and its branch only when the tree is clean **and** the branch is already an ancestor of the integration ref (same precedence as `status`); a dirty tree (`WORKTREE_DIRTY`), an unmerged branch (`WORKTREE_UNMERGED`) and a `lane/` tree (`WORKTREE_LOOP_OWNED`) are refused. There is no `--force`. |
| `worktree sweep [--older-than <hours>] [--project <id>] [--into <ref>] [--dry-run]` | Remove every session tree that is clean, merged into the integration ref (same precedence as `status`) and old enough; skip the current tree, `lane/` trees, dirty trees and unmerged branches, and report each survivor's reason. `--dry-run` reports what would go and changes nothing. |
| `worktree guard --runtime claude\|codex\|pi` | The **hook adapter**, not a human verb: read one tool payload on stdin and print that runtime's decision shape — `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}` for Claude/Codex, `{"block":true,"reason":…}` for pi. A project opts in by carrying `docs/agents/worktrees.md`; a linked worktree and exempt paths are allowed; a write to the protected primary checkout is denied with the recovery command. A Claude `EnterWorktree` with a `name` (native creation in `.claude/worktrees/`) is denied; entering an existing `path` is allowed. It fails **open** when git cannot answer. Shell matching is best-effort: a guardrail, not a sandbox. |

The root is the **primary** checkout even when the command runs from a linked worktree. A
worktree made by the loop (`lane/…`) is never a session tree; use the loop's acceptance or
patrol sweep for it. The `--project` flag reads `base_ref` / `merge_ref` from the map
explicitly — the map has no reverse lookup, so a directory alone does not name a project.

## `--json`

Wire names are `snake_case`. A task looks like:

```json
{
  "ok": true,
  "data": {
    "task": {
      "id": "…uuid…", "identifier": "PROJ-0007", "project_id": "proj", "title": "…",
      "status": "in_review", "awaiting_reason": null, "priority": "high", "labels": [],
      "version": 4, "delivery_round": 1, "report_latest_id": 3, "report_waiver": null,
      "status_changed_at": "2026-10-09T…Z",
      "assignee": { "id": "…", "display_name": "linus", "kind": "agent" },
      "reporter": { "id": "…", "display_name": "elon", "kind": "human" }
    },
    "report_waivers": [],
    "token_source": "file"
  }
}
```

An actor always carries `display_name` **and** `id`. `token_source` names the source used
(`flag`, `env`, `file`, `none`) and never carries a value. Errors are the domain error
verbatim:

```json
{ "ok": false, "error": { "code": "REPORT_REQUIRED", "message": "…", "http": 422,
                          "details": { "round": 1, "existingRounds": [] },
                          "hint": { "command": "taskctl issue deliver PROJ-0007 --report-file -" } } }
```

Bind scripts to `error.code` and `error.hint.command`, never to the prose.

`events tail`, `events follow` and `export watch` are the exceptions: they write newline-delimited records
(see [`events`](core.md#events) and [`export watch`](files.md#export-watch)), not this envelope. Every other
command, including `sla list` and `events hub --stop`, answers one document.

Everything is local (loopback only); data lives in `<dataDir>/board.sqlite` (default
`<repo>/.data`), overridable with `TASKD_DATA_DIR` / `TASKD_DB`.

## What each command returns

`data` is one object; these are its keys. **Every board-backed command also carries
`token_source`** (`flag` · `env` · `file` · `none`, never the value). The local commands —
`status`, `project map …`, and `project dir --require-dir` — do not, and the streamed ones
(`events …`, a foreground `export watch`, every `loop` verb) write their own output rather than
this envelope.

| Command | `data` keys |
|---|---|
| `status` | `runtime{pointer,data_dir,pid,url,running,note}`, `version`, `schema_version` |
| `project create` / `project update` | `project` |
| `project ensure` | `project`, `created` |
| `project list` | `projects[]` |
| `project dir` | `project`, `dir` (a `--require-dir` miss exits 3 and adds `code`, `message`, `file`) |
| `project map list` | `file`, `present`, `projects` |
| `project map show` / `set` | `file`, `project`, `entry`, `dir` (`set` also `created`) |
| `project map remove` | `file`, `project`, `removed` |
| `project readme` | `readme` |
| `issue create` / `update` / `meta` / `heartbeat` / `assign` / `archive` | `task`, `report_waivers[]` |
| `issue get` | `task`, `report_waivers[]`, `attachments[]`; `--include` adds `comments[]`, `reports[]`, `relations{…}`, `sessions[]` |
| `issue list` | `tasks[]`; `--order-debug` adds `order_debug[]` |
| `issue candidates` | `candidates[]`; `--order-debug` adds `order_debug[]` |
| `issue move` / `reopen` | `task`, `report_waivers[]`, `status` |
| `issue claim` | `task`, `report_waivers[]`, `status`, `reused`, `stole` |
| `issue wait` | `outcome` (`answered\|escalated\|moved\|timeout\|error`), `status`, `claimed_by`, `question_id`, `answer`, `waited_ms` |
| `issue deliver` | `task`, `report_waivers[]`, `report`, `report_id`, `round`, `status`, `waived` |
| `issue reconcile` | `dry_run`, `scanned`, `actions[]`; `--workflow` adds `workflow{alerts,actions,changes,summary}` |
| `comment list` | `comments[]` |
| `comment add` | `comment` |
| `relation add` | `relation` |
| `relation list` | `task_id`, `relations[]`, `children[]`, `ancestors[]`, `blocked_by[]`, `blocks[]`, `parent_chain[]` |
| `relation remove` | `removed`, `relation` |
| `attachment add` | `attachment` |
| `attachment list` | `task_id`, `attachments[]` |
| `attachment download` | `attachment_id`, `out`, `size`, `content_type` |
| `attachment remove` | `removed`, `attachment` |
| `session set` / `session close` | `session` |
| `session id` | `session_id`, `task_id`, `task_identifier`, `derived_from`, `owner`, `seg` |
| `session list` | `sessions[]` |
| `actors list` | `actors[]`, `entries[]` (the same list under both names) |
| `labels list` | `labels[]` |
| `report list` | `ref`, `reports[]` |
| `report template` | `report`, `acceptance_source`, `evidence_source`, `ref` |
| `export md` | `cards`, `out`, `identifiers[]`; `--check` adds `missing[]`, `differing[]`, `up_to_date` |
| `export watch --detach` | `running`, `registration_id`, `reused`, `reason`, `cards`, `expires_at`, `dir`, `out` |
| `export watch --watch-status` | `running`, `registration_id`, `cards`, `expires_at`, `last_refresh`, `dir`, `out` (or `running:false`, `reason:"no-hub"`, `ref`, `dir`, `out`) |
| `token rotate` | `token_file`, `rotated`, `token` (`null` without `--show`) |
| `sla list` / `sla get` | `generated_at`, `board_truncated`, `trails_truncated`, `config`, `alerts[]`, `warnings[]` |
| `events hub --stop` | `stopped`, `pid`, `reason` (`no-pointer` · `not-running` · `owner-mismatch` is an error · `stopped`) |
| `events tail` / `events follow` / `export watch` (foreground) | NDJSON lines, not this envelope |
| every `loop` verb | its own streamed output, not this envelope |

The card object itself — every key of `data.task`, its nested actor refs and the relation
between the wire and the markdown card — is [`schema/wire.md`](../schema/wire.md#reading-a-card-as-json).
