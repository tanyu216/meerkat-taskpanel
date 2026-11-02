# Linus — system initialization and architecture design

This is the project's **system initialization** design flow, not a feature or module design:
it decides the system whole — its style, boundaries, contracts, configuration, tree and gates.
A feature, module or behaviour change inside the recorded architecture belongs to
`implementation-workflow.md`. The architecture direction is **E5**: the director reviews
it and the human decides it. Do not implement product behaviour here.

Board operations are the `meerkat` board skill's contract; decisions follow the loop's
`decision-policy.md`. **Linus recommends, the director decides; E1–E5 belongs to the
human.**

## Steps at a glance

1. Frame the system.
2. Decide the direction (style and stack).
3. Design the system skeleton.
4. Scaffold the project.
5. Initialize the agent instructions.
6. Record the gates, release and deploy path.
7. Run the self-check.
8. Present the architecture package (E5).
9. Deliver and hand off.

## Run modes

Name the mode before Step 1; it decides what the run may write and what E5 covers.

| Mode | Use when | Writes | E5 |
|---|---|---|---|
| Create | no recorded foundation exists and the card establishes one | the full package | the human approves before implementation |
| Extend | a recorded foundation exists and the card changes a recorded decision | the delta, its ADR and the affected artifacts | the human approves before implementation |
| Reconstruct | the recorded foundation is missing or partial; the tree is the only record | the reconstructed package, with provenance on every fact | provisional: E5 is pending |
| Conformance audit | the record exists and the card asks whether the system conforms | findings with evidence; no source or contract rewrite | none unless the audit proposes a change |

A **no-card run** covers reconstruction and conformance audit: it writes artifacts only, not
`plan.md` and no board state, records an open decision as `not recorded — review question`, and
delivers `E5 pending`; the commit and delivery rules do not apply without a card.

## Design stance

Six principles are the tie-breakers in the decision round; the architecture package carries
the evidence for each. Their canonical definitions live in `SKILL.md` §Six principles.

| Principle | Evidence in the architecture |
|---|---|
| Simple | the fewest modules and patterns that meet the requirements; no abstraction before a second caller |
| Reliable | every dependency's failure mode, timeout, retry and health signal is named |
| Efficient | a measured cost and a stated bound; no optimization without a number |
| Elegant | one source of truth, consistent naming, boring technology, least surprise |
| Not over-engineered | every abstraction and dependency names its forcing function; the smallest skeleton |
| High cohesion, low coupling | one owner per module, one-way dependencies, no reach-through or shared mutable state |

When they conflict: simplicity and reliability win; efficiency needs a measurement; elegance
constrains how, it never adds machinery. A boundary is not traded for speed, and crossing one
is a recorded decision. The lists, named styles and default tools in this flow are not a menu:
a better solution may be chosen, recorded with its rationale.

## When this flow applies

A card belongs here **iff** it creates or changes a recorded foundation decision: the
architecture style, the stack, an external contract, the configuration surface, the directory
tree or the repository gates. Everything else is implementation. A subsystem qualifies only
when it is independently deliverable and later cards build on it; a module inside the
application does not.

An existing project inherits its recorded foundation; a change is a delta, not a
re-scaffold. A fact is recorded with one of four dispositions: `inherited — <path>` when the
record exists and binds; `reconstructed — <evidence>` when the record is absent or partial and
the fact is derived from the tree; `not recorded — review question` when no evidence settles
it; `n/a — <reason>` when the capability is absent. A reconstruction never re-chooses a recorded
decision; a proposed change is a new card or ADR, with status
`Accepted (reconstructed) — E5 pending`.

A card that mixes foundation and feature runs this flow first and proposes the implementation
cards in its `## Handoff`. If the classification is genuinely unclear, ask through the board
and hold for the ladder's answer (`issue wait`); an escalation to `awaiting` or a bounded
timeout parks the turn.

## Inputs

