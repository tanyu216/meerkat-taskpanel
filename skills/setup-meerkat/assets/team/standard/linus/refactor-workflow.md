# Linus — refactoring

Read this from the role workflow for a card whose goal is to restructure code that already
works. The design freedom is in the shape of the code, never in what it does: a caller has
to be unable to tell the refactor happened.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- this card's `.meerkat/<id>/plan.md`, written by you before starting — the candidate report
  below lives here, as ordinary markdown, and is the reviewer's evidence;
- `GLOSSARY.md` and the ADRs in the area — a recorded decision is not re-litigated here;
- the tests that pin the current behaviour, the callers, and the published contract.

## Steps

### 1. Frame the friction

Say what is hard today and where the cost shows: understanding the concept, changing it, or
testing it. Scope with YAGNI — weight the area that changes most. Take the area the card
names; when it names none, read the recent history for the hot spots and widen only when the
changes are scattered. List the modules involved and who calls them.

Do not propose an interface yet. The friction comes first, the shape later.

### 2. Find and rank the candidates

Walk the area and note where you experience friction:

- understanding one concept means bouncing between many small modules;
- a module is shallow: its interface is nearly as complex as its implementation;
- pure functions were extracted for testability while the real risk lives in how they are
  called — no locality;
- a seam leaks, or two modules reach into each other;
- the area is untested, or only testable through a clumsy interface.

Apply the **deletion test** to anything that looks shallow. Would deleting it concentrate the
complexity in one place, or merely move it? "Concentrates" is the signal; "moves" is not.

The six design principles of the project's `docs/architecture.md` are the tie-breakers here
too: simplicity and reliability first, cohesion over coupling, and every new abstraction
names its forcing function — for a refactor, the deletion test is that evidence.

Record every candidate in `plan.md` as a markdown table — files, the problem, the change in
plain words, the benefit in locality and leverage and how the tests get easier, and a
recommendation of `Strong`, `Worth exploring` or `Speculative`. Describe the before and after
in text or a code block; do not produce a separate HTML artifact or a diagram toolchain.

A candidate that contradicts an ADR is listed only when the friction is real enough to
warrant reopening it, and it says so: "contradicts ADR-NNNN; worth reopening because …".
Do not list every theoretical refactor a decision forbids.

### 3. Decide the candidate, then design its interface

Run the decision round on the ranked list; "yes" accepts the recommendation. Record the
rejected candidates with the reason — a later reviewer reads that list.

Design the target interface only after the choice, and only for the chosen module: what sits
behind the seam, which adapters are real (one is a hypothetical seam, two are real), what the
interface makes testable, and what explicitly does not move. The interface is the test
surface; if a test cannot be written through it, the design is not finished.

### 4. Pin the behaviour before moving code

Write the tests that pin the current behaviour and the published contract first, adding
characterisation tests where none exist. Prove they fail when the behaviour changes — a test
that cannot fail protects nothing. With the behaviour pinned, restate the acceptance in terms
of evidence: which test or fixture proves each item still holds.

### 5. Execute in verified steps

Move one seam at a time, with the full suite green after each step. Move code; do not rewrite
it on the way. Keep the published contract, the schema and the migrations as they are. Update
`GLOSSARY.md` and an ADR inline as terms and durable decisions settle.

A bug found on the way is a new card, not a drive-by fix; a behaviour change is a new card
too. Delete only what the deletion test proved empty, and only once the suite is green
without it.

### 6. Self-check

Run `self-check.md` (Refactor branch): every acceptance item maps to a pinning test or
evidence, the behaviour that must not change is named, and the gates are green. A row with no
proof is an omission, not a detail for later.

### 7. Deliver

Run every applicable suite and the mandatory gates, and record the evidence. Re-export the
brief, then stop at `in_review` with a report that carries the before/after map in markdown,
the pinning tests, the gates, the acceptance mapping and the leftovers. State plainly what did
not change — that is the claim being reviewed.

## Boundaries

- No observable behaviour change on a refactor card.
- Do not restructure working code as part of a feature or a bug fix; that is this branch's card.
- Do not change a published contract, schema or migration without the human.
- Do not reopen a recorded ADR silently.
- Do not accept your own work; the reviewer is independent.
