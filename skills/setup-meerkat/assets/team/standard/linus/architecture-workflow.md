# Linus — architecture and project foundation

Read this from the role workflow when the card starts a project or subsystem, changes the
stack, or establishes the repository's foundation. The architecture direction is **E5**:
the project session reviews it and the human decides it. Do not implement product behaviour
here.

Every step below names its output. A step is done when that output exists and is linked
from `.meerkat/<id>/plan.md`; do not start the next step while a decision is open.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- `.meerkat/<id>/plan.md`;
- this card's `## Handoff` block, when the project session created this card from a design
  card;
- the existing repository, if any: its manifests, architecture document, ADRs and
  `GLOSSARY.md`. Extend it; never fork a second foundation.

## Steps

### 1. Frame the system

State the purpose, the consumers, what is in and out of scope, the constraints (time, team,
compliance, hosting), the quality attributes that matter (performance, reliability,
security, operability, cost) and the decision drivers.

Output: `docs/architecture.md` for a new project, or `.meerkat/<id>/architecture.md` for a
card-local change.

### 2. Decide the direction

Run the decision round (the policy this handoff names) before choosing: the frontier of
questions whose prerequisites are settled, one round, one question string, a recommended
answer each. Record the answers in `plan.md`. Do not build while a frontier item is open.

Put 2–3 viable options side by side: boundaries, data flow, operational cost, migration
risk, and why the rejected ones lost. An option without rejected alternatives is not a
decision. Record each durable decision as an ADR at `docs/adr/NNNN-<slug>.md`: 1–3
sentences of Context, Decision and Why; add `Status`, `Considered Options` and
`Consequences` when they help.

#### Record the stack

Before designing the skeleton, fix and record the stack as **one** decision bundle, not one
row at a time. Write a `## Tech stack` table into `docs/architecture.md` (new project) or
`.meerkat/<id>/architecture.md` (card-local change). Every row records a concrete choice,
or `n/a — <reason>` when the layer does not apply.

| Layer | Record | `n/a` is allowed when |
|---|---|---|
| Frontend | language, framework and version, build tool, styling and component layer, router and state | the deliverable has no browser UI |
| Backend | language and runtime version, framework, package manager, process model | the deliverable is a static site, CLI or library |
| Persistence | engine, driver or ORM, migration tool, data directory and backup | the deliverable is stateless or writes files only |
| Container / build | runtime form (host process / container / orchestration), build-file path, base image and runtime version, non-root user, multi-stage build, local multi-service definition, healthcheck, volume | the runtime form is the host process, with the reason stated |
| Contracts (optional, outside the four core layers) | interface style, external services, environment surface | there is no external contract |

Rules:

1. A row with `TBD`, "standard stack" or "decided per project" is not a decision; pick one
   option per row, and do not mix two frameworks or two component libraries.
2. An existing project inherits its stack: read its build and package manifests and its
   container files, and record `inherited — <path>`. Do not re-choose or migrate without a
   card that asks for it. If the inherited table is missing, write a `question` and stop;
   do not choose a stack for another card.
3. Check compatibility across the rows: framework ↔ build tool ↔ language; engine ↔
   driver/ORM ↔ migration tool; base image ↔ runtime; UI component layer ↔ styling layer.
4. A departure from the confirmed table, a new dependency or a licence carries a written
   rationale, an ADR and the human's E5 confirmation. Pin the runtime and major framework
   versions.
5. The confirmed table is the project's baseline: implementation cards inherit it and may
   not substitute a row silently. A substitution is a new recorded decision.

There is no preferred stack. The card chooses and justifies; the table records that choice,
it is not a menu to pick from.

Output: the answered questions in `plan.md`, the ADRs, and the `## Tech stack` table linked
from `.meerkat/<id>/plan.md`.

### 3. Design the skeleton

Define the module boundaries and the dependency direction, the public interfaces and
contracts, the data model and migrations, the error model, configuration, observability,
the security boundaries, and the smallest vertical slice that proves the skeleton. The data
model and its migrations follow the persistence engine and migration tool recorded in
Step 2.

Output: the skeleton design in the architecture document, with the vertical slice named.

### 4. Scaffold the project

Instantiate exactly the stack recorded in Step 2; a substitution is a recorded decision.
The scaffold is complete only when every row below has its artifact. "Not applicable" is a
written `n/a — <reason>`, never a missing file.

| Area | Must contain | Done when |
|---|---|---|
| Layout and entry points | source tree, test tree, docs, migrations, entry files | a newcomer finds the entry from the README |
| Build and manifests | package/build manifest, lockfile, scripts for install / build / run / test / lint / typecheck / migrate | a clean environment builds with one command |
| Quality tooling | formatter, linter and type checker configuration | all three run locally and fail non-zero |
| Test harness | runner configuration, fixture conventions, one smoke test that boots the skeleton | the smoke test passes |
| Local run | one documented command plus ports and configuration | from zero to reachable |
| Configuration surface | `.env.example` naming every key the app reads, the load order, no secret | a missing key fails loudly, never a silent default |
| Container / build path | only when the runtime form is a container: build file, non-root user, healthcheck, local multi-service definition; otherwise the recorded `n/a` | the build file builds and the healthcheck passes |
| CI skeleton | a pipeline running the Step 6 checks | it runs on a pull request |
| VCS | `.gitignore` for build output, data directories, `.worktrees/` and env files; the integration branch; a gitignored `.worktrees/` | no generated file is committed |
| Docs | README with purpose, run, test and a link to the architecture document | every link resolves |

