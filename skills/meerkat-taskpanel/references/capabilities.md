# Board capabilities a supervisor binds to

[`cli.md`](cli.md) is the complete `taskctl` reference. This page is the **subset a
supervisor uses**, with the exact invocation and the JSON keys it reads. It is the
contract behind `scripts/loop/board.mjs` and `scripts/loop/passes.mjs` in the
`meerkat-loop` skill: the loop decides *when*; these are the *how*.

> Paths written as `scripts/loop/…` or `src/…` name the source repositories. This skill ships
> only `SKILL.md`, `references/` and `scripts/`; the loop body under `scripts/loop/` is the
> generated copy in the `meerkat-loop` skill.

> The loop never calls the board's HTTP API directly. Every operation below —
> including the live event stream — is a `taskctl` command.

## The invocation rule

```text
taskctl --json --agent <agent> --actor-kind <kind> [--env-file <p>] [--url <u>] <group> <command> …
```

- `--actor-kind` is required. The loop uses the actor kind (`claude`, `codex`,
  `pi`, `opencode`, `cursor`) for reads and claims, and `taskd` for the workflow
  writes so an automated acceptance is attributable to the board, not a human.
- The token rides in `TASKD_TOKEN` in the child environment, never on argv.
- stdout is `{ok:true,data}` or `{ok:false,error{code,message,http,details,hint}}`;
  exits are 0 ok, 1 runtime, 2 usage, 3 `export md --check` differences.
- **`events tail` is the one exception**: it writes newline-delimited JSON, not
  the envelope (see §8).

## 1. Interface floor — `--version`

| Invocation | Keys read | Consumer |
|---|---|---|
| `taskctl --version --json` | `data.version`, `data.schema_version` | `scripts/board-check.mjs` |

## 2. Project rows — `project list`

| Invocation | Keys read | Consumer |
|---|---|---|
| `taskctl --json … project list` | `data.projects[].id`, `.name`, `.reviewer`, `.review_policy` | `board.mjs#readProjectReviewers` → poll's reviewer merge and the workflow pass's `required` check |

`reviewer` is the project's override; `review_policy` is `off` / `optional` /
`required`. The board resolves the effective reviewer per card
(`project.reviewer ?? deployment reviewer`).

## 3. Candidate scan and atomic claim

| Invocation | Keys read | Consumer |
|---|---|---|
| `issue candidates --assignee <agent> [--include-unassigned] [--stale]` | `data.candidates[]` | poll's scan |
| `issue claim <identifier>` | only `ok` / `error` | poll's claim |

Candidate tuple: `id`, `identifier`, `title`, `status`, `priority`, `project`,
`sort`, `reason`, `review_of`, `review_round`. `review_of` is non-null only for a
review card; a dedicated reviewer is given only those.

`issue claim` is the one claim path: it claims a ready `todo` card and performs
the stale re-claim/takeover that the transition table cannot express. A refused
claim never enqueues a handoff — and the handoff is only produced by the resident
pool, so a claim made without a pool starts no worker.

## 4. Board read — `issue list`

| Invocation | Keys read | Consumer |
|---|---|---|
| `issue list --limit <board-limit>` | `data.tasks[]` | the legacy stale-heartbeat patrol |

The patrol reads `identifier`, `status`, `heartbeat_at`, `claimed_by_actor`,
`assignee`. Truncation is inferred when `tasks.length >= board-limit`.

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
| `issue reconcile --workflow [--dry-run] [--reviewer <a>] [--auto-accept-reviews yes\|no] [--review-aging-ms <n>] [--max-actions <n>] --board-limit <n>` | `data.scanned`; `data.workflow.actions[]`, `.alerts[]`, `.changes[]`, `.summary` | `board.mjs#runWorkflowPass` → `runners.mjs#runWorkflowTick` |

The plan is snake_case (`workflowToWire`). Action `type`s the loop executes:

| `type` | Meaning |
|---|---|
| `create_review` | create the review card (`original_ref`, `project_id`, `reviewer`, `round`, `idem`, `target`, `title`, `description`, `acceptance[]`). `acceptance[]` is the original's frozen baseline followed by the generic review items (2 for a card, 3 for an epic), and becomes the review card's own frozen baseline |
| `auto_accept` | close a no-review original (`original_ref`, `accepted_by`, `round`) |
| `approve` / `approve_hold` | apply an APPROVE verdict; `_hold` leaves a top-level original `in_review` under `human-only` |
| `reject_task` / `reject_epic` / `reject_task_finish` | apply a REJECT verdict; the epic form also creates a fix child |
| `close_review` / `cancel_review` | close the review card last |

