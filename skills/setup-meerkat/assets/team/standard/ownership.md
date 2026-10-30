# Ownership — who owns which work

This guide routes work to exactly one accountable role. It is navigation, not decision
authority: who may decide what is defined only by the loop's `references/decision-policy.md`.

The table lists the shapes these roles own, not a closed list of all work. A shape it does
not describe is not forced into a row.

| Work shape | Accountable role | Workflow |
|---|---|---|
| Product planning, brief, PRD, product glossary/ADR | Jobs | `jobs/workflow.md` |
| Prototype, UI/UX, visual, interaction or aesthetic direction | Jobs | `jobs/ui-workflow.md` |
| System architecture, project foundation, tech stack | Linus | `linus/architecture-workflow.md` |
| Implementation, feature, bug | Linus | `linus/implementation-workflow.md` |
| Refactor: restructuring code without changing its behaviour | Linus | `linus/refactor-workflow.md` |
| Test design and test authoring | Turing | `turing/test-design-workflow.md` |
| Regression, post-fix verification, production bug | Turing | `turing/regression-workflow.md` |
| Performance, latency, throughput testing | Turing | `turing/performance-workflow.md` |
| Independent review of a delivered card | Reviewer | `reviewer/workflow.md` |

## Rules

1. **One owner per role shape.** Work spanning rows is split per **role** shape — a handoff
   boundary, not a technical layer. The project session triages and splits it.
2. **The reviewer is independent.** A producer never reviews its own card; review is
   always the Reviewer lane.
3. **The assignee executes — set at creation.** Create each card with its one accountable
   role's board name (`--assignee <role>`); the card's assignee still selects the executing
   role and workflow. An unassigned team card is unowned and may sit.
4. **A shape outside the rows is not force-fit.** Work that is none of them — operations on
   a running system, an external account, a manual task — goes to a worker identity outside
   the roles. That worker carries its own flow and inherits no role workflow,
   responsibilities, boundaries or self-check; its card is not evidence for a role's
   process. Do not widen a role's row to absorb work it does not own.
5. **Ambiguous goes to the project session.** If two rows claim it, the project session
   decides which; it does not guess a role.
6. **Design hands off; it does not implement.** A Jobs delivery hands the archived
   spec/prototype/PRD to the project session, which creates the implementation and
   verification cards.
