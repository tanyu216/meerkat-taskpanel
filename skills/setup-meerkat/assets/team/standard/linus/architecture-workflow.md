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
security, operability, cost) and the decision drivers. Write `docs/architecture.md` for a
new project, or `.meerkat/<id>/architecture.md` for a card-local change.

### 2. Compare options

Run the decision round (role workflow) on the open architecture questions before choosing.
Put 2–3 viable options side by side: boundaries, stack, data flow, operational cost,
migration risk, and why the rejected ones lost. Record each durable decision as an ADR at
`docs/adr/NNNN-<slug>.md`: 1–3 sentences of Context, Decision and Why; add `Status`,
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

1. A row with `TBD`, "standard stack" or "decided per project" is not a decision; pick one
   option per row, and do not mix two frameworks or two component libraries.
2. An existing project inherits its stack: read the manifests (`package.json`,
   `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle`, `composer.json`,
   `Gemfile`, the Dockerfile and compose files) and record `inherited — <path>`. Do not
   re-choose or migrate without a card that asks for it.
3. A departure from the recommended baseline, a new dependency or a licence carries a
   written rationale and the human's E5 confirmation. Pin the runtime and major framework
   versions; the container base image must match the backend runtime.
4. Check compatibility: framework ↔ build tool ↔ language; engine ↔ driver/ORM ↔ migration
   tool; base image ↔ runtime; UI component layer ↔ styling layer.
5. The table is one decision bundle: put it to the project session and the human in one
   round with the rejected alternatives, not one row at a time. Steps 4 and 5 instantiate
   exactly this table; a substitution is a new recorded decision, never a silent edit.

Candidate menu — options, not defaults: Vue 3 or React + Vite + TypeScript + Tailwind CSS +
daisyUI; Node.js/TypeScript, Python, Java, Rust or Go (name the framework, runtime and
package manager); SQLite, PostgreSQL or MySQL (name the driver/ORM and migration tool); a
multi-stage Dockerfile, non-root user, healthcheck and compose services for a container. No
language or engine is the default — the card chooses and justifies. The Jobs prototype
stack (Tailwind CSS + daisyUI + jQuery) constrains the prototype only.

Record a hard-to-reverse trade-off as an ADR at `docs/adr/NNNN-<slug>.md`, and link the
table from `.meerkat/<id>/plan.md`.

### 4. Design the skeleton

Define the module boundaries and the dependency direction, the public interfaces and
contracts, the data model and migrations, the error model, configuration, observability,
the security boundaries, and the smallest vertical slice that proves the skeleton. The data
model and its migrations follow the persistence engine and migration tool recorded in
Step 3.

### 5. Scaffold the project

Create the repository layout, package/build configuration, lint/format/typecheck, test
harness, local run command, container/build path, CI skeleton, `.env.example` and README.
Instantiate exactly the stack recorded in Step 3; a substitution is a recorded decision.
When the runtime form is a container, the Dockerfile path in the table is part of the
scaffold; when it is not, do not add one without a decision. Never commit a secret, and do
not add a dependency or licence without a decision.

Generate the agent instructions with the host's built-in init command when it has one:
`/init` in Claude Code, Codex and OpenCode writes `CLAUDE.md` or `AGENTS.md` per the host's
read order. Review the generated file, add the build/test/run and worktree conventions, and
do not maintain both files as competing sources. Without an init command, write the file
directly and say so.

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
fire and are idempotent. No secret, no host-absolute path, no second source of truth. The
root `GLOSSARY.md` carries the `## Product language` pointer (or says product terms are not
recorded) and does not copy `design/glossary.md`.

### 8. Architecture review

Present the options, the stack table with pinned versions and rejected alternatives, the
decision, the boundaries and the risks to the project session. E5 belongs to the human.
Record the decision on the card. Do not start implementation before the review is recorded.

### 9. Deliver

Re-export the brief (`taskctl export md <id> --out .meerkat/<id>/card.md`), set
`meta.stage_handoff=required`, and write the architecture variant
of the `## Handoff` block into the delivery report's `conclusion`: the architecture
document, `.meerkat/<id>/architecture.md` (when the change is card-local), the ADR paths,
the skeleton paths, the acceptance source, the `Delivery shape` (one task, or an epic with
children) and the proposed implementation card(s). Deliver at `in_review` with the evidence.
Do not create the implementation card; the project session triages it, seeds its acceptance
and links it with `relation add <this-card> --type blocks --target <impl>` (or `parent` for
an epic).

The self-check is not a handoff: the self-check audits this card; the `## Handoff` block is
the cross-card transfer. A producer card has both.

## Boundaries

- Write only the skeleton and its smoke test here; product behaviour belongs to the
  implementation branch.
- Migrations are append-only. A published contract or schema change needs the human.
- No destructive operation and no secret.
