# Scenario — test case authoring

Refines the universal floor in `SKILL.md` and `references/review-protocol.md`; read those first.
Board operations are the `meerkat` board skill's contract.

**Applies to:** test cases, a test plan, a verification design, or the test portion of a feature
card.

## Checks

- Acceptance-to-case matrix: every acceptance item names the case that proves it and the
  expected result; every case traces back to an acceptance item or a stated risk.
- Negative and adversarial cases: invalid input, boundary values, permission denial, empty and
  large input, concurrency and retry, a failure at each external boundary.
- Environment and data are specified and reproducible; fixtures are honest and do not encode the
  author's expectation as the oracle.
- Mocks only at external boundaries; a test that mocks the contract away proves nothing.
- Tests are deterministic and isolated: no time, order, network or shared-state dependence; a
  flake control (seed, fake clock, retry policy) is named.
- A regression case is red against the defect and green after the fix, and names the defect it
  pins.
- A performance case names the number, method, sample and bound.
- The plan-quality refinement applies to the test plan: every acceptance item maps to a scenario
  and its evidence, the blast radius is covered, and mock/environment boundaries are named.

## Blocks APPROVE

- An acceptance item with no case.
- A case that cannot fail: no assertion, an assertion on a mock, or a re-run of the
  implementation.
- A mock at an internal boundary, or a missing negative case for a stated guard.

## Beyond

Data-volume and time-based cases; property-based cases; mutation evidence for a claimed
coverage number.
