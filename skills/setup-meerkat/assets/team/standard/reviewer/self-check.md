# Reviewer — self-check before the verdict

Run this after the audit and before delivering the report. It is an audit of the audit: it
checks that the verdict rests on things you actually observed, not on things you remember
reading. It never changes the card's state and never authorizes a move — the loop applies
the verdict.

Never edit `card.md`; re-export it. This is not the `## Handoff` block.

## Core

1. **The ledger is complete.** Every requirement from the description, comments, `plan.md`
   and the handoff is a row, and every row names an acceptance item and an implementation
   (path:line, test, visible behaviour). A row you skipped is an omission, not a detail —
   go back and answer it.
2. **Every answer has a pointer.** Each snapshot item carries `met`/`not_met`, one line of
   how you checked, and an `evidence[n]` reference that exists in your own report's
   `evidence[]`. The board refuses an APPROVE whose `met` items cite nothing, and an
   APPROVE whose report contains no `command` anchor (you ran nothing).
3. **The sha is recorded.** The report names the delivered commit you verified, and any
   `path` anchor you relied on exists at that sha (`git show <sha>:<path>`). If the working
   tree has moved past it, the report says so.
4. **Earlier findings are answered.** Every item the baseline carries from an earlier round
   is resolved with its evidence or explicitly deferred. None was dropped.
5. **The gate is recorded.** You ran the declared gate yourself, or recorded
   `n/a — none declared` and why the card has no runnable gate. A gate you read about but
   did not run is not evidence.
6. **Must-fix items are numbered.** A REJECT's findings are a numbered list, each with
   file/line, reproduction, expected versus actual and the missing case, because the loop
   appends them to the original's acceptance.
7. **Nothing was moved.** You claimed no original, moved no card, entered no `awaiting`,
   and wrote no human decision kind.

## What may not be a leftover

A red gate, a security finding, a missing acceptance item, a missing or invalid handoff
path, and an uncovered requirement are verdicts, not notes. Do not soften any of them into
a leftover or an "observation".

## Delivery

Deliver on the review card only, with `VERDICT: APPROVE` or `VERDICT: REJECT` as the first
line. If any core check above is open, the verdict is REJECT and its findings say what to
close; an APPROVE with an open check is the failure this file exists to prevent.
