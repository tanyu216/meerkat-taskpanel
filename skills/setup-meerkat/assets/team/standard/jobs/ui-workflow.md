# UI workflow — validate a design with a prototype

Read this in card mode before stage 2 of the role workflow, when a card changes what a
user sees or does; read it directly in standalone mode for a single feature optimization or
prototype revision. The prototype answers the design questions with evidence; it does not
write the PRD unless the change is product-scoped, and it is not a delivery.

Board operations (claim, heartbeat, comment, report, deliver, move, brief refresh) are the
`meerkat` board skill's contract; load it before the first write.

## Modes

### Card mode

Inputs: the card, the frozen acceptance, the spec and the plan. Working artifacts use the
card id and stay in `.meerkat/<id>/`: `spec.md`, `prototype/`, `prd.md`. The role workflow's
archive stage promotes them to content-named files under `design/`.

### Standalone mode

Run this file directly for a single feature optimization, prototype revision or interaction
change with no card. The brief is the acceptance source: write a one-page brief directly in
`design/specs/<content-slug>.md` (problem, target surface, success test, 1-3 questions,
constraints, non-goals), where `<content-slug>` is a kebab-case name derived from the
feature or topic, never a task id. The prototype and evidence go to
`design/prototype/<content-slug>/`. Write `design/prds/<content-slug>.md` only on demand —
when the change introduces new behaviour, an external contract, or a decision others will
build on. A pure visual or interaction revision ends with the spec, the prototype and the
verdict.

Standalone mode never writes to the board and never changes a card. If a decision needs the
human, ask; do not infer it. Finish by reporting the chosen direction, the evidence and the
file paths.

## When to skip

- The card changes no user-visible surface: record why in `plan.md` and skip.
- The card already carries a frozen direction and approved artifacts: verify them instead
  of re-deriving them.

## Inputs

- card mode: `card.md`, the live card, the frozen `acceptance`, `.meerkat/<id>/spec.md`
  (direction, states, assumptions) and `.meerkat/<id>/plan.md` (acceptance mapping, risks,
  open questions);
- standalone mode: the brief in `design/specs/<content-slug>.md` is the acceptance source
  and the index; there is no card workspace;
- the project's existing design system or tokens, if any. Extend it; never fork a second.

## Steps

### 1. Question card

Write the 1–3 questions the prototype answers. In standalone mode this is the one-page
brief. A prototype that answers no question is waste. If the question is about state or
logic rather than appearance, build a single clickable HTML demo instead of UI variants.

### 2. Diverge

Build 3 variants (max 5) in the real shell with representative data. Switch them with a
URL parameter (`?variant=`) and a floating bar; keep the bar out of the deliverable.
Variants must differ in at least two of: layout, information hierarchy, primary affordance,
navigation model. Colour-only variants are not variants.

### 3. Converge

Pick one variant; mixing is allowed ("B's header with C's sidebar"). Record the choice, the
rejected variants and why in `.meerkat/<id>/spec.md` (card mode) or
`design/specs/<content-slug>.md` (standalone), and link the verdict from `plan.md` (card
mode). Write the one token source: colour (named values), type and scale, spacing ladder,
radius, elevation, motion, component states, accessibility baseline, and the anti-patterns
that would be a failure.

### 4. Build

Use the real shell and real (or representative) data. Implement every state that matters:
empty, loading, error, permission denied, long content, partial, success. Every value
traces to a token; no magic numbers. Structure first, then states, then UI motion — and
motion only answers a user action, never a decorative page-load sequence.

### 5. Verify

Run four gates in order; the expensive ones do not replace the cheap ones.

1. **Deterministic checks.** Accessibility, responsive behaviour and the common
   generated-UI tells. Fix each finding or record a written waiver.
2. **Browser geometry.** At least 3 widths (desktop, tablet, phone) plus the dark theme
   and Chinese or the longest realistic content. Horizontal overflow 0; console and page
   errors 0; keyboard focus visible; `prefers-reduced-motion` respected.
3. **Screenshot self-review.** Look at your own screenshots; fix the three worst problems;
   at most three rounds. Keep the before/after frames.
4. **Critique pass.** Check focal point, hierarchy, typography, colour, surfaces, states
   and motion, then remove generated-UI tells. This is the role's own critique, not
   acceptance; the independent reviewer still audits the PRD and the prototype evidence at
   delivery.

### 6. Archive evidence

Put the verdict, the evidence (screenshots, commands, readings) and the rejected variants
in `.meerkat/<id>/prototype/` (card mode) or `design/prototype/<content-slug>/`
(standalone). Keep the chosen prototype as the reference for the PRD and the implementation
handoff. The switcher and the losing variants do not ship. A claim without evidence is an
open question, not a decision: never store evidence in a scratch directory.

## Boundaries

- Keep every artifact inside the project: relative `design/...` paths only, never an
  absolute path or another project's tree.
- A prototype is not a delivery and never production code.
- Do not change the card's scope or acceptance. A design question that changes either is a
  `question` to the project session.
- Do not fork the project's design system; extend the one that exists.
