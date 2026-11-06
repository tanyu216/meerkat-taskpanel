# Worker — pre-delivery self-check

Run this audit in both modes — a card delivery or a no-card report — before delivering the work.
A card-only item is recorded `not_applicable — no card`. Every item ends with one of `met`, `not_applicable`,
`partial`, `not_met` or `leftover` and a pointer to the evidence. A `partial` is closed and
re-run; a `leftover` names its owner and its card. An out-of-scope defect is filed by its
finder in `backlog` (bug-labelled, `meta.fixes` = this card), linked from a `kind=defect`
comment, and named in the report. Card operations (brief, report,
delivery) are the `meerkat` board skill's contract; decisions are the `meerkat-director`
skill's — this file audits the work, not those contracts.

## Card and plan

- **W1.** The card brief (`card.md`) and the live card were re-read at their current version.
- **W2.** `.meerkat/<ref>/plan.md` exists (written or adopted), covers every step, and was
  audited against the acceptance list before the first edit.
- **W3.** Every frozen acceptance item maps to a step and a verification, or is recorded as
  `not_applicable` with the reason.

## Work

- **W4.** The change is the smallest correct one; no unrelated edit rides along.
- **W5.** The tree is coherent at every commit the report names.
- **W6.** Tests, the project's declared gate and the security scan (when the project declares
  one) were run against the delivered tree; a red is a blocker, not a leftover.
- **W7.** The work stayed inside the card's scope; a scope expansion is an E1 question.

## Delivery

- **W8.** The tree is committed and the report carries the `commit` anchor.
- **W9.** The report maps each acceptance item to its evidence, names every command run, and
  records any waiver with who granted it.
- **W10.** The project's integration branch was merged into this lane, the conflicts (if any)
  resolved, and the checks re-run on the result.
- **W11.** The card is at `in_review`; nothing was moved to `done`, and the lane was not merged
  back into the integration branch, rebased or pushed — landing is the loop's.
- **W12.** The report is a digest, not a transcript; links point at the committed tree.
