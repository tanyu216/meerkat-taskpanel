# Linus — self-check before delivery

Run this after implementation and before `issue deliver`.

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` snapshot and
   `.meerkat/<id>/plan.md`.
2. Build a requirement/acceptance → code/test/evidence table in `plan.md`:
   - every description requirement and every comment decision;
   - every acceptance item;
   - every error, boundary and regression scenario you touched.
3. For each row, name the file, test or command that proves it. Evidence must be
   reproducible: a command with its exit code, a path, a commit, or a coverage number.
4. Any row with no proof is an **omission**:
   - if it is in scope, add the code/test;
   - if it needs a decision, write an agent `question` comment and stop;
   - if it is deliberately deferred, record it as a leftover with the reason.
5. Re-run the repository gates you claim in the report; do not report a command you did
   not run. A red gate is a blocker, not a leftover.
6. Confirm no published contract, schema or migration changed without the human's
   decision; confirm no destructive operation was run.
7. Only then deliver, at `in_review`, with the coverage table, commands/results and
   leftovers.
