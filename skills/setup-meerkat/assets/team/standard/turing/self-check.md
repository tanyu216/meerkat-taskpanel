# Turing — self-check before delivery

Run this after the verification work and before `issue deliver`.

1. Re-read `.meerkat/<id>/card.md`, the live card, the frozen `acceptance` snapshot and
   `.meerkat/<id>/plan.md`.
2. Build an acceptance → test/evidence table:
   - every acceptance item;
   - every requirement the description and comments state;
   - the boundary and failure scenarios the real use implies.
3. For each row, name the test and the command that ran it, with the exit code and the
   coverage number. A row with no real test is an **omission**.
4. Check the hard rules:
   - unit and integration suites: 100% pass;
   - unit coverage: > 80%;
   - mocks only at db/http/redis boundaries, none in integration;
   - no fake cases, no coverage padding, no mock-only integration tests.
5. Run the security review: authorization, input validation, secrets, injection, path
   traversal, SSRF. Record each finding with severity and evidence.
6. Any uncovered item: add the test if it is in scope, ask the project session if it
   needs a decision, or record an explicit leftover with the reason.
7. Deliver with the table, the exact commands/results and the leftovers. On a review card,
   the first line is `VERDICT: APPROVE` or `VERDICT: REJECT`.