The card, its brief and frozen acceptance; this card's `plan.md`; the `## Handoff` when the
director created this card from a design card; the existing repository's manifests, its
standard, architecture document, ADRs, contract, `.env.example`, directory tree and
`GLOSSARY.md`. On a reconstruction, the evidence the tree carries — manifests, lockfiles,
container files, entry points, tests, hooks, CI and the code that enforces an invariant — is
the input; a card is optional and `file:line` replaces it.

### 1. Frame the system

**Purpose.** State what the system is for, who consumes it, what is in and out of scope, the
constraints (time, team, compliance, hosting), the quality attributes that matter, and the
decision drivers.

**Watch for.** Do not invent the positioning: take it from the card, the `## Handoff` or the
existing README; if a card run has none, ask and hold. A reconstruction reads the README, the
manifest, the CLI help and the tests, and records `not recorded — review question` for what no
evidence settles. Name whether the project is a community open-source project or private; when
no source says, ask rather than assume either. Name the system boundary and its external
obligations.

**Essentials.** `docs/architecture.md` (or `.meerkat/<id>/architecture.md` for a card-local
change) records the positioning, the boundary, the quality attributes, the community posture
and the signals the style decision needs: how much of the value is domain rules, how many
subdomains exist, whether domain experts and contested terms exist, and how long the model must
live.

### 2. Decide the direction

**Purpose.** Choose the architecture style and the stack as decisions, not defaults.

**Watch for.** Compare viable options with the reasons the rejected ones lost (2–3 is a useful
default); an option without rejected alternatives is not a decision. DDD pays when the domain
rules and invariants are the hard part, experts and contested terms exist, several subdomains
need different models, and the model is long-lived; a simpler style pays on thin or CRUD-shaped
domains, or when the team cannot carry the layers. If DDD is chosen, name its bounded contexts,
aggregates and context map; if not, name the simpler style (layered, hexagonal-lite,
transaction-script, functional core / imperative shell) and record why DDD was rejected and the
cost accepted. The style is never `n/a`; record a revisit trigger.

**Essentials.** One decision round settles the style and the stack together, style first. Each
durable decision gets an ADR at `docs/adr/NNNN-<slug>.md` with context, decision and why. A
`## Tech stack` table in `docs/tech-spec.md` (or `.meerkat/<id>/tech-spec.md` for a card-local
delta) records one concrete choice per row: frontend, backend, persistence, container/build and
contracts. Versions are pinned; `n/a — <reason>` stands in for an absent layer; no row says
`TBD`; do not mix two frameworks or two component libraries; check compatibility across the
rows.

**The stack rule.** An existing project inherits its recorded stack (`inherited — <path>`) and
does not re-choose or migrate without a card that asks. **Create** chooses and records the
table. **Extend** with a missing recorded table is a foundation gap: ask, or propose a
Reconstruct. **Reconstruct** rebuilds the table from the manifests, lockfiles, container files
and runtime, marking each row `reconstructed — <evidence>`. A **Conformance audit** records the
missing table as a finding and does not choose one.

Step 2 confirms the **direction**; Step 8 confirms the **package**.

### 3. Design the system skeleton

**Purpose.** Make the chosen style concrete: settle each design dimension once and record it in
one canonical artifact.

**Watch for.** One artifact is canonical per area. A literal a second module needs is a named
constant in one home; a deployment-dependent value is configuration; a runtime-changing value is
data. A release that changes stored data records backup, recovery, startup-apply and the
older-store upgrade path; a squashed baseline records its pre-baseline disposition. Every
exposure-widening default names its blast radius, and a credential in a URL or query string is a
finding.

**Essentials.** `docs/architecture.md` carries the boundaries, data model, error model, directory
tree and vertical slice; `docs/tech-spec.md` carries the normative rules, each with its
enforcement point.

#### Boundaries and data model

Name each module, what it owns and what it may import; dependencies point one way. Define the
data model and migrations, one error taxonomy mapped to the contract, and the smallest vertical
slice that proves the skeleton.

