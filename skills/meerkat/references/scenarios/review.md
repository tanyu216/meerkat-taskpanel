# Reviewing a delivered card (flow B)

This page is the entry card for a review; do not read the other scenario pages. The protocol
itself is `../review-protocol.md` — this page only tells you when it applies and what the
delivery must start with.

## Is this a review card?

A card is a review card when `issue get <ref> --json` carries `review_of_id` / `review_round`
(or `issue candidates --json` carries `review_of` / `review_round`). The `review` label is a
discovery aid, never the predicate. `meta.flow` absent means flow A; a flow-B card is never
reviewed again.

A review card the supervisor dispatched is already claimed by the loop: the handoff says so —
heartbeat it, do not re-claim. A review card you picked up interactively from `issue
candidates` is claimed like any `todo` card.

## The sequence

1. Ledger every requirement in the description, comments and plan to an acceptance item and
   an implementation; a missing one is a `REJECT`.
2. Verify at the report's `commit` anchor, not the live tree.
3. Answer every baseline item with a status, how you checked it, and an `evidence[n]`
   anchor. An `APPROVE` must record at least one command you ran.
4. Deliver a report **on this card** whose first line is exactly `VERDICT: APPROVE` or
   `VERDICT: REJECT`; put findings and `leftovers` after it.
5. Move neither card — the loop applies the verdict and closes the review card.

<!-- read-next:begin -->
- [`../review-protocol.md#2-the-review-cards-identity`](../review-protocol.md#2-the-review-cards-identity)
- [`../review-protocol.md#3-the-reviewers-protocol`](../review-protocol.md#3-the-reviewers-protocol)
- [`../review-protocol.md#6-what-happens-after-a-delivery`](../review-protocol.md#6-what-happens-after-a-delivery)
<!-- read-next:end -->
