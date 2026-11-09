# Reviewer scenarios — the built-in taxonomy and the project extension

The built-in scenarios refine the universal floor in `SKILL.md` and
`references/review-protocol.md`; read those first. They are a refinement index, not a scope: a
type no scenario names is a normal review through the generic floor, and a mixed card reads
every matching file. Each scenario is a floor, not a ceiling — add any read-only check the
surface calls for and record it. Board operations are the `meerkat` board skill's contract.

| Scenario | Target |
|---|---|
| [product-plan.md](product-plan.md) | brief, PRD, requirement set, product glossary or ADR |
| [prototype.md](prototype.md) | prototype, UI/UX page, visual or interaction design |
| [development.md](development.md) | architecture, implementation, refactor, docs/operations/release |
| [test-design.md](test-design.md) | test cases, a test plan, a verification design |
| [test-execution.md](test-execution.md) | a test run, a regression proof, a performance result |
| [epic-rollup.md](epic-rollup.md) | an epic, a rollup of child cards |
| [generic.md](generic.md) | anything else, including non-engineering work |

## Project-defined scenarios

A target project extends the taxonomy without editing the skill: commit one markdown file per
scenario under `docs/agents/review-scenarios/` in the project. The reviewer discovers them in
the target card's worktree, reads them at the delivered sha, and applies every file whose
`Applies to:` line matches the card. A project scenario may name a target type no built-in
scenario names — that is the supported way to add a bespoke audit floor.

The installed `setup-meerkat` skill's Step 4 is the **only** writer of these files: a role, a
card or a session creates or edits one by hand only through that step. It asks for the
project's checks, writes only the types the project selects, and updates the project's
agent-instruction entry so it names the directory and every file in it.

There is no manifest, registry or configuration key: the directory is the inventory. A project
with no such directory has no project scenarios, and that is not an error.

### Template

```markdown
# Scenario — <name>

**Applies to:** <target types, artefacts or conditions that select this scenario>

## Checks
- <what the reviewer inspects, and what evidence counts>

## Blocks APPROVE
- <the failure that is blocking, not an observation>
```

Keep it a floor: state what must be true and how it is evidenced. A scenario that restates the
protocol, or that would make a correct delivery fail, is itself a finding.

## Precedence

1. **The protocol and the verdict rule are inviolable.** A project scenario adds checks; it
   never weakens independence, verification at the delivered sha, falsifiable evidence, the red
   gate, the security table, snapshot coverage or the one-verdict rule. Only the human decision ladder can waive a gate (E4 and its siblings); a scenario cannot.
2. **Project convention vs a built-in scenario.** On how *this project* works — names, layout,
   commands, contracts — the project scenario wins, and the verdict names its source. On truth,
   evidence and safety, the stricter rule wins.
3. **A scenario vs the project's live authoritative document.** The live document wins; the
   stale scenario is a finding with an owner.
4. **A delivery that adds or edits a scenario.** Review it with the stricter of the base and
   delivered text (`git show <sha>^:<path>` and `git show <sha>:<path>`), and surface the edit.
   A delivery cannot loosen its own review, and a scenario change is never evidence for the
   card that made it.

A project scenario is project documentation, not board data: nothing stores it, `taskd` never
reads it, and no card inherits it.