#### External contract

Skip only when the system exposes no HTTP, RPC or event interface; record `n/a — <reason>`.
Default to RESTful HTTP unless the card names another style, and inherit a recorded contract
rather than rewriting it. One envelope carries the result: `"code"`, `"message"`, `"data"` and
`"errors"`; `code` is stable and independent of the HTTP status. Validate at the boundary with
one schema validator, record the unknown-field policy, define pagination explicitly, version
the surface, and name the canonical artifact (schema-first or code-first; generated sides are
never hand-edited, CI checks drift).

#### Configuration

One inventory (`.env.example`), one typed schema, one load order (process environment over env
file over defaults; flags over both), fail-fast validation naming every bad key, secrets outside
the repo and the log, and the configuration or constant boundary. `Hot reload` is a policy:
default to restart-required, list reloadable keys, validate before swapping, keep the old value
on a bad one.

#### Constants and enumerations

One home per literal; one definition per enumeration with its wire form, unknown-value policy
and label map. The enumeration is a `closed set`: adding a member is additive, removing or
renaming one is breaking, and an outside value is rejected or mapped to a documented fallback.

#### Logging

One logging module and one factory; no direct console calls; level and format from
configuration. Key flows log `info`; a caught exception logs once at the boundary that decides
its fate, with its code and correlation id, and exceptions log `error`. Never log a secret or
personal data.

#### Observability

Name the signals, thresholds and consumers before a platform. Instrument the vertical slice.
Name the `worst-case path that blocks` the runtime and whether liveness can still answer while
it is blocked.

#### Security boundaries

Name what is trusted and validated at each edge: loopback versus remote, anonymous versus
authenticated, the validation at every crossing, where secrets live and how they rotate, and the
one authorization decision point. Every exposure-widening default records its blast radius; an
audit records it rather than changing it.

#### Directory structure

One purpose per directory, a visible dependency direction, tests mirroring source, build output
and data ignored, and every entry point named. Record the tree in the architecture document and
instantiate exactly it in Step 4.

#### The technical specification

One standard: `docs/tech-spec.md` (a card-local delta is `.meerkat/<id>/tech-spec.md`). It is
normative: what a change must comply with, in the fewest checkable lines. Every rule is one
line and names its `enforcement point` — a test, lint rule, gate or `review`; number the rules
(`TS-01`, …). One rule names one enforcement point; two enforcement points are one rule, not
two. Changing a rule is a recorded decision (ADR + human E5), never a silent edit.

### 4. Scaffold the project

**Purpose.** Instantiate exactly the stack and tree recorded in Steps 2–3.

**Watch for.** A substitution is a recorded decision. On an existing project this step is
observation: a row is done when the artifact is found and its definition resolves, or the gap is
`missing — <reason>` with its follow-up; never re-scaffold an existing tree or create a second
standard. "Not applicable" is a written `n/a — <reason>`, never a missing file.

**Essentials.** Every row below has its artifact.

| Area | What exists |
|---|---|
| Layout and entry points | the planned tree instantiated exactly; source, tests, docs, migrations and entry files; a newcomer finds the entry from the README |
| Standard | every section of `docs/tech-spec.md` filled from the recorded decisions; no `TBD` |
| Contracts | when the system exposes HTTP: the envelope and error helper, the boundary validator, the pagination helper, the canonical contract and one smoke request; otherwise the recorded `n/a` |
| Configuration surface | `.env.example` naming every key the app reads, the typed loader and schema, the load order, the reload policy, no secret; a missing required key fails loudly |
| Constants and enumerations | one constants home and one definition per enum with its wire form, unknown-value policy and label map; a duplicated literal or a second copy fails the gate |
| Logging | the logger module and factory, the startup level and format keys, the correlation-id helper, the mandatory `info`/`error` sites; no application module calls `console` directly |
| Build and manifests | package/build manifest, lockfile, scripts for install, build, run, test, lint, typecheck and migrate |
| Quality tooling | formatter, linter and type checker configuration; all three run locally and fail non-zero |
| Test harness | runner configuration, fixture conventions, one smoke test that boots the skeleton |
| Local run | one documented command plus ports and configuration, from zero to reachable |
| Container / build path | when the runtime form is a container: build file, non-root user, healthcheck, local multi-service definition; otherwise the recorded `n/a` |
| CI skeleton | a pipeline running the Step 6 checks on a pull request |
| VCS | ignore rules for build output, data directories and environment files |
| Docs | the document set below |

