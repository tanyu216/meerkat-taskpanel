# Jobs — self-check before delivery

This is the role's **pre-delivery audit**, not the delivery itself; it is not the `## Handoff` block.
Refresh the card brief through the `meerkat` board skill first. Name the mode: product flow only,
product plus prototype on one card, prototype card, or standalone. The requirement → evidence
table lives in `plan.md`; this check audits it, it does not write it from memory.

## Direction check (product flow)

1. `.meerkat/<id>/spec.md` is the working source and `design/specs/<content-slug>.md` the
   archived one; `plan.md` links the spec and carries the acceptance mapping, risks and open
   questions.
2. The problem, evidence, users and their jobs, goals/non-goals/metrics, register and
   anti-patterns are written; every metric has a baseline, target, window, guardrail and owner;
   assumptions and risks have owners and the evidence that would change the decision.
3. The **E3** product direction is recorded and the decision round is closed; no frontier item
   is open.
4. The spec has `## Terminology` agreeing with `design/glossary.md`; product ADRs, if any, live
   under `design/adr/`.
5. The validation brief exists with 1–3 questions and a decision rule, or the skip reason is
   recorded.

## Prototype check (prototype flow)

### Prototype plan

1. The brief's questions, hypotheses, decision rules, success/stop conditions, constraints and
   evidence types are written.
2. Fidelity and why it is enough, the test protocol and task list, participants or proxy and
   sample, metrics/thresholds, order/analysis, timebox and the concept-to-variant mapping are
   written; no decision rule means planning is not done.

### Prototype design

1. `3 variants` (max 5) differ structurally in at least two of layout, hierarchy, affordance
   and navigation; each maps to a hypothesis; colour-only is not a variant.
2. The real shell and data are used; empty, loading, error, permission denied, long content,
   partial and success are implemented; one token source; the smoke check is clean.
3. The test record, proxy kind and limitations, per-hypothesis
   `confirmed`/`refuted`/`provisional`, the chosen and rejected variants, and the mixed-variant
   retest are present.
4. The four quality gates have evidence, any waiver is written, and the evidence is bound to
   the commit.
5. The verdict is recorded; no evidence means an open question, not a `confirmed`.

## PRD check (product flow)

When `.meerkat/<id>/prd.md` exists, check it and `design/prds/<content-slug>.md`:

1. Every Must has a testable acceptance (Given/When/Then) and a priority; no untestable words.
2. Every requirement traces to the card, the frozen acceptance or a prototype finding; every
   goal has a requirement; orphans are deleted.
3. Terms, scope and direction agree with the card, acceptance and prototype verdict; the design
   system's single source is referenced.
4. Boundaries cover empty, error, loading, partial, permission denied, concurrency, offline,
   long content, i18n and dark theme; NFRs have thresholds.
5. Dependencies, risks and open questions have owner and deadline; rollout/flag/back-out and
   post-launch measurement are written; prototype links resolve; the decision log says what was
   rejected.
6. The prototype verdict is folded in, or the PRD records `not_applicable` with the reason.

## Archive check

1. One content slug is chosen; it describes the topic, contains no task id, and is the same
   for both flows.
2. `design/specs/<content-slug>.md`, `design/prototype/<content-slug>/` and, when a PRD exists,
   `design/prds/<content-slug>.md` match the working copies.
3. A same-topic artifact was updated, with the revision in the decision log; `plan.md` links
   the archived paths, the working copies stay in `.meerkat/<id>/`, and the handoff names the
   same paths.

## Handoff block and delivery check

1. `plan.md` carries a requirement → artifact table for every requirement, decision, acceptance
   item and user-visible state. Every row ends in one disposition:
   - **met** — falsifiable: the artifact path plus the check that resolves, renders or reads it.
   - **not_applicable** — only with `n/a — <reason>`; a bare `n/a` is an omission.
   - **partial** / **not_met** — a blocker: finish it or ask; never deliver a baseline item
     with either.
   - **leftover** — outside the frozen acceptance, with the item, its owner and the follow-up.
     Never a leftover: a red gate, a security finding, a missing acceptance item, a missing
     handoff path, or a published contract or migration change.
2. The report's `conclusion` starts with `Outcome:` and contains the `## Handoff` block; the
   product card names Design card, Validation brief, Spec, Prototype, Prototype card, Verdict
   and commit, PRD, Glossary, Product ADRs, `Acceptance source`, `Delivery shape`, proposed
   implementation and verification, and open questions; every path resolves or says `none`.
3. `Acceptance source` seeds the next card once; `Delivery shape` agrees with the scopes (one
   task, or an epic whose children are landable deliverables, `never one child per layer`).
4. A split prototype card's handoff names its product card or brief, questions, verdict, path,
   evidence, rejected variants, commit, limitations and open questions.
5. The delivered tree is committed on the card's branch and the report carries the `commit` anchor;
   `nothing was merged, rebased or pushed`.
6. The project session creates downstream cards; the role does not. One card delivers once
   unless the flow is split.

## Standalone mode

When the prototype flow runs without a card: the brief is
`design/specs/<content-slug>.md` and the acceptance source; evidence is in
`design/prototype/<content-slug>/`; a PRD exists only when product-scoped; no board state is
written.

## Skip rules

- Product flow without a prototype: Direction, PRD, Archive and Handoff apply; the PRD's
  prototype item is `not_applicable` with the reason.
- Product and prototype on one card: both check sets run before the single delivery.
- Prototype card: Direction and PRD do not apply; Prototype plan/design, Archive and (as its
  own card) Delivery apply.
- Standalone: Prototype plan/design and Archive apply; no board.
