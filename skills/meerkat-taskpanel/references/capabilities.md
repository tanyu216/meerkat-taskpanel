# Board capabilities a supervisor binds to

[`cli.md`](cli.md) is the complete `taskctl` reference. This page is the **subset a
supervisor uses**, with the exact invocation and the JSON keys it reads. It is the contract
behind `board.mjs` and `passes.mjs` in the `meerkat-loop` skill: the loop decides *when*;
these are the *how*. The loop never calls the board's HTTP API directly — every operation
below, including the live event stream, is a `taskctl` command.

## The invocation rule

```text
taskctl --json --agent <agent> --actor-kind <kind> [--env-file <p>] [--url <u>] <group> <command> …
```

- `--actor-kind` is required. The loop uses the actor kind (`claude`, `codex`,
  `pi`) for reads and claims, and `taskd` for the workflow
  writes so an automated acceptance is attributable to the board, not a human.
- The token rides in `TASKD_TOKEN` in the child environment, never on argv.
- stdout is `{ok:true,data}` or `{ok:false,error{code,message,http,details,hint}}`;
  exits are 0 ok, 1 runtime, 2 usage, 3 `export md --check` differences.
- **The event-stream commands are the exception**: `events tail` and
  `events follow` write newline-delimited JSON, not the envelope (see §8).

## 1. Interface floor — `--version`

| Invocation | Keys read | Consumer |
|---|---|---|
| `taskctl --version --json` | `data.version`, `data.schema_version` | `scripts/board-check.mjs` |

## 2. Project rows — `project list`

| Invocation | Keys read | Consumer |
|---|---|---|
| `taskctl --json … project list` | `data.projects[].id`, `.name`, `.reviewer`, `.acceptance` | `board.mjs#readProjectReviewers` → poll's reviewer merge and the workflow pass's reviewer check |

`reviewer` is the project's override; `acceptance` (`auto` / `off` / `agent` /
`human`) is the default a new card inherits. The board resolves the effective
reviewer per card (`project.reviewer ?? deployment reviewer`).

## 3. Candidate scan and atomic claim

| Invocation | Keys read | Consumer |
|---|---|---|
| `issue candidates --assignee <agent> [--include-unassigned] [--stale]` | `data.candidates[]` | poll's scan |
| `issue claim <identifier>` | only `ok` / `error` | poll's claim |

Candidate tuple: `id`, `identifier`, `title`, `status`, `priority`, `project`,
`sort`, `created_at`, `target`, `meta`, `reason`, `review_of`, `review_round`.
`target` is the card's own `meta.target` (not a project directory); `meta` is
projected whole as the escape hatch for a consumer's own keys, so a poll does not
need an `issue get` per candidate. `review_of` is non-null only for a review
card; a dedicated reviewer is given only those.

`issue claim` is the one claim path: it claims a ready `todo` card and performs
the stale re-claim/takeover that the transition table cannot express. A refused
claim never enqueues a handoff — and the handoff is only produced by the resident
pool, so a claim made without a pool starts no worker.

Claim does **not** re-read the dependency graph by default: the candidate scan
already withholds blocked cards, so a caller that trusts its own scan pays
nothing. `issue claim <ref> --check-blockers` opts into the board's re-read and
refuses with `BLOCKED_BY_PREDECESSOR` (409) when a `blocks` predecessor is not
`done`; the error's `details.blockers[]` names them.

## 4. Board read — `issue list`

| Invocation | Keys read | Consumer |
|---|---|---|
| `issue list --limit <board-limit>` | `data.tasks[]` | the legacy stale-heartbeat patrol |

The patrol reads `identifier`, `status`, `heartbeat_at`, `claimed_by_actor`,
`assignee`. Truncation is inferred when `tasks.length >= board-limit`.

The same read takes scope filters without a second request: `--parent <ref>`,
`--kind`, `--label` (repeatable), `--target`, `--meta k=v` (repeatable) and
`--assignee <name>`. They are applied in SQL before `--limit`, so a narrow read
never truncates the card it was looking for. `--meta flow=<x>` is the generic
way to scope on a team's own key.

## 5. SLA rows — `sla list` / `sla get`

The board computes the rows; the loop only delivers them.

| Invocation | Keys read | Consumer |
|---|---|---|
| `sla list [--period <sec>] [--leader <id>] --limit <n> --trail-limit <n>` | `data.config.period_seconds`, `.peer_liveness_k`, `.peer_period_min`; `data.alerts[]`; `data.board_truncated`, `.trails_truncated`, `.warnings[]` | the SLA half of the patrol |
| `sla get <ref> [--period <sec>] [--leader <id>]` | `data.alerts[]` | the pre-emit re-read before a notification |

An alert carries `card_id`, `sla_row`, `severity`, `elapsed_working_min`,
`threshold_min`, `dedup_key`, `action`, `target`, `notify`. `--period` is passed
only when the operator stated it; otherwise the board's configured period wins.

`inspector_liveness` is appended **locally** from the peer marker — the board
cannot see the other agent kind's file.

## 6. Workflow plan — `issue reconcile --workflow`

| Invocation | Keys read | Consumer |
|---|---|---|
| `issue reconcile --workflow [--dry-run] [--reviewer <a>] [--review-aging-ms <n>] [--max-actions <n>] --board-limit <n>` | `data.scanned`; `data.workflow.actions[]`, `.alerts[]`, `.changes[]`, `.summary` | `board.mjs#runWorkflowPass` → `runners.mjs#runWorkflowTick` |