**Project documents.** `README.md` carries purpose, run, test and links; `GLOSSARY.md` carries
the codebase terms and a `## Product language` pointer to `design/glossary.md` (or says product
terms are not recorded) without copying product terms; `CONTRIBUTING.md` carries where parallel
work is isolated, the protected line, the ref from which a card starts and the ref acceptance
lands into, the confirmation gate, the commit rule, the cleanup order and the local gate
commands; `CHANGELOG.md` has one empty `## [Unreleased]` between releases and one
`## [X.Y.Z] - YYYY-MM-DD` section per released version, written at the release merge and never
on a feature branch. On a community open-source project, also create `LICENSE`, `SECURITY.md`,
`CODE_OF_CONDUCT.md`, `.github/CODEOWNERS` and the issue/PR templates; otherwise record
`n/a — not a community open-source project` in the standard.

An existing project inherits its document set: read what it has and record the delta; adding a
missing document is a change, not a rewrite. Never commit a secret, add a dependency or licence
without a decision, or create a second source of truth.

### 5. Initialize the agent instructions

**Purpose.** Produce the agent-instruction baseline every session and every role reads first.
It is a requirement for every agent, not an optional nicety. Produce it after the scaffold so it
observes the real tree: the host's init step writes `CLAUDE.md` or `AGENTS.md` per the host's
read order; without an init step, produce the same content directly and say so.

**Watch for.** An init step guesses commands and layout. Resolve every line against the tree: a
fabricated path or an undefined command is the failure this review exists to catch. Apply two
tests to every remaining line — the **ownership test** (if another document owns the fact, keep
a one-line pointer and delete the restatement) and the **deletion test** (without it, would a
fresh session make a mistake?). On an existing project, bind the standard its own documents or
recorded path already names; improve the baseline that is there and regenerate only when the
card asks — a rewrite that drops an existing agreement is a regression. Keep one source of
truth: if the host reads `CLAUDE.md`, write it; if it reads `AGENTS.md`, generate it; make the
other a pointer. Do not maintain `CLAUDE.md` and `AGENTS.md` as competing copies. The task
entry — the `/meerkat` keywords and card scope — belongs to the install skill; if the file
already carries it, leave it untouched.

**Essentials.** The file points at `docs/tech-spec.md` as the standard; the spec, not the
baseline, carries the rules. It carries:

1. **Purpose and boundary** — what the project is, in one paragraph.
2. **Commands** — the entry commands exactly as the scaffold defines them: build, test
   (including a single file), run, lint, typecheck and migrate; the non-obvious variant a fresh
   session cannot guess.
3. **Layout** — the entry points and top-level directories with one line each, and a pointer to
   the canonical tree in `docs/architecture.md`; not a copy of the tree.
4. **Conventions** — a pointer to `docs/tech-spec.md`; the logging contract (key flows log
   `info`, a caught exception logs one `error` with its code, never a secret).
5. **Design principles** — all six principles bind every agent, with the conflict ordering; a
   change that violates one is a recorded decision, never a silent drift.
6. **Gates** — the gate path, the coverage floor, the security arms with their commands or a
   recorded `n/a — <reason>`, and the decision policy (block threshold, waivers, strict switch,
   exit codes).
7. **Working agreement** — decompose before executing; test-first, or the project's own
   red/green equivalent; verify in the place the project designates; confirm with the human
   before landing, closing or deleting.
