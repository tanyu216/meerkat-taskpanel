# UI workflow — prototype planning and design

The prototype flow answers the product flow's validation brief with evidence: it plans the
method, builds structurally different variants, tests them, and records a verdict. It is not a
delivery. On the same card it returns to product step 5; on its own card it delivers its
evidence. Board operations are the `meerkat` board skill's contract. Keep artifacts inside the
project with relative `design/...` paths; a filename never carries the task id, and a prototype
is not production code.

## Steps at a glance

Prototype planning
1. Frame the prototype plan.
2. Choose the concept space.
Prototype design and validation
3. Design and build the variants.
4. Test and converge.
5. Verify quality.
6. Record the verdict and hand back.

## Before work — the plan

Take the card's plan through the `meerkat` board skill: an existing `.meerkat/<id>/plan.md` is
this card's plan (extend it), an attached plan is adopted, and **no plan attached** writes one
from the card. Audit it; the prototype plan links to the card index.

## Decide before you build

The decision policy this handoff names controls the round. The prototype flow's frontier is
operational: test method, fidelity, participants or proxy, timebox, environment/data and the
concept space. Run one decision round and record the answers in the prototype plan; ask through
the board when a question is not yours. The product direction, the chosen concept's E3 decision
and any scope or acceptance change belong to the director and the human.

## Modes

### Card mode

The prototype owns `.meerkat/<id>/prototype/` and archives to
`design/prototype/<content-slug>/`; `spec.md`, `validation-brief.md` and `prd.md` belong to the
product flow, and an independent prototype card takes its brief from its own acceptance. If the
brief has no testable question or the product flow marks it `not_applicable`, hand back
`n/a — <reason>`; whether validation is needed is the product flow's decision.

### Standalone mode

Run this file for a one-off feature optimization or prototype revision with no card. The
one-page brief is `design/specs/<content-slug>.md`; evidence goes to
`design/prototype/<content-slug>/`. Write `design/prds/<content-slug>.md` **only on demand** —
new behaviour, an external contract, or a decision others build on. A pure visual or
interaction revision ends with the spec, the prototype and the verdict. Standalone writes no
board state and extends the project's design system; it never forks a second.

## Phase 1 — Prototype planning

### 1. Frame the prototype plan

**Purpose.** Turn the validation questions into an executable test.

**Watch for.** Add the method: fidelity (low/middle/high) and why it is enough; scope;
environment and representative data; a task list mapping each task to a hypothesis; participants
or an independent proxy and the sample; metrics/thresholds; order/rotation; analysis; timebox;
the concept-to-variant mapping. Send an incomplete question or decision rule back to the product
flow; a prototype without a decision rule is waste.

**Essentials.** `.meerkat/<id>/prototype/plan.md`, linked from the card index.

### 2. Choose the concept space

**Purpose.** Make the alternatives real and structurally different.

**Watch for.** Define `3 variants` (max 5) that test different hypotheses, differing in at least
two of layout, information hierarchy, primary affordance and navigation model. A colour-only
change is not a concept; record which variant proves which hypothesis.

**Essentials.** The concept list, the concept-to-variant mapping and the rejection reasons.

## Phase 2 — Prototype design and validation

### 3. Design and build the variants

**Purpose.** Produce runnable evidence, not a picture.

**Watch for.** Use the real shell and real or representative data; trace every value to a
token. Implement empty, loading, error, permission denied, long content, partial and success;
structure first, states next, motion last. Smoke check before testing: zero console/page
errors, every state reachable, `?variant=` switching.

**Essentials.** Runnable variants, a `?variant=` switcher that does not ship, and one token
source.

### 4. Test and converge

**Purpose.** Replace opinion with evidence and converge on one direction.

**Watch for.** Run a task-based usability test: 3–5 representative users per round, or an
**independent proxy** (a second agent or reviewer doing a heuristic walkthrough plus automated
browser checks, or a stakeholder review); the builder's own self-review is not proxy evidence.
Record proxy kind, sample and limitations; a proxy verdict is `provisional`, and a
launch-critical hypothesis is not `confirmed` on proxy evidence unless the human accepts it.
Real users need consent; no PII. Capture success, errors, time and quotes; apply the decision
rule. A mix is a new variant: rebuild and retest it.

**Essentials.** Test records, per-hypothesis `confirmed`/`refuted`/`provisional`, the chosen
and rejected variants, and the limitations.

### 5. Verify quality

**Purpose.** Make the evidence credible before the verdict.

**Watch for.** Run four gates in order; expensive ones do not replace cheap ones: accessibility
and responsive behaviour (WCAG target, assistive-technology spot check); browser geometry at 3
widths plus dark and the longest realistic or Chinese content (0 overflow, 0 console/page
errors, visible keyboard focus, `prefers-reduced-motion`); `screenshot` self-review (fix the
three worst, at most three rounds, keep before/after); critique (focal point, hierarchy, type,
colour, surfaces, states, motion) and remove generated-UI tells. Fix each finding or record a
written waiver; bind the evidence to the commit. This is the role's own critique, not acceptance.

**Essentials.** The four gate results, any waiver, and the evidence commit.

### 6. Record the verdict and hand back

**Purpose.** Turn the evidence into a decision the product flow can use.

**Watch for.** Record each hypothesis as `confirmed`, `refuted` or `provisional`, the chosen
direction and tokens, rejected variants, evidence paths and commit, limitations and open
questions. Archive to `design/prototype/<content-slug>/`. On the same card, return to product
step 5. On its own card, commit, run this flow's checks in `self-check.md`, set
`meta.stage_handoff=required`, and deliver at `in_review` with a `commit` anchor
(`DELIVERY_NEEDS_COMMIT`) and the prototype Handoff: product card or brief, questions, verdict,
chosen direction and tokens, path, evidence, rejected variants, commit, limitations, open
questions; a missing field is `none — <reason>`. Do not merge, rebase or push, and do not accept
your own work; the product flow reads that Handoff, not this card's plan. A scope or acceptance
change goes back to the product flow, and the switcher and losing variants never ship.

**Essentials.** The verdict, the evidence and commit, and the return path.