The plan is snake_case (`workflowToWire`). Action `type`s the loop executes:

| `type` | Meaning |
|---|---|
| `create_review` | create the review card (`original_ref`, `project_id`, `reviewer`, `round`, `idem`, `target`, `title`, `description`, `acceptance[]`). `acceptance[]` is the original's frozen baseline followed by the generic review items (2 for a card, 3 for an epic), and becomes the review card's own frozen baseline |
| `auto_accept` | close a no-review original (`original_ref`, `accepted_by`, `round`) |
| `approve` | apply an APPROVE verdict to an `agent` original and close its review card (`close_review` follows last) |
| `reject_task` / `reject_epic` / `reject_task_finish` | apply a REJECT verdict; the epic form also creates a fix child |
| `close_review` / `cancel_review` | close the review card last |

Alert `type`s include `original_unseen`, `verdict_unreadable`, `verdict_incomplete`,
`acceptance_incomplete`, `acceptance_unverified`, `review_aging`, `actions_capped`,
`dispatch_capped`, `self_review_not_independent`. Each carries a `dedup_key`. The acceptance/verdict alerts are log-only: the planner
declines to plan an action the write gate would refuse, rather than producing one failure per
tick. An epic's skip reasons are `rollup_unverified` (no current-round rollup) and
`rollup_stale` (the rollup no longer matches the children); both appear on
`auto_accept_skipped` / `verdict_incomplete`.

An **epic's** only delivery report is its rollup: `report.is_rollup` is `true` on the wire,
its acceptance items carry `ref: <child identifier>`, and `done` / an `APPROVE` refuse a
missing or stale one (`ROLLUP_REQUIRED` / `ROLLUP_STALE`). The loop never writes a non-rollup
report on an epic.

## 7. Workflow writes

All writes use `--actor-kind taskd` and are idempotent by their key.

| Capability | Invocation | Keys read |
|---|---|---|
| create a review card | `issue create --project <p> --kind task --title … --description … --assignee <reviewer> --assignee-kind agent --label review --meta flow=B --review-of <original> --review-round <n> --target <t> --idem <key> --acceptance <text>…` | `data.task.identifier` |
| create a rework child | `issue create --project <p> --kind task --title … --description … [--assignee-id <id>] --acceptance-mode off --meta rework_of=<original> --meta rework_round=<n> --target … --idem …` | `data.task.identifier` |
| list relations | `relation list <ref>` | `data.children[].target` |
| link a parent | `relation add <ref> --type parent --target <child>` | `ok` only |
| merge metadata | `issue meta <ref> --meta k=v …` | `ok` only |
| move | `issue move <ref> <status>` | `ok` only |
| comment | `comment add <ref> --kind note\|change --body <text>` | `ok` only |

`issue meta` **merges**; `issue update --meta` replaces the whole object and would
erase `target` and the review keys. Use `issue meta`. The acceptance baseline is a column,
immune to `--meta`, and a **changed** `meta.acceptance` / `meta.acceptance_legacy` is refused
(`VALIDATION_FAILED`) — append with `issue update --acceptance`, prune only as a human with
`--drop-acceptance --reason`.

## Questions — the `awaiting` protocol

A worker that cannot proceed asks and stops:

```bash
taskctl issue move <ref> awaiting --awaiting-reason E2 --question "what you need to know" <attribution>
```

The move and the `question` comment are one transaction; the loop never writes a decision
kind. The card's `awaiting_reason` stays the category (`E1`–`E5`); the question is the payload
(`waitingPayload`, the newest `question`). Entry, exits and the resume rule:
[`status-lifecycle.md` §1](status-lifecycle.md#1-the-vocabulary).

Who answers what the loop cannot: `--opened-by human` means the control turn may ask its own
operator in that conversation; the default (`supervisor`, for systemd/launchd/cron) leaves the
card `awaiting` for the human's comment.

### The subagent's file surface

The loop itself never downloads an attachment. The handoff tells a worker/reviewer to keep
everything it produces — including downloaded attachments — under `.meerkat/<identifier>/`:

```bash
taskctl attachment list <ref> --json                 # id + filename
taskctl attachment download <attachment-id> --out .meerkat/<identifier>/<filename>
```

`download` is the byte half of `add`; it writes to an existing parent directory and returns
`data.{attachment_id,out,size,content_type}`. `card.md` in that directory is the loop's export
and is never edited by the subagent.

## 8. Live stream — `events follow` (hub) / `events tail` (direct)

| Invocation | Output | Consumer |
|---|---|---|
| `events follow [--after <rev>] [--idle <ms>]` | NDJSON lines from the local event hub | `runtime.mjs#streamCli` → `subscribe.mjs` |
| `events tail [--after <rev>] [--idle <ms>]` | NDJSON lines from a direct board SSE | diagnostics only; not a background consumer |
| `events hub` | the foreground hub process | started on demand by `follow`/`watch` |

The hub is per user and per board, binds loopback, publishes an owner-only pointer, and owns
the single board connection (and its reconnect ladder). `events follow` reconnects to the hub
and replays from its bounded ring when the cursor is still retained; an older cursor starts
live. The loop reads `type` on every line and `event.id` as the board revision, passing the
maximum back as `--after` to resume; `open` means the stream answered. The line shapes, the
exit semantics and the 15 s heartbeat / 45 s idle defaults are in
[`cli.md#events`](cli.md#events).
