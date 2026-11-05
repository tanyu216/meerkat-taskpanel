# The loop's seams: decision, execute, observe

The supervisor is one process doing three kinds of work. Naming the kind for
each module is what keeps a judgement out of a writer and a write out of a
reader — the same shape `docs/scheduling.md` uses for the passes, applied to the
code.

## The three seams

**Decision** — reads facts, returns a judgement, writes nothing. It takes its
inputs as arguments (no file, no child process, no board call) and its result is
a value the caller can assert on:

- `src/foundation/scheduling.mjs` — `planTick`, `planPatrol`, `planClaimIdentity`,
  `planWorkflowTick`, `planReviewDispatch`, `planReviewOutcomes`.
- `src/foundation/role-platforms.mjs`, `role-prompt.mjs`, `role-catalog.mjs` — role
  resolution and prompt assembly.
- `src/foundation/loop-state.mjs` — `poolVerdict`, `wedgeKillAction`.
- `src/foundation/cycle-status.mjs` — `cycleVerdict`, `CYCLE_LEVELS`.
- `src/foundation/role-tools.mjs` — the lane → tools table.

**Execute** — performs a write and makes no judgement of its own. It is given the
decision it must carry out; it never re-decides whether to:

- `src/orchestrator/actor-kinds/*`, `kind-session.mjs` — process and session I/O.
- `src/orchestrator/holds.mjs`, `workspace.mjs`, `queue.mjs`, `boot-health.mjs` —
  board moves, worktrees, the durable queue, the boot ledger.

**Observe** — reads and reports; never writes, claims or dispatches:

- `src/orchestrator/doctor.mjs`, `console.mjs`, `card-watch.mjs`.

## Mixed modules

Most modules do two of the three. A mixed module must put its decision in a
**named function that returns a value**, and keep the I/O at the call site. The
rule is what makes the judgement testable and greppable; it is not a demand to
split the file.

- `src/orchestrator/status.mjs` — probe (execute) around `poolVerdict` (decision).
- `src/orchestrator/role-sync.mjs` — install (execute) around role planning
  (decision).
- `src/orchestrator/runners.mjs` — `runWorkflowTick` and `runPollTick` carry the
  loop's dispatch and workflow execution around the `scheduling.mjs` plans.
- `src/orchestrator/passes.mjs` — the passes read the board and call the plans.
- `src/orchestrator/session.mjs` — the resident pool executes; its bounds
  (`DIRECTOR_MAX_ATTEMPTS`) are named constants.
- `src/orchestrator/board.mjs` — the board adapter.

## Adding or changing a seam

1. New code picks one of the four kinds. A judgement buried in a writer is a
   defect, not a style choice.
2. A new bound is a constant with one home; `test/contract/recovery-inventory.test.mjs`
   pins the values `docs/scheduling.md` promises.
3. A new settled level or tool lane changes the foundation table first, then the
   consumers (`test/contract/cycle-verdict.test.mjs`,
   `test/foundation/role-tools.test.mjs`).
4. An observe module that starts writing has changed kind; update this page with
   the change.
