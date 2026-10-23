# Jobs — self-check before delivery

Run this after the design work and before `issue deliver`.

## Design and omission check

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
6. Confirm the prototype evidence exists for every design claim, under
   `design/prototype/<id>/`.
7. Confirm the product artifacts live in the project's `design/` tree — `design/specs/`,
   `design/prototype/`, `design/prds/` — with relative paths only; `plan.md` links to them.

## PRD check

When `design/prds/<id>.md` exists, check it:

1. Every Must requirement has a testable acceptance (Given / When / Then) and a priority.
2. No untestable words ("fast", "friendly", "smooth", "reasonable", "better").
3. Every requirement traces to a card requirement, a frozen acceptance item or a
   prototype finding; every goal has at least one requirement. Delete orphans.
4. Terms, priorities, scope and the chosen direction agree with the card, the frozen
   acceptance and the prototype verdict.
5. The boundaries cover empty, error, loading, partial, permission denied, concurrency,
   offline, long content, i18n and dark theme.
6. Dependencies, risks and open questions each have an owner and a deadline.
7. The PRD references the design system's single source and does not duplicate it.
8. Prototype links and screenshots resolve; the decision log says what was rejected.

Record a finding table (severity + disposition) in `plan.md`. A blocker is fixed or asked,
never delivered. If the card is too small for a full PRD, confirm `plan.md` carries the
requirement → evidence table and the reason instead.

## Handoff

Confirm the handoff to Linus names the acceptance criteria, the spec path
(`design/specs/<id>.md`), the PRD path (`design/prds/<id>.md`) and the prototype path
(`design/prototype/<id>/`). Only then deliver, at `in_review`, with the coverage table and
the leftovers in the report.
