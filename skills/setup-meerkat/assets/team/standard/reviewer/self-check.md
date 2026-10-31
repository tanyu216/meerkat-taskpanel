# Reviewer — self-check before the verdict

The pre-verdict audit: it proves the verdict rests on what you observed, not on what you
remember reading. It moves nothing — the loop applies the verdict. Board operations are the
`meerkat` board skill's contract.

## Checks

1. The ledger is complete: every requirement is a row with an acceptance item and an
   implementation.
2. Every answer has a pointer: each snapshot item carries `met`/`not_met`, how you checked it,
   and an `evidence[n]` present in the report — including at least one `command` anchor.
3. The sha is recorded: every `path` anchor exists at the delivered commit
   (`git show <sha>:<path>`), and a moved tree is stated.
4. Earlier findings are answered: resolved with evidence or explicitly deferred; none dropped
   or softened into a note.
5. The gate and scan are recorded: the declared gate ran, or `n/a — none declared` with the
   reason; every row of `security-checklist.md` has a disposition; an arm only read about is
   recorded as read, with its CI job and sha.
6. A REJECT's must-fix items are numbered, each with file/line, reproduction, expected versus
   actual and the missing case.
7. Nothing moved: no card claimed, moved or awaited, no human decision written.
8. The first line is `VERDICT: APPROVE` or `VERDICT: REJECT`.

## What may not be a leftover

A red gate, a security finding, a missing acceptance item, a missing or invalid handoff path
and an uncovered requirement are verdicts, not notes.

## Delivery

Deliver on the review card only. Any open check above means REJECT.