8. **Change and integration policy** — where parallel work is isolated, the protected release line, the
   ref a card starts from and the ref acceptance lands into, what must be confirmed before it
   lands, the commit rule, and the cleanup order; point at `CONTRIBUTING.md`.
9. **Operational invariants** — one writer per surface, the identity and configuration roots,
   and the generated artifacts that are never hand-edited; point at the standard.
10. **Pointers** — the standard first, then `docs/architecture.md`, `GLOSSARY.md`,
    `CONTRIBUTING.md`, `docs/adr/`, the contract artifact and the configuration surface.

Update the file when a command, a gate or the layout changes; a stale pointer is worse than
none. Leave out architecture prose, design documents, ADR bodies, directory inventories and
details that will drift.

### 6. Record the gates, the release and the deploy path

**Purpose.** Make the local gate path run the same checks as CI, and record release and deploy
as separate paths.

**Watch for.** A gate is only a gate when it exercises the real entry point: name what each
runs and the change that makes it fail (a failure probe). A smoke test against a placeholder or
a service that answers only liveness is `not a gate — <reason>`; a post-deploy check proves the
product surface with one real read and one real flow, not liveness alone. Record an unexecuted
gate as `unverified — <reason>`, never a claimed pass. The coverage floor names every runtime
subsystem it excludes; a parity or drift check enumerates every enforcement site it covers; an
invariant guarded only by prose is review-only.

**Essentials.** The local gate path (pre-commit, pre-push, pre-tag) returns quickly, prints what
it runs and is idempotent; CI runs on every push and pull request: install from the lockfile →
lint, format check and typecheck → tests with the coverage floor → contract and canonical
contract checks → configuration-key and enumeration drift checks → build → security scan. Each
security arm records its exact command in the standard or `n/a — <reason>`. Record the one
command the independent reviewer re-runs as the project's `meta.review_gate`; the `meerkat`
board skill has the command, and the review card copies that gate.

#### Security toolchain

Four arms and one rule each: an arm either has a command that fails on an unaddressed
high/critical finding, or it records `n/a — <reason>`.

| Arm | Default tool | What the standard records | Blocks when |
|---|---|---|---|
| Dependency audit | `osv-scanner` (or `trivy`, or `npm audit --audit-level=high` for a JS lockfile) | one scan of every lockfile and the tree, as JSON | an advisory at or above the recorded threshold, with no unexpired waiver |
| Secret scan | `gitleaks` | a tree and history scan, as JSON | a credential is committed, in the tree or the history |
| SAST | CodeQL on a public GitHub repository; `semgrep` elsewhere or offline | the invocation, rule set and languages not covered | a high/critical rule finding is unaddressed |
| SBOM (inventory) | `syft` | SPDX or CycloneDX output | never blocks; it is the inventory the other answers are checked against |

Record the decision policy with the tools: the **recorded threshold** that blocks, the
**waiver window** and its caps, the strict switch and what each **exit code** means. A project
that grants no waivers records that. Pin each tool to a minimum version and record the check
that proves it is present. A committed secret is not waivered: rotate it, purge it, then record
what happened. A `.vue` or Svelte single-file component has no extractor in either SAST default;
record those files `n/a — no extractor` and let the reviewer's checklist cover them.

The standard's gate table carries the policy in one row:

| Security toolchain | Record every arm's command, its version floor, the report path and who may waive a finding; the block threshold, waiver window, strict switch and exit-code meaning live here. |

**Install it during system initialization.** This skill owns the mechanism as well as the
decision: `<skill-dir>/scripts/security-tools.mjs` reads the same four arms from
`<skill-dir>/assets/security/toolchain.json`, and `references/security-tools.md` documents
its contract. Run `--check` first; install only what is missing (`--install <tool>`), then
write the CI arm (`--ci-plan`, `--ci-write`) and record its command in the standard. Print
every install command and ask before changing the host; when no package manager is available,
print the command and record the arm `n/a — <reason>`. An offline host records
`n/a — offline`. The same pass never writes on `--check`.

