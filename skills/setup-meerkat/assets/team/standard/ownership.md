# Ownership — who owns which work

This guide routes work to exactly one accountable role. It is navigation, not decision
authority: who may decide what is defined only by the loop's `references/decision-policy.md`.

| Work shape | Accountable role | Workflow |
|---|---|---|
| Product planning, brief, PRD, product glossary/ADR | Jobs | `jobs/workflow.md` |
| Prototype, UI/UX, visual, interaction or aesthetic direction | Jobs | `jobs/ui-workflow.md` |
| System architecture, project foundation, tech stack | Linus | `linus/architecture-workflow.md` |
| Implementation, feature, bug, refactor, operations | Linus | `linus/implementation-workflow.md` |
| Test design and test authoring | Turing | `turing/test-design-workflow.md` |
| Regression, post-fix verification, production bug | Turing | `turing/regression-workflow.md` |
| Performance, latency, throughput testing | Turing | `turing/performance-workflow.md` |
| Independent review of a delivered card | Reviewer | `reviewer/workflow.md` |

## Rules

1. **One owner per shape.** Work spanning rows is split into one card per shape; the
   project session triages and splits it.
2. **The reviewer is independent.** A producer never reviews its own card; review is
   always the Reviewer lane.
3. **The assignee executes.** This guide tells the project session whom to assign; the
   card's assignee still selects the executing role and workflow.
4. **Unowned or ambiguous goes to the project session.** If no row fits, or two rows
   plausibly claim the card, the project session decides; it does not guess a role.
5. **Design hands off; it does not implement.** A Jobs delivery hands the archived
   spec/prototype/PRD to the project session, which creates the implementation and
   verification cards.
