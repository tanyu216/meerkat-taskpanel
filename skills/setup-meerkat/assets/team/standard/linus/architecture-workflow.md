# Linus — architecture and project foundation

Read this from the role workflow when the card starts a project or subsystem, changes the
stack, or establishes the repository's foundation. The architecture direction is **E5**:
the project session reviews it and the human decides it. Do not implement product behaviour
here.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- `.meerkat/<id>/plan.md`;
- this card's `## Handoff` block, when the project session created this card from a design
  card;
- the existing repository, if any. Extend it; never fork a second foundation.

## Steps

### 1. Frame the system

State the purpose, the consumers, what is in and out of scope, the constraints (time, team,
compliance, hosting), the quality attributes that matter (performance, reliability,
security, operability, cost) and the decision drivers. Write `docs/architecture.md` for a new
project, or `.meerkat/<id>/architecture.md` for a card-local change.

### 2. Compare options

Run the decision round (see the role workflow) on the open architecture questions before
choosing. Put 2–3 viable options side by side: boundaries, stack, data flow, operational
cost, migration risk, and why the rejected ones lost. Record each durable decision as an ADR
at `docs/adr/NNNN-<slug>.md`: 1–3 sentences of Context, Decision and Why; add `Status`,
`Considered Options` and `Consequences` when they help. An option without rejected
alternatives is not a decision.

### 3. Design the skeleton

Define the module boundaries and the dependency direction, the public interfaces and
contracts, the data model and migrations, the error model, configuration, observability,
the security boundaries, and the smallest vertical slice that proves the skeleton.

### 4. Scaffold the project

Create the repository layout, package and build configuration, lint/format/typecheck, the
test harness, the local run command, the container/build path, the CI skeleton,
`.env.example` and the README. Never commit a secret. Do not add a dependency or a licence
without a decision.

Generate the agent instructions with the host's built-in init command when it has one:
`/init` in Claude Code, Codex and OpenCode writes `CLAUDE.md` or `AGENTS.md` according to
the host's read order. Review the generated file, then add the project's build, test, run
and worktree conventions; do not accept it blind, and do not maintain both files as
competing sources. If the host has no init command, write the file directly and say so.

Establish the integration branch (`dev` by default; use the project's branch if it already
has one) and a gitignored `.worktrees/` directory. Write this workspace rule into the agent
instructions (`CLAUDE.md`/`AGENTS.md`) and the README, so every role follows it:

```markdown
## Workspace

One worktree per card, off the integration branch (`dev` by default):
`git worktree add .worktrees/<card-slug> -b <branch> dev`.
All roles working the card share it. The primary checkout stays on `dev`. The card
directory (`.meerkat/<id>/`) stays in the project working directory, not inside the
worktree. Commit explicit paths in the worktree. Merge and clean up only after the reviewer approves or the operator
confirms:
`git checkout dev && git merge --no-ff <branch>`,
`git worktree remove .worktrees/<card-slug>`,
`git branch -d <branch>`.
Never use `-D`.
```

### 5. Wire the git gates

Install `.githooks/pre-commit` (migrations append-only and contiguous), `pre-push` (API and
CLI contract snapshots, route-request lint, host-path and signpost checks, a CHANGELOG
section for every pushed tag, no direct push to main) and `pre-tag` (the same API and tag
rules). Set `core.hooksPath`, and run the same checks in CI so a host-only bypass cannot
ship. Each hook stays offline and fast, and prints the command it runs. Check shell hooks
with `bash -n`.

### 6. Self-check

Map every requirement and quality attribute to an artifact. Every ADR has alternatives and
consequences. The skeleton builds, the smoke test passes, and the hooks fire and are
idempotent. No secret, no host-absolute path, no second source of truth. The root
`GLOSSARY.md` carries the `## Product language` pointer (or says product terms are not
recorded) and does not copy `design/glossary.md`.

### 7. Architecture review

Present the options, the decision, the boundaries and the risks to the project session. E5
belongs to the human. Record the decision on the card. Do not start implementation before
the review is recorded.

### 8. Hand off

Set `meta.stage_handoff=required` and write the architecture variant of the `## Handoff`
block into the delivery report's `conclusion`: the architecture document,
`.meerkat/<id>/architecture.md` (when the change is card-local), the ADR paths, the
skeleton paths, the acceptance source, the `Delivery shape` (one task, or an epic with
children) and the proposed implementation card(s). Deliver at `in_review` with the
evidence. Do not create the implementation card; the project session triages it, seeds its
acceptance and links it with `relation add <this-card> --type blocks --target <impl>` (or
`parent` for an epic).

## Boundaries

- Write only the skeleton and its smoke test here; product behaviour belongs to the
  implementation branch.
- Migrations are append-only. A published contract or schema change needs the human.
- No destructive operation and no secret.