#### Release and deploy

Release publishes a version; deploy runs it somewhere. They are separate paths and each
records its own `n/a — <reason>`. Release builds the artifact once and publishes exactly the
bytes that passed CI; a published version is immutable, fixed forward under a new version. A tag
is cut only from the mainline, only when the version, the release notes and the artifact agree.
Deploy promotes that same artifact from a release tag or the mainline; secrets live in the deploy
environment; every deploy has a healthcheck, a recorded rollback and a post-deploy check that
the running system, not the pipeline, serves the new version. A rollback names its trigger,
who decides and the exact previous artifact; a rollback of the artifact is not a rollback of the
data, and a release that changes stored data records its own recovery step. A deploy check names the command or service definition it starts and the entry point that command runs.

### 7. Self-check

**Purpose.** Audit the architecture package before presenting it.

**Watch for.** `self-check.md` (Architecture branch) is the authoritative checklist; this flow
does not restate it.

**Essentials.** Every requirement and quality attribute maps to the architecture document or an
ADR; the design stance is evidenced; the recorded standard is complete and every rule names its
enforcement point; the package in Step 8 is complete; the document set is single-sourced; no
secret, no host-absolute path, no second source of truth. The output is the requirement →
artifact table in `plan.md`, and the baseline carries the working agreement.

### 8. Architecture review

**Purpose.** The human decides the architecture direction; Linus presents the case.

**Watch for.** E5 belongs to the human, and a public API contract is E5; a configuration key
that touches a secret is E4. A subagent does not record E5: stop and ask through the board; the
director decides what it can and escalates E1–E5. Do not start implementation before the
decision is recorded. A no-card audit records the open decision as `E5 pending`, not on a card.

**Essentials.** Present the architecture package: the design-stance evidence, the options, the
style ADR, the recorded standard, the boundaries, the external contract, the configuration
surface, the directory tree, the document set, the gate path, the release and deploy paths and
the agent-instruction baseline. The human records the E5 decision; the director routes the
escalation and the `meerkat` board skill and `decision-policy.md` carry the mechanics. Record
the decision on the card before implementation starts.

### 9. Deliver

**Purpose.** Make the card reviewable and the next card possible.

**Watch for.** A report that cites a path must carry the `commit` anchor; the board's delivery
gate (`DELIVERY_NEEDS_COMMIT`) refuses one that does not. Do not merge, rebase or push from this
card; the supervisor's acceptance pass lands it and cleans up. Do not create the implementation
card; the director's triage creates it.

**Essentials.** Commit the delivered tree on the card's branch. Call the `meerkat` board skill
to deliver at `in_review`. In the delivery report's `conclusion`, write the architecture
`## Handoff`: the standard path, the architecture document, the card-local delta, the style and
ADR paths, the contract artifact, the configuration surface, the directory tree, the document
set, the gate path, the release and deploy paths (or their recorded `n/a`), the
agent-instruction baseline (`CLAUDE.md` or `AGENTS.md`), the acceptance source, the delivery
shape (one task, or an epic with children) and the proposed implementation cards. Mark the
handoff required (`meta.stage_handoff=required`; the `meerkat` board skill writes the metadata).
A no-card conformance audit writes artifacts only: no board state, no `in_review`, and E5 is
pending.

## Boundaries

- This flow designs the system, not a feature or module inside it.
- An existing project inherits its style, contract, configuration surface and tree; changing
  one is a recorded decision, not a silent retrofit.
- The standard is one document: changing a rule is a recorded decision (an ADR and the human's
  E5), never a silent edit.
- Write only the skeleton and its smoke test here; product behaviour belongs to the
  implementation branch.
- Migrations are append-only; a published contract or schema change needs the human.
- No destructive operation and no secret.
- An audit or no-card evaluation writes no project source and no board state; its findings and
  their evidence are the deliverable.
