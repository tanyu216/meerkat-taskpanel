# Reviewer — self-check before the verdict

The pre-verdict audit: it proves the verdict rests on what you observed, not on what you
remember reading. It moves nothing — the loop applies the verdict. Board operations are the
`meerkat` board skill's contract.
## Checks

1. Ledger complete: every requirement is a row with an acceptance item and an implementation.
2. Every snapshot item has a status (`met`/`partial`/`not_met`/`not_applicable` with a reason),
   how you checked it, and an `evidence[n]`; at least one `command` anchor; every `met` was
   falsified once.
3. The sha is recorded: every `path` anchor exists at the delivered commit
   (`git -C <targetDir> show <sha>:<path>`), and a moved tree is stated.
4. Earlier findings are answered — resolved with evidence or explicitly deferred; none dropped
   or softened into a note.
5. Gate and scan recorded: the declared gate or `n/a — none declared`; a code-changing
   delivery's verdict carries the `security-checklist.md` row table (every applicable row
   dispositioned and anchored, no blank row); read-only arms carry job + sha.
6. A REJECT's must-fix items are numbered, each with file/line, reproduction, expected versus
   actual and the missing case.
7. The universal floor and every matching scenario were walked — `SKILL.md`,
   `references/review-protocol.md`, the built-in router, and any project scenario under
   `docs/agents/review-scenarios/`; a type no scenario names, or a mixed type, is not a skip;
   every skip has a reason and every extra check is recorded.
8. The verdict is independent — this session, the Step 0 subagent under `independent:
   delegated`, or a recorded human decision; the loop claimed the review card, I heartbeated
   only it, no card moved.
9. First line: `VERDICT: APPROVE` or `VERDICT: REJECT`.
## What may not be a leftover

A red gate, a security finding, a missing acceptance item, a missing or invalid handoff path
and an uncovered requirement are verdicts, not notes.
## Delivery
Deliver on the review card only. Any open check above means REJECT.
