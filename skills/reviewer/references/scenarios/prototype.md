# Scenario — product prototype

Refines the universal floor in `SKILL.md` and `references/review-protocol.md`; read those first.
Board operations are the `meerkat` board skill's contract.

**Applies to:** a prototype, a UI/UX page, a visual or interaction design, or a delivery whose
product is an artefact a person will see and use.

## Checks

- The prototype answers the stated assumptions and design questions; it is an answer, not a
  mood board.
- Archived paths resolve, and the artefact at the delivered sha is the one reviewed.
- Oracle fidelity covers structure, geometry and computed style, except the project's
  registered oracle exceptions; judge component contracts, not class names or positions.
- Every state the surface can enter is shown: empty, error, loading, disabled, permission,
  long content, overflow.
- Accessibility and focus order, a visible focus, keyboard paths, reduced motion.
- Themes and locales: the declared theme mode, i18n parity and the project's language copies.
- Screenshots and measurements carry provenance (sha, environment, viewport). A prototype
  behaviour with no repository test is judged from the page, screenshots and measurements.
- The project's machine-check legs ran, or the skip records the host/CI run at the sha.
- Where the acceptance prose and the prototype oracle disagree, the project's oracle rule wins
  and the conflict is recorded; the design direction belongs to the human.

## Blocks APPROVE

- A missing or unarchived prototype, or a fidelity gap outside a registered exception.
- An unmeasured fidelity claim.
- A required state, theme, locale or accessibility path absent.

## Beyond

Breakpoints, overflow, keyboard paths, reduced motion. Subjective design direction belongs to
the human; a preference is an observation, not a must-fix.
