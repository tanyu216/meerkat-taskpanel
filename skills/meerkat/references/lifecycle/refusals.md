# Refusals and enforcement

> Sections 9–10. The status vocabulary and the whitelist are `transitions.md`.

## 9. Refusals

| Code | HTTP | When |
|---|---|---|
| `INVALID_TRANSITION` | 409 | The pair is not on the whitelist; `PATCH {status}`; heartbeat on a non-`in_progress` card; `issue claim` on a status other than `todo`. |
| `TERMINAL_STATE` | 409 | The source is `done` or `canceled` and the target is not `todo` (or `deliver` is attempted from it). |
| `REPORT_REQUIRED` | 422 | Entering `in_review` without a current-round report or waiver; creating in `in_review`/`done`. |
| `ACCEPTANCE_FORBIDDEN` | 409 | The writer may not move the card to `done` under the card's `acceptance_mode`. |
| `CHILDREN_OPEN` | 409 | `in_review` or `done` while a child is non-terminal. |
| `REVIEW_PENDING` | 409 | A human closing a `human` card with current-round review cards still open, or leaving `auto` while one is open. |
| `REVIEW_REQUIRED` | 409 | An `auto` or `human` card reaching `done` with no APPROVE verdict for the current round. |
| `REVIEW_CARD_MARKER_INVALID` | 409 | A write tried to give a review card a non-`off` mode (flow B is never reviewed again). |
| `VALIDATION_FAILED` | 400 | Unknown status; create in `in_progress`/`awaiting`; an epic's illegal initial status; an unknown `awaiting_reason`/`blocked_reason`; a malformed waiver; a `review_of` whose original is not `in_review`; a `review_of` that names a review card; a `review_round` that is not the original's current `delivery_round`; a markerless `kind=review`; a `parent` edge with a review card on either end. |
| `ASSIGNEE_NOT_IN_CATALOG` | 400 | **CLI-only.** `issue create`/`issue assign` named an `--assignee` outside the local role catalog (`taskctl role list`) while the catalog is non-empty. `--force-create` admits it. A direct HTTP write never sees this check. |
| `ASSIGNEE_NOT_REVIEWER` | 400 | **CLI-only.** A review card (`--review-of`) named an assignee that is not a reviewer-lane role; the catalog's `default_reviewer` is the default. `--force-create`, `--assignee-id` and a human assignee are refused on a review card. |
| `VERSION_CONFLICT` | 409 | `--if-version` does not match the card's version. |
| `EXECUTION_ACTIVE` | 409 | Another actor holds a fresh claim, or a non-holder sends a heartbeat. |
| `CLAIM_LOST` | 409 | The claim's compare-and-swap lost a race. |
| `not_assignee` | 409 | A first claim of somebody else's `todo` card without `--allow-steal`. |
| `not_claimable` | 409 | A claim on an epic. |
| `EXECUTION_STATE_CORRUPT` | 500 | An `in_progress` work card has no holder (an unowned epic is the designed auto-start state). |
| `REPORT_ROUND_MISMATCH` | 409 | A report names a round other than the card's current round, or duplicates `(task, round)`. |

`status` is a **move, never a patch**: `issue update` has no `--status`, and `PATCH {status}`
is refused with `INVALID_TRANSITION`.

## 10. What is enforced, and what is practice

Skill prose is written against this split:

- **Enforced — loud.** The transition whitelist, the delivery gate, the terminal exits, the
  child-before-parent rule, the review-card invariants (no reopen, no parent/child, no review
  of a review), acceptance authority and claim routing are enforced by the domain
  **and** the database triggers. A refused write returns a named code and usually a fixing
  hint, so an agent acts on that instead of pre-checking the rule. Skill pages do not restate
  these.
- **Enforced — silent.** A write can succeed but do something other than its name suggests —
  `canceled` has no child guard, the create idempotency key collapses look-alike cards,
  `--parent` links nothing, and an epic auto-starts and auto-closes only from certain
  statuses. No refusal will teach these at the moment they matter, so the skill states them.
- **Not enforced — practice.** Three rules an agent must honour on its own:

| Rule | Kind |
|---|---|
| “One card at a time” | **practice** — not enforced |
| “Read candidates, then claim” | **practice** — only the claim gate is enforced |
| `depends_on` blocks claiming | **read rule** — candidates filters only |

The working list of silent traps is in [`epic.md`](../scenarios/epic.md); this section is the
classification they belong to.
