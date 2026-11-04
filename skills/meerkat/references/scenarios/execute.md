# Claiming and delivering a card

This page is complete for the claim → deliver cycle; do not read the other scenario pages.
The acceptance-list rule is the universal core's
[`The acceptance list is the contract`](../../SKILL.md#the-acceptance-list-is-the-contract);
read it before you deliver.

## The cycle

Read the claimable set for *you*, take exactly one, then work it:

```bash
taskctl issue candidates --assignee <me>       # read-only: what may I claim?
taskctl issue move <ref> in_progress           # claim exactly one
taskctl issue get <ref> --json                 # description + the frozen acceptance snapshot
taskctl issue heartbeat <ref>                  # keep the claim fresh (at least every 10 minutes)
taskctl report template <ref>                  # fill the TODO lines
taskctl issue deliver <ref> --report-file -    # report + in_review, one transaction
```

Then **stop**: acceptance is somebody else's act. A card held by someone else, or still in
`backlog`, is not yours; the board refuses.

## The one silent exclusion: dependencies

`issue candidates` withholds a card whose `depends_on` (reversed `blocks`) predecessor is not
`done` — a `canceled` predecessor withholds it too. The claim verb does not re-check blockers
unless `--check-blockers`; a direct claim can take a blocked card. If a card you expected is
missing, run `taskctl relation list <ref>`.

## Heartbeat

A heartbeat resets the claim and **nothing else** — not status, not claimer, not the delivery
round — and only the holder may send it. A claim you stop pulsing reads as abandoned.

## Delivering

`issue deliver` writes the report and moves to `in_review` in one transaction; the gate reads
the **current** delivery round's report — an earlier round is history, so re-deliver rather
than reuse it. A waiver (`--no-report --reason "<why>"`, ≥ 8 characters) excuses the report
for one round, not acceptance.

The mode is resolved once, at creation: `--acceptance-mode off|auto|human`; omitted, it falls
back to `auto`. There is no project default — `create.md` explains the project's
`docs/agents/create-card.md`. An `off` card may go straight from `in_progress` to `done`;
`auto` and `human` are both reviewed; the loop accepts an `auto` card on `APPROVE`, and a
person closes a `human` card after its review finishes. An epic is reviewed against its
children and rollup and closed only after an `APPROVE`. An agent may only tighten a mode
(`off → auto|human`); a review card is always `off`.

On an `agent` card each `met` item's `note` must cite an anchor from the report's own
`evidence[]`, written `evidence[n]` (1-based). The template seeds the note with `evidence[1]`.
A `met` with no reference (`no_anchor`) or one past the end (`dangling_anchor`) is
`ACCEPTANCE_INCOMPLETE`; an empty evidence list makes every reference dangle.

## The card's session row (manual claim)

The drawer's Sessions tab is data-driven: a conversation is visible only when a row exists.
A card **you claimed yourself** registers its own row once, right after the claim, and closes
it at delivery:

```bash
taskctl session set <ref> --seg manual --owner <name> --owner-kind <kind> \
  --phase <phase> --goal "<what this conversation is doing>"
taskctl session close <ref> --seg manual --owner <name>
```

One row per card per segment, across rounds. A **supervisor-dispatched** card is already
claimed by the loop, which registers and closes its own `worker`/`reviewer` row — do not
register a second one there.

## Handoff

A producer card that hands work on follows `../../SKILL.md#stage-markers`: set
`meta.stage_handoff=required` and put a `## Handoff` block in this round's report.

<!-- read-next:begin -->
- [`../lifecycle/claims.md#5-claims-and-heartbeats`](../lifecycle/claims.md#5-claims-and-heartbeats)
- [`../lifecycle/delivery.md#4-the-delivery-gate-and-the-delivery-round`](../lifecycle/delivery.md#4-the-delivery-gate-and-the-delivery-round)
- [`../lifecycle/delivery.md#4a-the-acceptance-baseline`](../lifecycle/delivery.md#4a-the-acceptance-baseline)
<!-- read-next:end -->