Alert `type`s include `original_unseen`, `verdict_unreadable`, `verdict_incomplete`,
`acceptance_incomplete`, `acceptance_unverified`, `review_aging`, `actions_capped`,
`dispatch_capped`, `self_review_not_independent`, and the `review_cards_unclosable` startup
warning. Each carries a `dedup_key`. The acceptance/verdict alerts are log-only: the planner
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
| create a rework child | `issue create --project <p> --kind task --title … --description … [--assignee-id <id>] --review yes\|no --meta rework_of=<original> --meta rework_round=<n> --target … --idem …` | `data.task.identifier` |
| list relations | `relation list <ref>` | `data.children[].target` |
| link a parent | `relation add <ref> --type parent --target <child>` | `ok` only |
| merge metadata | `issue meta <ref> --meta k=v …` | `ok` only |
| move | `issue move <ref> <status>` | `ok` only |
| comment | `comment add <ref> --kind note\|change --body <text>` | `ok` only |

`issue meta` **merges**; `issue update --meta` replaces the whole object and would
erase `target` and the review keys. Use `issue meta`. The acceptance baseline no longer
lives in meta (0032): it is a column, immune to `--meta`, and a **changed**
`meta.acceptance` / `meta.acceptance_legacy` is refused (`VALIDATION_FAILED`) — append with
`issue update --acceptance`, prune only as a human with `--drop-acceptance --reason`.

## Questions — the `awaiting` protocol (0034)

A worker that cannot proceed asks and stops:

```bash
taskctl issue move <ref> awaiting --awaiting-reason E2 --question "what you need to know" <attribution>
```

The move and the `question` comment are one transaction. **Any human comment** answers it —
whatever its kind — and the board moves the card to `todo` in the same transaction (the
asking subagent is gone, so only the queue can dispatch the next one). The board does not
read the text: the resumed worker judges from its content whether it is a complete decision
(approve, reject, or ask again), and the loop never writes a decision kind. A `decision` /
`confirm` / `change` kind is the explicit I5 record, not the resume gate. The card's
`awaiting_reason` stays the category (`E1`–`E5`); the question is the payload
(`waitingPayload`, the newest `question`).

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

## 8. Live stream — `events tail`

| Invocation | Output | Consumer |
|---|---|---|
| `events tail [--after <rev>] [--idle <ms>]` | NDJSON lines (below) | `scripts/loop/runtime.mjs#streamCli` → `subscribe.mjs` |

```json
{"type":"open"}
{"type":"event","id":12,"data":{"event":"task_created","task_id":"…","actor_kind":"human","actor_id":"terry","changes":{},"revision":12,"created_at":"…"}}
{"type":"idle","data":{"idle_ms":45000}}
{"type":"shutdown","data":{"reason":"server_shutdown"}}
{"type":"eof"}
{"type":"error","data":{"code":"CLI_IO","message":"…"}}
```

`event.id` is the board revision; pass the maximum back as `--after` to resume.
`open` means the board answered; `idle`, `shutdown` and `eof` exit 0, `error`
exits 1. The server sends a heartbeat every 15 s; `--idle` defaults to 45 s.

## Capability → loop consumer

| Capability | Loop wrapper | Reads |
|---|---|---|
| `--version --json` | `skills/meerkat-loop/scripts/board-check.mjs` | version floor |
| `project list` | `board.mjs#readProjectReviewers` | reviewer overrides, `required` policy |
| `issue candidates` | `passes.mjs` (poll) | candidates |
| `issue claim` | `passes.mjs` (poll) | ok/error |
| `issue list` | `board.mjs#readBoard` | heartbeat rows |
| `sla list` / `sla get` | `board.mjs#runSlaPass` | alert rows |
| `issue reconcile --workflow` | `board.mjs#runWorkflowPass` | the plan |
| workflow writes | `board.mjs#runWorkflowPass` | created refs / ok |
| `events tail` | `runtime.mjs#streamCli` → `subscribe.mjs` | activity stream |
