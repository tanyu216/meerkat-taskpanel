# Claiming and delivering a card

This page is complete for the claim → deliver cycle; do not read the other scenario pages.
Read the universal core's
[`The acceptance list is the contract`](../../SKILL.md#the-acceptance-list-is-the-contract)
rule first.

## The cycle

Take exactly one claimable card for *you*, then work it:

```bash
taskctl issue candidates --assignee <me>       # read-only: what may I claim?
taskctl issue move <ref> in_progress           # claim exactly one
taskctl issue get <ref> --json                 # description + the frozen acceptance snapshot
taskctl issue heartbeat <ref>                  # keep the claim fresh (at least every 10 minutes)
taskctl report template <ref>                  # fill the TODO lines
taskctl issue deliver <ref> --report-file -    # report + in_review, one transaction
```

Then **stop**: acceptance is somebody else's act. Someone else's card, or a `backlog` one, is
not yours.

## The one silent exclusion: dependencies

`issue candidates` withholds a card whose `depends_on` (reversed `blocks`) predecessor is not
`done`; a `canceled` predecessor withholds it too. A direct claim does not re-check blockers
unless `--check-blockers`, and can take a blocked card. A missing card:
`taskctl relation list <ref>`.

## Heartbeat

A heartbeat resets the claim and **nothing else** — not status, not claimer, not the delivery
round — and only the holder may send it; an un-pulsed claim reads as abandoned.

## Delivering

`issue deliver` writes the report and moves to `in_review` in one transaction; the gate reads
the **current** delivery round's report — re-deliver rather than reuse an earlier one. A waiver
(`--no-report --reason "<why>"`, ≥ 8 characters) excuses the report for one round, not acceptance.

The mode is fixed at creation (`--acceptance-mode off|auto|human`, default `auto`; no project
default). An `off` card may go straight from `in_progress` to `done`; `auto` and `human` are
reviewed — the loop accepts `auto` on `APPROVE`, a person closes `human`. An epic is reviewed
against its children and rollup. An agent may only tighten a mode; a review card is always
`off`.

On an `agent` card each `met` item's `note` cites an anchor from the report's own `evidence[]`,
written `evidence[n]` (1-based; the template seeds `evidence[1]`). A missing reference
(`no_anchor`) or one past the end (`dangling_anchor`) is `ACCEPTANCE_INCOMPLETE`.

## The card's session row (manual claim)

A card **you claimed yourself** registers its row once with
`taskctl session set <ref> --seg manual --owner <name> --owner-kind <kind>`, then closes it at
delivery with `taskctl session close <ref> --seg manual --owner <name>`. One row per card per
segment, across rounds; a **dispatched** card's `worker`/`reviewer` row is the loop's.

## Handoff

A producer card that hands work on follows `../../SKILL.md#stage-markers`: set
`meta.stage_handoff=required` and put a `## Handoff` block in this round's report.

<!-- read-next:begin -->
- [`../lifecycle/claims.md#5-claims-and-heartbeats`](../lifecycle/claims.md#5-claims-and-heartbeats)
- [`../lifecycle/delivery.md#4-the-delivery-gate-and-the-delivery-round`](../lifecycle/delivery.md#4-the-delivery-gate-and-the-delivery-round)
- [`../lifecycle/delivery.md#4a-the-acceptance-baseline`](../lifecycle/delivery.md#4a-the-acceptance-baseline)
<!-- read-next:end -->
