# Scheduling integration

This reference is for whoever **owns the clock**: a host framework, an external scheduler
(cron / launchd / systemd), or a service that drives the board. It states the board-side
contract only. The loop's own clocks, entries and scheduling units change over time and
are documented by the [`meerkat-loop`](https://github.com/tanyu216/meerkat-taskpanel/blob/main/skills/meerkat-loop/SKILL.md)
skill — read that skill (and its `references/operation.md`) for the current topology
instead of restating it here.

The board never starts work by itself. `taskctl` is an HTTP client for the local `taskd`
service; it starts one when there is none (`TASKD_NO_AUTOSTART=1` forbids that).

## Who owns the clock

Choose the deployment shape first:

| Shape | Who ticks | What to run |
|---|---|---|
| **Loop host** — Claude Code, Codex, Pi | the `meerkat-loop` skill | Nothing here. Do **not** add a second poller, and do **not** schedule the loop's entries individually. The loop owns its clocks and units; its skill is the authority. |
| **Framework is the scheduler** — OpenClaw, OpenCode, Cursor | the framework | The tick recipe below. On OpenClaw the established implementation is [openclaw-team](https://github.com/tanyu216/openclaw-team); do not hand-write a second one. |
| **Independent service** | the service | `taskctl --json` or the HTTP API. Do not treat an installed skill directory as a stable library path. |

**One launcher.** `scripts/run.mjs` is this skill's only launcher: it resolves the CLI
through a checked ladder (explicit root, host config, checkout, host shim, `PATH`), pipes
stdio, and propagates the exit code. A second launcher is a second resolution path that
can disagree with the host's identity. Call `taskctl` directly when the host shim already
pins your identity; call `node scripts/run.mjs` when you need the ladder.

## The tick recipe

One tick is always: **read → decide → claim → start a worker**. A slower pass looks for
work that is stuck. Neither pass needs the loop.

```bash
# 1. read — read-only, no model, no claim
taskctl --json issue candidates --assignee <agent> --include-unassigned --stale

# 2. claim exactly one card — atomic compare-and-swap
taskctl --json issue claim <ref>

# 3. while the worker is alive — holder only, no body
taskctl issue heartbeat <ref>

# 4. slower pass — find stuck claims
taskctl --json issue list --status in_progress --limit 500
```

### 1. Read the claimable set

`issue candidates` is the board's own answer to "what may this agent claim?". It is
read-only, costs no model turn, and already accounts for dependencies, assignment, the
public pool, and stale recovery.

- `data.candidates` is the array. Each entry carries `id`, `identifier`, `title`,
  `status`, `priority`, `project`, `sort`, `reason`, `review_of`, `review_round`.
- `reason` is the bucket: `ready`, `unassigned`, `stale_same`, `stale_any`. Pass
  `--include-unassigned` to include the public pool and `--stale` to include
  stale-recovery candidates; without them the read is narrower.
- `epic` and `deploy` cards are deliberately excluded. A dispatcher never wakes a worker
  for a container or a deployment.
- There is **no `--limit` / `--offset`** on this read. It is a dispatch input, not a
  paginated listing.

A candidate names its `project`, **not a directory**. The board holds no project
directory. Resolve the worker's launch directory from the `projects.json` kept beside the
board skill (`local_path`, else `run_dir`); see
[projects-json.md](projects-json.md). A project with no usable directory must refuse the
wake, not run somewhere unintended.

### 2. Claim — and only then start a worker

`issue claim <ref>` is atomic: the whole decision runs in one transaction, so when several
ticks or agents race the same card exactly one succeeds. The loser starts **no** worker.

- One card per call. There is no batch claim; loop over the candidates you decided to
  take.
- `reused: true` is not an error — the same holder asking again keeps the claim.
- `EXECUTION_ACTIVE`, `not_assignee`, `not_claimable`, `VERSION_CONFLICT` and
  `CLAIM_LOST` are normal competition outcomes. They are **not** retry signals; move on to
  the next candidate.
- Claiming also performs stale recovery: the same holder after 30 minutes, any actor
  after 6 hours (audited with a `change` comment). Do not reimplement that policy.

Start exactly one worker **after** a successful claim, and never claim a card you will not
start.

### 3. Heartbeat while working

`issue heartbeat <ref>` refreshes the liveness marker. It takes no body, and only the
current holder may pulse it.

| Heartbeat age | Meaning |
|---|---|
| ≤ 10 minutes | fresh; the card is invisible to the next scan |
| > 30 minutes | stale; the same holder may re-claim, and patrol escalates |
| > 6 hours | any actor may take over |
| unreadable / absent | reported as `heartbeat-unreadable`; never silently ignored |

Pulse at least once per fresh window (for example every 5 minutes) for as long as the
worker runs.

### 4. Patrol read for stuck work

`issue list --status in_progress --limit 500` is the slow pass's read. Compute age from
`heartbeat_at` and escalate; do not move the card.

- The default limit is 200. There is **no time filter and no `--offset`**. If the returned
  array length equals the limit, the read is truncated — log that and do not present it as
  a complete board.
- `--assignee-id` takes an actor **id**, not a display name.

### Acceptance list

Before working, read the card with `taskctl issue get <ref> --json` — the human output omits
the description and the list. If `meta.acceptance` (or an imported card's
`meta.acceptance_legacy`) is non-empty, work to it and do not rewrite it. If both are empty,
derive 1–6 externally checkable acceptance items from the card, persist them with
`issue update <ref> --acceptance … --meta acceptance_derived=yes`, and leave a `change`
comment listing them. Never derive on an epic (its acceptance is its children) or a review
card; if the card is too thin, ask with `issue move <ref> awaiting --awaiting-reason E2`.
See the board skill's `SKILL.md` for the full rule.

### Progress and delivery

There is no `progress` command. While working, append a comment:

```bash
taskctl comment add <ref> --body "<progress>" [--kind change|decision|discuss]
```

Finish with a report; the board will not move a card to `in_review` without one for the
current delivery round:

```bash
taskctl report template <ref>
taskctl issue deliver <ref> --report-file -
```

`--no-report --reason "<why>"` is the narrow, audited waiver (see
[cli.md](cli.md#the-delivery-gate)).

### Push vs poll

There is no `events` / `watch` CLI command. For push, a service may read the HTTP SSE
stream at `GET /api/v1/events?after=<revision>`; cron-style integration polls instead.
An event may be the loop's own trigger for its continue turn — that is the loop's internal
mechanism, not an invitation to add a second dispatch path.

## SLA and workflow belong to the loop

The SLA rows, their thresholds, the working-hours window, the tier ladder and the
de-duplication ledger live in the loop (provenance: the repository's
`src/shared/sla-patrol.mjs`). This skill does not ship `src/`, so a copy of those numbers
would immediately drift. Do not reproduce them here or in a skill script.

- The loop's **patrol** entry is **notify-only**: no alert moves a card or starts a model
  turn for a new row.
- `--notify <cmd>` runs `<cmd>` once per patrol alert, with that alert as a JSON document
  on stdin. That is the supported way for an external sink to receive SLA alerts.
- Within the loop, the **workflow** entry is the only channel that writes cards
  (container reconcile, review dispatch, verdict application), and it writes as `system`.
  Do not copy that logic into a dispatcher.
- If you need SLA data, run the loop or consume its `--notify` output. Do not recompute
  the rows from `issue list`.

## The machine contract

Every integration should bind to these, not to prose or human output:

- `--json` success: `{"ok":true,"data":…}` on **stdout**.
- `--json` failure: `{"ok":false,"error":{"code","message","http","details","hint"}}` on
  **stdout** (not stderr). Warnings go to stderr and never pollute the JSON document.
- Bind to `error.code` and `error.hint.command`; never parse the message text.
- Exit codes: `0` success, `1` runtime or server refusal, `2` usage error, `3` an export
  `--check` difference. A non-zero exit is not always a failure of your loop — a refused
  claim is exit `1` with a conflict code.
- Identity: `--agent <name>` (or `$TASKCTL_AGENT`), `--actor-kind <name>` (or
  `$TASKCTL_ACTOR_KIND`; default `human`), and `--session-id <id>` (requires
  `--actor-kind`). The host shim installed beside this skill injects `--agent` and
  `--actor-kind`; `scripts/run.mjs` prefers that shim. If you call `taskctl` directly,
  pass them yourself.
- Concurrency: the atomic claim already serialises dispatch, so there is no lock file to
  create. Two ticks racing are wasteful, not incorrect. Cap the number of live workers
  yourself.

## The cron environment

This section applies to a cron line **you** write. The loop's own units already render
both of these concerns for their host.

- A scheduler starts a unit with a minimal `PATH` (cron typically `/usr/bin:/bin`), which
  contains no nvm and no Homebrew directory. Name the **absolute `node`**, and set a
  `PATH` whose head has the host CLI's directory and node's directory.
- `taskd` is started lazily once and then reused. Do **not** start or stop it on every
  tick. If something else guards it, leave it alone.
- `TASKD_NO_AUTOSTART=1` means "fail when no board answers", not "never reuse one". It is
  a client policy; do not put it on the `taskd` guard itself.
- The cost gate: an empty tick is one `issue candidates` read at $0. A model turn starts
  only after a claim succeeds.

## Periodic reports

`node scripts/report.mjs --period daily|weekly|monthly` is the existing example of a
policy-free upper-layer script in this skill. It reads `issue list --json`, aggregates and
renders; it adds no board query and no scheduling policy. Follow that shape for a report
job of your own, and keep its reading rules aligned with
[reports.md](reports.md).

## What not to build

- A second `taskctl` launcher (`scripts/run.mjs` already is one).
- A second poller on a loop host, or individually scheduled copies of the loop's entries.
- A copy of the SLA thresholds or the workflow policy in this skill.
- Claim/wake policy inside a skill script.
- Parsing human-readable output, or binding to message prose.
- A service that imports from an installed skill directory: it is a per-host copy with
  merge-never-clobber reinstall semantics, not a versioned library.

## Sources of truth

- `references/cli.md` — command semantics, the delivery gate and the `--json` contract.
- The repository's `docs/contract.md` — the frozen HTTP surface (`schema_version`).
- The `meerkat-loop` skill — the scheduler's clocks, entries, units and flags.
- The repository's `docs/scheduling.md` — the host-agnostic loop design.
