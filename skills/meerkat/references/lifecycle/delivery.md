# The delivery gate and the delivery round

> Sections 4 and 4a. Claims are `claims.md`; the acceptance modes are `acceptance.md`.

## 4. The delivery gate and the delivery round

A card may not enter `in_review` without evidence **for the current delivery round** — a
report counts only for the round it was written in.

- A report for the card's current `delivery_round`. Every report counts, whether written live
  or imported as history.
- **A path anchor must name its commit.** If the report's evidence contains a `path` anchor it
  must also contain a `commit` anchor (`DELIVERY_NEEDS_COMMIT`): a path is a claim about the
  working tree, and an uncommitted tree can be stashed or reset before the reviewer reads it.
  The board checks the shape only — the reviewer verifies that the sha resolves and that every
  path exists at it. Review cards and epics are exempt (a reviewer's paths name what it read;
  a container's evidence is its rollup union, whose children passed the same gate). A waiver
  carries no evidence, so the rule does not apply to it.
- The escape hatch is the **audited waiver**: `--no-report --reason "<why>"` on a move to
  `in_review` (or on `issue deliver`). The reason needs at least **8 characters** after
  trimming; the waiver is stamped on the task row, recorded as a `report_waived` activity and
  shown in `issue get` under `report_waivers[]`. It covers only its round.
- `--no-report` and `--report-file` are mutually exclusive; `--no-report` anywhere else is
  `VALIDATION_FAILED`.

| Move | Round |
|---|---|
| create | `1` |
| entering `in_review` | unchanged |
| `in_review → in_progress` | **+1** |
| `in_review → blocked` | **+1** |
| `in_review → done` | unchanged |
| `awaiting → in_progress` | unchanged |
| `awaiting → todo` | unchanged (an answer re-queues; not a reopen) |
| everything else | unchanged |

A rework voids the previous report **and** waiver; the next delivery needs fresh evidence.

The compliant path writes the report and moves atomically:

```bash
taskctl report template <ref>                 # fill the TODO lines
taskctl issue deliver <ref> --report-file -   # lands in in_review
taskctl issue deliver <ref> --report-file - --to done   # an `off` card's direct acceptance
```

A report with an explicit non-current `round` is `REPORT_ROUND_MISMATCH` — a report-write
error, not a move refusal. A refusal names the round and the fixing command; the exact text is
in [`cli/issue.md#the-delivery-gate`](../cli/issue.md#the-delivery-gate).

## 4a. The acceptance baseline

Each card carries a frozen acceptance baseline: `tasks.acceptance_json` (`acceptance[]` on the
wire) plus a monotonically increasing `acceptance_revision`. `meta.acceptance` is only the
**seed** — `create` and the first claim copy it (and the imported `acceptance_legacy` texts)
into the snapshot; the gates never read meta. The end-to-end edit sequence (append,
description replacement, human prune) is [`../scenarios/edit.md`](../scenarios/edit.md).

- **Append only.** `issue update <ref> --acceptance "…"` appends; duplicates (normalized text)
  are ignored. There is no replace. Removing an item is a **human-only audited prune**:
  `--drop-acceptance "…" --reason "<why>"` (≥ 8 characters, recorded as `acceptance_pruned`),
  optionally guarded by `--acceptance-revision <n>` (`ACCEPTANCE_STALE_REVISION` on a stale
  read).
- **Locked once delivered.** `in_review` and the terminal states refuse any snapshot change
  (`ACCEPTANCE_LOCKED`); rework first. A `done`/`canceled` reopen does not change the baseline.
- **The DB enforces the same rules**: any rewrite must bump `acceptance_revision` exactly once
  (`ACCEPTANCE_SNAPSHOT_IMMUTABLE`), and a removed/rewritten old item needs an
  `acceptance_pruned` activity with a reason (`ACCEPTANCE_PRUNE_FORBIDDEN` in the app;
  the trigger raises the same `ACCEPTANCE_SNAPSHOT_IMMUTABLE`).
- **The gate.** Moving to `done` reads the current round's `delivery` report and checks it
  against the snapshot. No report → `ACCEPTANCE_UNVERIFIED` (a `--no-report` waiver excuses
  the delivery gate, not acceptance). Every baseline item must appear; `met` and
  `not_applicable` (with a non-empty note) pass, `partial` / `not_met` block. A report item
  **beyond** the baseline also blocks if it is `partial` / `not_met` — the report itself says
  work is unfinished. Empty baseline → vacuous, allowed: the rule is "once non-empty, it
  cannot be shortened", not "every card must have criteria".
- **A `met` must point at its evidence.** On an `auto` or `human` card the gate also reads the report's
  `evidence[]`: each `met` item's note must cite at least one `evidence[n]` that resolves
  within that list, or the item is `unsupported` (`no_anchor` / `dangling_anchor`) and the gate
  refuses with `ACCEPTANCE_INCOMPLETE` (`details.unsupported`). This is structural — it forces
  the pointer, not the truth of the pointer. The judgement behind it is the reviewer's: a
  claim that cannot be reproduced is `not_met`, never `met`, and `partial` does not soften a
  requirement that was not implemented. An `off` or `human` card keeps the lighter contract
  (matching items, statuses and notes). `deliver` applies the same rule before it writes the
  row (`details.source = "delivery"`): a report is bound to its round and cannot be amended, so
  an anchorless `met` is cheaper to refuse at the writer than to discover after a review.
- **Reviews.** An `APPROVE` on a review card is checked against the original's snapshot (and
  the review card's own) before it can close anything, and the review report must carry at
  least one `command` anchor — the reviewer runs the gate itself, so an APPROVE that ran
  nothing is refused (`ACCEPTANCE_INCOMPLETE`, `details.reason = "no_command_evidence"`); see
  [`review-workflow.md`](../review-workflow.md).
- **Epics.** A container's own snapshot is informational; its acceptance fact is the current
  round's rollup over its children (§6).

The engine guarantees coverage of the written baseline. It cannot guarantee that the baseline
itself covers everything in the description or the plan — that stays the reviewer's omission
check: every requirement in the description, comments and `.meerkat/<id>/plan.md` must map to
an acceptance item and evidence, or be explicitly deferred. A missing plan is not itself a
failure (fall back to the description and snapshot); an unexplained deviation from an existing
plan is. `meta.acceptance_derived = "yes"` is a flag to audit the list closely, not the only
case that needs the check.
