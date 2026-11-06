# Reviewer audit — product planning

This is a refinement of the universal floor in `SKILL.md`; read that first. The scenario files
are refinements, not a scope; a mixed card reads every matching file. Board operations are the
`meerkat` board skill's contract.

## Product planning / brief / PRD (Jobs)
**Floor.** Problem, evidence, users, goals/non-goals/metrics, scope. Every PRD Must maps to a testable acceptance item. A `product-acceptance` card's ledger is the evidence for a product delivery: it traces every Must and marks met/unmet. The card sets `stage_handoff=required`; the current report's `## Handoff` is complete and its archived paths resolve; the handoff's acceptance source matches the frozen acceptance; any downstream follow-up named in `leftovers` is in the handoff, while a defect follow-up filed in `backlog` is named by its identifier; glossary/ADR terms. Audit conformance and evidence, not design taste.
Apply the plan-quality refinement to the PRD: the requirement → acceptance → evidence chain closes, every boundary state is named, and the chosen solution is the simplest reliable one.
**Beyond.** Comparable options, rollout/measurement plan, open-question disposition.

## Prototype / UI / UX (Jobs)
**Floor.** The prototype answers the stated assumptions. Archived paths resolve. Oracle fidelity covers structure, geometry and computed style, except the project's registered oracle exceptions; component contracts, not class names or positions. All states (empty/error/loading), accessibility, focus, themes, i18n parity, screenshots and measurements, project machine-check legs. Prototype behaviour with no repo test is judged from the page/screenshots/measurements.
**Beyond.** Breakpoints, overflow, keyboard paths, reduced motion. Subjective design direction is not a verdict reason.
