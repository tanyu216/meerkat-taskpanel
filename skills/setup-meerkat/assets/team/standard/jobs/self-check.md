# Jobs — self-check before delivery

Run this after the design work and before `issue deliver`. Check every stage you ran; the
skip rules at the end decide which stages apply.

## Direction check (stage 1)

1. `.meerkat/<id>/spec.md` is the working source, and `design/specs/<content-slug>.md` is
   the archived source of the direction.
2. The design register is named (brand / product / workflow / AI console / commerce / h5).
3. Goals, non-goals and success metrics are written; the users and their jobs are named.
4. The 1–3 assumptions the prototype must answer are listed, and the anti-patterns that
   would be a failure are listed.
5. The **E3** direction decision is recorded on the card (project session and human).
6. `plan.md` links to the spec and carries the acceptance mapping, risks and open questions.
7. The decision round is closed: the spec records the answers and no frontier decision is
   open.
8. The spec has a `## Terminology` section; its terms agree with `design/glossary.md`, and
   product ADRs, if any, live under `design/adr/`.

## Prototype check (stage 2 / `ui-workflow.md`)

1. The question card names 1–3 questions, not a general "make it better".
2. 3 structurally different variants exist (max 5); they differ in at least two of layout,
   information hierarchy, primary affordance and navigation model.
3. The variants run in the real shell with representative data; the switcher does not ship.
4. One token source is written: colour, type, space, radius, elevation, motion, states,
   accessibility baseline and anti-patterns.
5. Every state that matters is implemented: empty, loading, error, permission denied, long
   content, partial, success.
6. The four verification gates have evidence: deterministic checks, browser geometry at 3
   widths plus dark and long/localised text, screenshot self-review (top 3, max 3 rounds),
   critique pass.
7. Evidence lives in `.meerkat/<id>/prototype/` and is archived at
   `design/prototype/<content-slug>/`; the verdict and the rejected variants are recorded.
8. Each assumption is confirmed or refuted. A refuted assumption returned to stage 1; the
   PRD was not written around a rejected design.

## PRD check (stage 3)

When `.meerkat/<id>/prd.md` exists, check it and its archived copy at
`design/prds/<content-slug>.md`:

1. Every Must requirement has a testable acceptance (Given / When / Then) and a priority.
2. No untestable words ("fast", "friendly", "smooth", "reasonable", "better").
3. Every requirement traces to a card requirement, a frozen acceptance item or a prototype
   finding; every goal has at least one requirement. Delete orphans.
4. Terms, priorities, scope and the chosen direction agree with the card, the frozen
   acceptance and the prototype verdict.
5. The boundaries cover empty, error, loading, partial, permission denied, concurrency,
   offline, long content, i18n and dark theme.
6. Dependencies, risks and open questions each have an owner and a deadline.
7. The PRD references the design system's single source and does not duplicate it.
8. Prototype links and screenshots resolve; the decision log says what was rejected.

Record a finding table (severity + disposition) in `plan.md`. A blocker is fixed or asked,
never delivered.

## Handoff and delivery check (stage 6)

1. `plan.md` carries a requirement → artifact table for every description requirement,
   comment decision, acceptance item and user-visible state.
2. Any row with no artifact is an omission: finish it, ask with an agent `question`, or
   record a deliberate leftover with the reason.
3. No silent scope expansion; the plan's non-goals still hold.
4. The delivery report's `conclusion` begins with a one-line `Outcome:` and contains the
   `## Handoff` block; `meta.stage_handoff=required` is set.
5. The block names every field: Design card, Spec, Prototype, PRD, Glossary, Product ADRs,
   Acceptance source, Delivery shape, Proposed implementation, Proposed verification and
   Open questions / leftovers. Every path resolves, or says `none` with the reason.
6. `Acceptance source` is concrete enough to seed the next card's frozen acceptance once;
   `Delivery shape` agrees with the proposed scopes (one task, or an epic with children);
   the content slugs contain no task id.
7. Jobs created no downstream card: the project session triages, creates, seeds and links
   it.
8. The reviewer can read the spec, the PRD, the prototype evidence, the handoff block and
   the frozen acceptance.
9. The product artifacts live in the project's `design/` tree with relative paths only;
   `plan.md` links them, but the cross-card input is the handoff, not the plan.
10. Deliver at `in_review` with the coverage table and the leftovers. Do not accept your
    own work.

## Archive check

1. One content slug is chosen; it describes the topic and contains no task id.
2. `design/specs/<content-slug>.md`, `design/prototype/<content-slug>/` and, when a PRD
   exists, `design/prds/<content-slug>.md` exist and match the working copies.
3. A same-topic artifact was updated rather than duplicated; the revision is recorded in the
   decision log.
4. `plan.md` links the archived paths, and the working copies remain in `.meerkat/<id>/`;
   the handoff block names the same paths and is the cross-card input, not the plan.

## Standalone mode

When the UI workflow ran without a card:

1. `design/specs/<content-slug>.md` is the acceptance source and covers the brief's problem,
   target surface, success test, questions, constraints and non-goals.
2. The prototype and evidence use `design/prototype/<content-slug>/`.
3. `design/prds/<content-slug>.md` exists only when the change is product-scoped, with the
   reason recorded; a pure visual or interaction revision ends with the spec, the prototype
   and the verdict.
4. No board or card state was written.

## Skip rules

- No user-visible change: skip stage 2 and record why in `plan.md`; the direction and PRD
  checks still apply.
- A card too small for a full PRD: keep the requirement → evidence table in `plan.md`, say
  why, and proceed; the omission check still applies.
