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

### 3. Confirm the tech stack

Before designing the skeleton, fix and record the stack. Write a `## Tech stack` table into
`docs/architecture.md` (new project) or `.meerkat/<id>/architecture.md` (card-local change).
Every row carries a concrete choice, or `n/a — <reason>` when the layer does not apply.

| Layer | Record | `n/a` is allowed when |
|---|---|---|
| Frontend | framework (Vue 3 / React / none), language (TypeScript), styling (Tailwind CSS), component layer (daisyUI), build tool (Vite), router and state | the deliverable has no browser UI |
| Backend | language and runtime version, framework, package manager, process model | the deliverable is a static site, CLI or library |
| Persistence | engine (SQLite / PostgreSQL / MySQL / other), driver or ORM, migration tool, data directory and backup | the deliverable is stateless or writes files only |
| Container / build | runtime form (host process / container / orchestration), Dockerfile path, base image and runtime version, non-root user, multi-stage build, compose services, healthcheck, volume | the runtime form is the host process, with the reason stated |
| Contracts (when the deliverable has an external interface) | API style (REST / GraphQL / RPC), external services, environment surface | there is no external contract |

Rules:

1. A row with `TBD`, "standard stack", or "decided per project" is not a decision; do not
   start Step 4 with one.
2. Pick one option per row. Do not mix Vue and React in one app, and do not stack two
   component libraries.
3. An existing project inherits its stack. Read the manifests (`package.json`,
   `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle`, `composer.json`,
   `Gemfile`, the Dockerfile and compose files) and record `inherited — <path>`. Do not
   re-choose or migrate without a card that asks for it.
4. A choice that departs from the recommended frontend baseline, or that adds a dependency
   or a licence, carries a written rationale and the human's E5 confirmation.
5. Pin the runtime and the major framework versions. The container base image version must
   match the backend runtime version.
6. Check compatibility: framework ↔ build tool ↔ language; engine ↔ driver/ORM ↔ migration
   tool; base image ↔ runtime; UI component layer ↔ styling layer.
7. The table is one decision bundle. Put it to the project session and the human in one
   round with the rejected alternatives, not one row at a time.
8. Steps 4 and 5 instantiate exactly this table. A substitution is a new recorded decision
   on the card, never a silent edit.

Candidate menu — these are options, not defaults:

- **Frontend baseline (recommended):** Vue 3 or React + Vite + TypeScript + Tailwind CSS +
  daisyUI. Pick one framework; the baseline is still recorded and confirmed.
- **Backend:** Node.js/TypeScript, Python, Java, Rust or Go — name the framework, runtime
  version and package manager. No language is the default; the card chooses and justifies.
- **Persistence:** SQLite, PostgreSQL or MySQL — name the driver/ORM and the migration
  tool. No engine is the default; the card chooses and justifies.
- **Container:** a multi-stage Dockerfile, a non-root user, a healthcheck and compose
  services where the runtime form is a container. When the runtime form is not a container,
  state why.
- **Not the prototype stack:** the Jobs prototype is Tailwind CSS + daisyUI + jQuery. That
  closure constrains the prototype only; the engineering frontend is recorded above.

Record a hard-to-reverse trade-off as an ADR at `docs/adr/NNNN-<slug>.md`, and link the
table from `.meerkat/<id>/plan.md`.

### 4. Design the skeleton

Define the module boundaries and the dependency direction, the public interfaces and
contracts, the data model and migrations, the error model, configuration, observability,
the security boundaries, and the smallest vertical slice that proves the skeleton. The data
model and its migrations follow the persistence engine and migration tool recorded in
Step 3.

### 5. Scaffold the project

Create the repository layout, package and build configuration, lint/format/typecheck, the
test harness, the local run command, the container/build path, the CI skeleton,
`.env.example` and the README. Instantiate exactly the stack recorded in Step 3: the
package manager, framework, persistence driver/migration tool and container path come from
that table, and a substitution is a recorded decision. When the runtime form is a container,
the Dockerfile path named in the table is part of the scaffold; when it is not, do not add
one without a decision. Never commit a secret. Do not add a dependency or a licence without
a decision.

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

### 6. Wire the git gates

Install `.githooks/pre-commit` (migrations append-only and contiguous), `pre-push` (API and
CLI contract snapshots, route-request lint, host-path and signpost checks, a CHANGELOG
section for every pushed tag, no direct push to main) and `pre-tag` (the same API and tag
rules). Set `core.hooksPath`, and run the same checks in CI so a host-only bypass cannot
ship. Each hook stays offline and fast, and prints the command it runs. Check shell hooks
with `bash -n`.

### 7. Self-check

Map every requirement and quality attribute to an artifact. The `## Tech stack` table is
complete, its versions are pinned, and the scaffold instantiates it. Every ADR has
alternatives and consequences. The skeleton builds, the smoke test passes, and the hooks
fire and are idempotent. No secret, no host-absolute path, no second source of truth. The root
`GLOSSARY.md` carries the `## Product language` pointer (or says product terms are not
recorded) and does not copy `design/glossary.md`.

### 8. Architecture review

Present the options, the stack table with pinned versions and rejected alternatives, the
decision, the boundaries and the risks to the project session. E5 belongs to the human.
Record the decision on the card. Do not start implementation before the review is recorded.

### 9. Hand off

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