Never commit a secret, add a dependency or licence without a decision, or create a second
source of truth.

Output: the scaffold tree, a passing smoke test, and the local run command recorded in the
README.

### 5. Initialize the agent instructions

Generate the agent instructions with the host's built-in init command when it has one:
`/init` in Claude Code and Codex writes `CLAUDE.md` or `AGENTS.md` per the host's
read order. Review the generated file — `/init` guesses commands and layout — and correct
it. Keep one source of truth; do not maintain `CLAUDE.md` and `AGENTS.md` as competing
copies. Without an init command, write the file directly and say so.

The file is the map every session loads, not a manual. It must carry:

1. **Purpose and boundary** — what the project is, in one paragraph.
2. **Commands** — build, test (including a single file), run, lint, typecheck and migrate,
   exactly as the scaffold defines them.
3. **Layout** — where source, tests, docs, migrations and the entry points live.
4. **Conventions** — dependency direction and module boundaries, the error model, the
   configuration surface.
5. **Gates** — what must pass before delivery, the exact commands, the coverage floor and
   the security scan.
6. **Workspace** — the project uses one worktree per card, based on the integration branch
   (`dev` by default), shared by the card's roles; the primary checkout stays on the
   integration branch and `.meerkat/<id>/` stays in the project working directory. Merge
   and cleanup run only after the reviewer approves or the operator confirms; the command
   lifecycle lives in `workflow.md` and is not restated here.
7. **Pointers** — link `docs/architecture.md`, `GLOSSARY.md` and `docs/adr/`; do not copy
   their content.

Leave out architecture prose, design documents, ADR bodies and details that will drift.
Update the file when a command or the layout changes.

Output: `CLAUDE.md` or `AGENTS.md`, reviewed, with the workspace declaration and the
pointers.

### 6. Wire the git gates and CI/CD

Install `.githooks/pre-commit`, `.githooks/pre-push` and `.githooks/pre-tag`, set
`core.hooksPath`, and run the same checks in CI so a host-only bypass cannot ship. Hooks
stay offline and fast, print the command they run, and are idempotent; check shell hooks
with `bash -n`.

| Hook | Must stop | Done when |
|---|---|---|
| `.githooks/pre-commit` | formatting, lint or typecheck failures on staged files; an edited or non-contiguous migration; a secret, a host-absolute path or a generated file | it returns in seconds; a fixable finding is fixed and re-staged |
| `.githooks/pre-push` | a failing test suite (the affected set, plus the full suite before a merge); a stale contract or interface snapshot; a declared request schema that differs from the handler; a lockfile that does not match its manifest | it runs the same checks as the CI test job |
| `.githooks/pre-tag` | a version that disagrees with the manifest; a tag without its CHANGELOG section; a release build that fails | it passes before the tag is created |

CI runs on every push and pull request: install from the lockfile → lint, format check and
typecheck → tests with the coverage floor → contract checks → build the artifact → security
scan (dependency audit, secret scan, SAST) with no unaddressed high or critical finding.

CD promotes **the same artifact** that passed CI; it never rebuilds per environment. It
deploys only from a release tag or the integration branch, keeps secrets in the deploy
environment rather than the repository, and gives every deploy a healthcheck and a recorded
rollback.

Output: the three hooks wired through `core.hooksPath`, the CI pipeline file, and the deploy
path with its rollback.

### 7. Self-check

Run `self-check.md` (Architecture branch). The architecture proof is:

- every requirement and quality attribute maps to the architecture document or an ADR;
- the `## Tech stack` table is complete, versions are pinned and Step 4 instantiates it;
- every ADR has a status, alternatives and consequences;
- the scaffold checklist in Step 4 is complete, the smoke test passes and the documented
  local run works;
- `CLAUDE.md`/`AGENTS.md` carries the commands, the layout, the gates and the workspace
  declaration, and links rather than copies the architecture document;
- `.githooks/pre-commit`, `pre-push` and `pre-tag` exist, fire through `core.hooksPath` and
  are idempotent;
- no secret, no host-absolute path, no second source of truth;
- the root `GLOSSARY.md` carries the `## Product language` pointer (or says product terms
  are not recorded) and does not copy `design/glossary.md`.

Output: the requirement → artifact table in `plan.md`.

### 8. Architecture review

Present the options, the stack table with pinned versions and rejected alternatives, the
decision, the boundaries and the risks to the project session. E5 belongs to the human.
Record the decision on the card. Do not start implementation before the review is recorded.

Output: the recorded E5 decision on the card.

### 9. Deliver

Re-export the brief (`taskctl export md <id> --out .meerkat/<id>/card.md`), set
`meta.stage_handoff=required`, and write the architecture variant of the `## Handoff` block
into the delivery report's `conclusion`: the architecture document,
`.meerkat/<id>/architecture.md` (when the change is card-local), the ADR paths, the
scaffold paths, the agent-instruction path (`CLAUDE.md` or `AGENTS.md`), the acceptance
source, the `Delivery shape` (one task, or an epic with children) and the proposed
implementation card(s). Deliver at `in_review` with the evidence. Do not create the
implementation card; the project session triages it, seeds its acceptance and links it with
`relation add <this-card> --type blocks --target <impl>` (or `parent` for an epic).

The self-check audits this card; the `## Handoff` block is the cross-card transfer. A
producer card has both.

## Boundaries

- Write only the skeleton and its smoke test here; product behaviour belongs to the
  implementation branch.
- Migrations are append-only. A published contract or schema change needs the human.
- No destructive operation and no secret.
