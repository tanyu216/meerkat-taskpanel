# Epic cards for this project

The board's epic mechanics — never claimable, the child/parent shape, the rollup,
auto-start and auto-close — are the installed `meerkat` skill's (`references/scenarios/epic.md`
and `references/lifecycle/containers.md`). This page is **this project's sizing and creation
guidance**, read by the `meerkat` skill when it creates or splits an epic: resolve the
project directory with `taskctl project dir <id> --json`, then read
`<project-dir>/docs/agents/epic-cards.md` when it exists. It is not board data.

## The test in this repository

A child must be able to land on `dev` alone and leave the tree coherent:

- **One behaviour across every surface is one child.** Core, CLI, web, docs and fixtures
  for one behaviour ship together; those layers are its scope, not separate children.
- **A migration ships with its app-layer mirror.** The schema invariant, its domain guard,
  its contract test and its snapshot are one child.
- **A fixture sweep or a documentation catch-up is never its own child.** It belongs to the
  child that creates the debt.
- **A later child may build on an earlier child already on `dev`.** A stack on an unmerged
  sibling is not a child; it is a layer.

## Creating

- The split is the director's decision. An out-of-scope child is a scope expansion (`E1`)
  and waits for the human unless the project's decision policy delegates it.
- Promote the container **before** its current-round report. A card that already delivered
  starts a new container instead — the rollup reads the children's reports, not the
  container's history.
- Link with `relation add --type parent`; `issue create --parent` links nothing.
- Each child carries its own `--target`, or an explicit `--allow-dup` when a target does not
  apply.

The general four questions and the promotion table are the installed skill's
`references/scenarios/epic.md`; this page only adds this project's concrete test.
