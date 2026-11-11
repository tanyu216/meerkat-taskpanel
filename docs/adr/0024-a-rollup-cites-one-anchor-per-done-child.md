# 0024 — A rollup cites one anchor per done child

**Status:** Proposed

## Context

An epic's rollup used to take the **union** of its children's current-round evidence.
Two problems followed from that shape:

1. The union is unbounded by construction. TP-0035 had seven children whose reports
   together held 86 anchors; `REPORT_MAX_ITEMS` is 64, so `normalizeReportCreate`
   refused the rollup and the epic could never close. The first repair (`b7760ca2`)
   capped the union at 64 and said so in the conclusion — but a union has no
   provenance, so the cap silently dropped the later children's anchors.
2. Nothing tied an evidence anchor to the acceptance item that claimed it. A rollup
   could list a `done` child as `met` while every anchor came from one other child,
   and the gate (`rollupGapOf`) only joined `ref` and status. Epics were also exempt
   from the delivery gate's `evidence[n]` rule, so no layer asked the question.

The fan-in cap (`RELATION_FANIN_MAX = 8`) already bounds what a rollup *needs*: one
pointer per delivered child. The union was the only reason a report could outgrow
its own limits.

## Decision

A rollup's evidence is **one representative anchor per `done` child**:

- The anchor comes from that child's report for its **current delivery round**. Its
  kind is chosen by `EVIDENCE_KINDS`' strength order — `commit` > `path` > `command`
  > `coverage` — and the first anchor of the strongest kind wins.
- The child's acceptance item is `met` and its note cites that anchor as
  `evidence[n]` (1-based into the rollup's own `evidence[]`). Two children that
  stand on the same anchor share one index.
- A child delivered under `--no-report` contributes no anchor; its line carries the
  explicit marker `no delivery evidence on the child card` instead of inventing one.
- `rollupGapOf` judges the pointer: a `done` child whose `met` item cites no
  resolving anchor and carries no marker is `uncitedChildren`, and the rollup is
  `ROLLUP_STALE`. The same pure rule serves the write gate, the reconcile sweep and
  the workflow planner.
- `report template <epic>` pre-fills each done child's line with its anchor index, so
  the manual path produces a passing rollup by filling it in.

The report limits are unchanged: `REPORT_MAX_ITEMS = 64`, `REPORT_MAX_BYTES = 64 KiB`,
`REPORT_MAX_CONCLUSION_CHARS = 16 384`. The new shape cannot reach them — a rollup
has at most `RELATION_FANIN_MAX` evidence items.

## Alternatives considered

- **Keep the union, raise or remove the cap.** Treats the symptom: the report stays
  provenance-free, so no reader can tell which child an anchor belongs to, and an
  unbounded payload is a different failure.
- **Keep the first K anchors per child.** Bounded, but K is arbitrary, the report
  still has dead weight, and nothing forces the child's acceptance line to point at
  any of them.
- **Add a `child` field to every anchor.** Restates `ref` plus the item's position;
  two sources of truth for the same relationship.
- **Store provenance in the database.** A migration and a new column to encode a
  relationship the report already carries once the item cites its anchor.

## Consequences

- A rollup in flight written under the old shape becomes `ROLLUP_STALE`; the repair
  is the normal one — rework the epic and roll up again. No backfill, no grandfather.
- The CLI's manual template needs the children's reports (at most eight bounded
  reads); a card with no `git` still degrades to the existing evidence flags.
- No schema, wire or contract change: `evidence[]`, item notes and `ROLLUP_STALE`
  are the existing surface. The marker is a constant, not a new error code.
- A reviewer can check the aggregate by following each child's `evidence[n]` into the
  rollup, then the anchor into the child's own round.
