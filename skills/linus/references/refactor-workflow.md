# Linus — refactoring

Restructure code that already works. The design freedom is in the shape, never in what it does:
a caller must be unable to tell the refactor happened.

Board operations are the `meerkat` board skill's contract; decisions follow the loop's
`decision-policy.md`. **Linus recommends, the director decides; E1–E5 belongs to the
human.**

## Steps at a glance

0. Confirm the recorded foundation.
1. Frame the friction.
2. Find and rank the candidates.
3. Decide the candidate and design its interface.
4. Pin the behaviour.
5. Move in verified steps.
6. Run the self-check.
7. Deliver.

## Decision frontier

The round settles the chosen candidate, the target seam and interface, the behaviour to pin and
the rejected candidates; this card's plan is the one **written or adopted by you**, and the
candidate report lives there as the reviewer's evidence. Record the answers in `plan.md`; Linus
recommends, the director decides.

### 0. Confirm the recorded foundation

**Purpose.** A refactor rests on a recorded foundation; moving code without one is guessing.

**Watch for.** Read the standard (`docs/tech-spec.md`, or the path the project's README or
architecture document names), the architecture document, the ADRs in the area, the root
`GLOSSARY.md`, the contract, the schema and migrations, and `.env.example`. When any is missing
or partial, that is a **foundation gap**, not a blank input: stop before Step 1 and ask through
the board, and the director proposes an `architecture-workflow.md` card — Reconstruct when the
tree is the only record, Extend when a recorded decision changes. Resume only after it is
recorded and accepted. The dispositions bind: `inherited — <path>`,
`reconstructed — <evidence>`, `not recorded — review question`, `n/a — <reason>`; a
reconstruction is `E5 pending`. The foundation record and its re-choice belong to the
architecture card; characterisation tests pin behaviour while the missing record is restored.

**Essentials.** The resolved foundation inputs, or the recorded gap and the architecture card
that resolves it.

### 1. Frame the friction

**Purpose.** Say what is hard today and where the cost shows.

**Watch for.** Name the cost in understanding, changing or testing the area. Scope with YAGNI:
weight the area that changes most; take the area the card names, and when it names none, read the
recent history for hot spots and widen only when the changes are scattered. List the modules and
their callers. Propose the interface after the friction is observed.

**Essentials.** The friction, its cost and the bounded area in `plan.md`.

### 2. Find and rank the candidates

**Purpose.** Collect the real seams and rank them by evidence.

**Watch for.** Walk the area for friction: one concept spread across many small modules; a
module whose interface is nearly as complex as its implementation; pure functions extracted for
testability while the risk lives in how they are called; a leaking seam or two modules reaching
into each other; an area untested or testable only through a clumsy interface. Apply the
**deletion test** to anything shallow: would deleting it concentrate the complexity in one place,
or merely move it? "Concentrates" is the signal. A candidate that contradicts an ADR is listed
only when the friction warrants reopening it, and says: "contradicts ADR-NNNN; worth reopening
because …".

**Essentials.** A markdown table in `plan.md` — files, the problem, the change in plain words,
the benefit in locality and leverage, how the tests get easier, and a recommendation of
`Strong`, `Worth exploring` or `Speculative`. Keep the record in `plan.md`; a separate diagram
toolchain adds no reviewable evidence.

### 3. Decide the candidate, then design its interface

**Purpose.** Choose one candidate and make its seam testable.

**Watch for.** Run the decision round on the ranked list; "yes" accepts the recommendation.
Record the rejected candidates and the reason. Design the target interface only after the choice,
and only for the chosen module: what sits behind the seam, which adapters are real (one is a
hypothetical seam, two are real), what the interface makes testable, and what explicitly does not
move. The interface is the test surface; if a test has no seam through it, the design is
not finished.

**Essentials.** The chosen candidate, the rejected list and the interface design in `plan.md`.

### 4. Pin the behaviour before moving code

**Purpose.** Make a behaviour change visible before the code moves.

**Watch for.** Write the tests that pin the current behaviour and the published contract first,
adding characterisation tests where none exist. Prove they fail when the behaviour changes — a
test that cannot fail protects nothing.

**Essentials.** The pinning tests, green before the move and red when the behaviour changes; the
acceptance restated as evidence: which test or fixture proves each item still holds.

### 5. Move in verified steps

**Purpose.** Change the shape without changing what a caller can observe.

**Watch for.** Move one seam and verify the full suite green before the next; a batch makes a
regression hard to localize. Move code; keep the behaviour identical. Keep the published
contract, the schema and the migrations as they are. Update `GLOSSARY.md` and an ADR inline as
terms and durable decisions settle. A bug found on the way is a new card, not a drive-by fix; a
behaviour change is a new card too. Delete only what the deletion test proved empty, and only
once the suite is green without it.

**Essentials.** Each step green on its own; the before/after map; the contract, schema and
migrations unchanged; the updated glossary/ADR.

### 6. Self-check

**Purpose.** Audit the evidence before delivery.

**Watch for.** `self-check.md` (Refactor branch) is the authoritative checklist: every
acceptance item maps to a pinning test or evidence, the behaviour held fixed is named,
and the gates are green.

**Essentials.** The acceptance → pinning test/evidence table in `plan.md`.

### 7. Deliver

**Purpose.** Make the refactor reviewable and auditable.

**Watch for.** The tree is committed and the report carries the `commit` anchor; the board's delivery gate (`DELIVERY_NEEDS_COMMIT`) refuses a report that does not. Deliver the committed tree; the supervisor's acceptance pass merges, rebases, pushes and cleans up.

**Essentials.** Commit the delivered tree; call the `meerkat` board skill to deliver at
`in_review` with the before/after map, the pinning tests, the gates, the acceptance mapping, the
`## Handoff` when the card has one, and the leftovers. State what did not change — that is the
claim being reviewed.

## Boundaries

- No observable behaviour change on a refactor card.
- A refactor starts on a recorded foundation: Step 0 stops the card until
  `architecture-workflow.md` records it; this card leaves the foundation record to the
  architecture card.
- A restructure of working code is its own refactor card.
- A published contract, schema or migration change needs the human.
- Reopening a recorded ADR is a recorded decision.
- Stop at `in_review`; the reviewer is independent.
