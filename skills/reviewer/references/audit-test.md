# Reviewer audit — test

This is a refinement of the universal floor in `SKILL.md`; read that first. The scenario files
are refinements, not a scope; a mixed card reads every matching file. Board operations are the
`meerkat` board skill's contract.

## Test design / regression / performance (Turing)
**Floor.** Acceptance-to-test matrix; negative/adversarial cases; environment and data; mocks only at external boundaries; a regression proof that is red before the fix and green after; flake controls; performance numbers, bound and method.
Apply the plan-quality refinement to the test plan: every acceptance item maps to a scenario and its evidence, the blast radius is covered, and the mock/environment boundaries are named.
**Beyond.** Data-volume and time-based cases.
