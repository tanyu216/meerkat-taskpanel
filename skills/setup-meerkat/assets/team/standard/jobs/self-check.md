# Jobs — self-check before delivery

Run this after the design work and before `issue deliver`.

1. Re-read `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot.
2. Build a requirement → artifact table in `.meerkat/<id>/plan.md`:
   - every requirement in the description and comments;
   - every acceptance item;
   - every user-visible state (empty, loading, error, permission denied, long content).
3. For each row, name the design artifact, prototype or decision that satisfies it.
4. Any row with no artifact is an **omission**:
   - if it is in scope and you can finish it, do so;
   - if it needs a decision, write an agent `question` comment and stop;
   - if it is deliberately deferred, record it as a leftover with the reason.
5. Confirm the plan's non-goals are still respected; do not silently widen the card.
6. Confirm the handoff to Linus names the acceptance criteria and the artifact paths.
7. Only then deliver, at `in_review`, with the coverage table and the leftovers in the
   report.
