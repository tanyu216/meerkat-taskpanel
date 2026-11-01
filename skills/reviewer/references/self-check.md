# Reviewer — self-check before the verdict

The pre-verdict audit: it proves the verdict rests on what you observed, not on what you
remember reading. It moves nothing — the loop applies the verdict. Board operations are the
`meerkat` board skill's contract.

## Checks

1. The ledger is complete: every requirement is a row with an acceptance item and an
   implementation.
2. Every answer has a pointer: each snapshot item carries a status (`met`/`partial`/`not_met`/
   `not_applicable` with a reason), how you checked it, and an `evidence[n]` — at least one `command` anchor.
3. The sha is recorded: every `path` anchor exists at the delivered commit
   (`git -C <targetDir> show <sha>:<path>`), and a moved tree is stated.
4. Earlier findings are answered: resolved with evidence or explicitly deferred; none dropped
   or softened into a note.
5. Gate and scan recorded: declared gate or `n/a — none declared`; every `security-checklist.md`
   row plus any surface-specific security check is dispositioned; read-only arms carry job + sha.
6. A REJECT's must-fix items are numbered, each with file/line, reproduction, expected versus
   actual and the missing case.
7. The shape floor was walked (`references/audit-playbook.md`): every skip has a reason, every
   extra check recorded; the loop claimed the review card, I did not claim it again, I heartbeated
   only it, neither card moved, no card awaited, no human decision written.
8. First line: `VERDICT: APPROVE` or `VERDICT: REJECT`.

## What may not be a leftover

A red gate, a security finding, a missing acceptance item, a missing or invalid handoff path
and an uncovered requirement are verdicts, not notes.

## Delivery

Deliver on the review card only. Any open check above means REJECT.
