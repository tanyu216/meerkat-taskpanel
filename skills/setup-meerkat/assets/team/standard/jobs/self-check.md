# Jobs — self-check before delivery

Run this after the design work and before delivery. First re-export the brief so the check
runs against the current card, then work through every stage you ran; the skip rules at the
end decide which stages apply.

Never hand-edit `card.md`; re-export it. This is the role's pre-delivery audit. It is not
the `## Handoff` block: that block is a producer card's cross-card transfer (Jobs design,
Linus architecture only).

## Direction check (stage 1)

1. `.meerkat/<id>/spec.md` is the working source and `design/specs/<content-slug>.md` the
   archived one; `plan.md` links the spec and carries the acceptance mapping, risks and
   open questions.
2. The register (brand / product / workflow / AI console / commerce / h5), goals,
   non-goals, success metrics, users and their jobs are written; the 1–3 prototype
   assumptions and the anti-patterns are listed.
3. The **E3** direction decision is recorded on the card (project session and human), and
   the decision round is closed: every item answered or explicitly deferred, no frontier
   open.
4. The spec has a `## Terminology` section; its terms agree with `design/glossary.md`, and
   product ADRs, if any, live under `design/adr/`.

## Prototype check (stage 2 / `ui-workflow.md`)

1. The question card names 1–3 questions; 3 structurally different variants exist (max 5),
   differing in at least two of layout, information hierarchy, primary affordance and
   navigation model.
2. The variants run in the real shell with representative data; the switcher does not ship;
   one token source is written (colour, type, space, radius, elevation, motion, states,
   accessibility baseline, anti-patterns).
3. Every state that matters is implemented: empty, loading, error, permission denied, long
   content, partial, success.
4. The four verification gates have evidence: deterministic checks, browser geometry at 3
   widths plus dark and long/localised text, screenshot self-review, critique pass. Evidence
   lives in `.meerkat/<id>/prototype/` and `design/prototype/<content-slug>/`, with the
   verdict and rejected variants. Each assumption is confirmed or refuted; a refuted one
   returned to stage 1.

## PRD check (stage 3)

When `.meerkat/<id>/prd.md` exists, check it and `design/prds/<content-slug>.md`:

1. Every Must requirement has a testable acceptance (Given / When / Then) and a priority;
   no untestable words ("fast", "friendly", "smooth", "reasonable", "better").
2. Every requirement traces to a card requirement, a frozen acceptance item or a prototype
   finding; every goal has at least one requirement; delete orphans.
3. Terms, priorities, scope and direction agree with the card, the frozen acceptance and
   the prototype verdict; the PRD references the design system's single source.
4. The boundaries cover empty, error, loading, partial, permission denied, concurrency,
   offline, long content, i18n and dark theme.
5. Dependencies, risks and open questions each have an owner and a deadline; prototype
   links resolve; the decision log says what was rejected.

Record a finding table (severity + disposition) in `plan.md`. A blocker is fixed or asked,
never delivered.

## Handoff block and delivery check (stage 6)

1. `plan.md` carries a requirement → artifact table for every description requirement,
   comment decision, acceptance item and user-visible state. Every row ends in one
   disposition, and the report's acceptance status carries it:
   - **met** — the proof is falsifiable: the artifact `path` plus the check that resolves,
     renders or reads it, so a missing or broken artifact fails it.
   - **not_applicable** — only with the reason that makes it inapplicable (`n/a — <reason>`).
     A bare `n/a` is an omission.
   - **partial** / **not_met** — a blocker: finish it or ask with an agent `question` and
     keep the card `in_progress`. The delivery gate refuses either status on a baseline item.
   - **leftover** — work the card surfaced but does not own: it lies outside the frozen
     acceptance and names the item, its owner and the follow-up (or why none is needed).
     Never a leftover: a red gate, a security finding, a missing acceptance item, a missing
     handoff path, or a published contract or migration change. No silent scope expansion.
2. The report's `conclusion` begins with a one-line `Outcome:` and contains the
   `## Handoff` block; `meta.stage_handoff=required` is set.
3. The block names every field: Design card, Spec, Prototype, PRD, Glossary, Product ADRs,
   Acceptance source, Delivery shape, Proposed implementation, Proposed verification and
   Open questions / leftovers. Every path resolves, or says `none` with the reason.
4. `Acceptance source` can seed the next card's frozen acceptance once; `Delivery shape`
   agrees with the proposed scopes (one task, or an epic with children); the content slugs
   contain no task id.
5. Jobs created no downstream card: the project session triages, creates, seeds and links
   it. The reviewer can read the spec, PRD, prototype evidence, handoff block and frozen
   acceptance.
6. The artifacts live in the project's `design/` tree with relative paths only; `plan.md`
   links them, but the cross-card input is the handoff, not the plan. A card with an open
   omission, a red gate or an unanswered question is not delivered: finish it or ask and
   keep the card `in_progress`. Deliver at `in_review` with the coverage table and the
   leftovers, each with its owner and follow-up.

## Archive check

1. One content slug is chosen; it describes the topic and contains no task id.
2. `design/specs/<content-slug>.md`, `design/prototype/<content-slug>/` and, when a PRD
   exists, `design/prds/<content-slug>.md` match the working copies.
3. A same-topic artifact was updated, with the revision in the decision log; `plan.md` links
   the archived paths, the working copies stay in `.meerkat/<id>/`, and the handoff block
   names the same paths.

## Standalone mode

When the UI workflow ran without a card:

1. `design/specs/<content-slug>.md` is the acceptance source and covers the brief's
   problem, target surface, success test, questions, constraints and non-goals.
2. The prototype and evidence use `design/prototype/<content-slug>/`.
3. `design/prds/<content-slug>.md` exists only when the change is product-scoped; a pure
   visual or interaction revision ends with the spec, the prototype and the verdict.
4. No board or card state was written.

## Skip rules

- No user-visible change: skip stage 2 and record why in `plan.md`; the direction and PRD
  checks still apply.
- A card too small for a full PRD: keep the requirement → evidence table in `plan.md`, say
  why, and proceed; the omission check still applies.
