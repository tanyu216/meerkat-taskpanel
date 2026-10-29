# Linus — system initialization and architecture design

Read this from the role workflow when a card creates a project or a subsystem, changes the
stack, or establishes or changes the repository's foundation. This is the **project's
system-initialization design flow**, not a feature or module design: it decides the system
whole — its style, boundaries, contracts, configuration, tree and gates. A feature, module
or behaviour change inside the recorded architecture belongs to
`implementation-workflow.md`. The architecture direction is **E5**: the project session
reviews it and the human decides it. Do not implement product behaviour here.

Board operations (claim, heartbeat, comment, report, deliver, move, brief refresh) are the
`meerkat` board skill's contract; load it before the first write.

Every step below names its output. A step is done when that output exists and is linked
from `.meerkat/<id>/plan.md`; do not start the next step while a decision is open.

## Design stance

Six principles decide the architecture, and each one has a test and an artifact. They are
tie-breakers in the decision round, not an opening paragraph; Step 8 presents the evidence.

| Principle | The question that tests it | Evidence in the design |
|---|---|---|
| Simple | Can a newcomer follow one primary use case end to end without a diagram? Is there one obvious way to do each thing? | The fewest modules and patterns that meet the requirements; no abstraction before a second caller |
| Reliable | What happens when each dependency fails, is slow, or returns garbage? | Named failure modes, fail-fast configuration, timeouts/retries/idempotency, health and observability |
| Efficient | Where is the cost (latency, memory, money) measured, and what is the bound? | A stated budget and a measurement point; no optimization without a number |
| Elegant | Do the tree, the contract and the names tell one story? | One source of truth, consistent naming, boring technology, least surprise |
| Not over-engineered | What happens if this layer, pattern or dependency is deleted? | Every abstraction names its forcing function; the smallest skeleton that proves the architecture; YAGNI |
| High cohesion, low coupling | Does each module or function have one reason to change, with dependencies pointing one way? | One owner per module; a one-way dependency direction; no reach-through or shared mutable state; a change stays inside its boundary |

When they conflict: **simplicity and reliability win; efficiency needs a measurement;
elegance constrains how, it never adds machinery.** A boundary is not traded for speed;
crossing one is a recorded decision. A pattern that cannot answer the deletion question is
not introduced — or is recorded as an explicit decision with its cost.

## When this flow applies

A card belongs here **iff** it creates or changes a recorded foundation decision: the
architecture style, the stack, an external contract, the configuration surface, the
directory tree or the repository gates. Everything else is implementation:
`implementation-workflow.md`. A subsystem qualifies only when it is independently
deliverable and later cards build on it; a module inside the application does not.

A card that mixes both runs this flow first and proposes the implementation cards in its
`## Handoff`; it does not implement them here. If the classification is unclear, write an
agent `question` and stop — do not route another role's work.

An existing project inherits its recorded foundation. Read its standard, architecture
document, ADRs, contract, `.env.example` and tree, and record `inherited — <path>`. A
foundation change is a delta; re-scaffolding or re-choosing a recorded decision is a
decision the card must ask for, not a side effect of running this flow. Extend the recorded
foundation; never fork a second one.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- `.meerkat/<id>/plan.md`;
- this card's `## Handoff` block, when the project session created this card from a design
  card;
- the existing repository, if any: its manifests, its standard (`docs/tech-spec.md`), its
  architecture document, ADRs, API contract, `.env.example`, directory tree and
  `GLOSSARY.md`.

## Steps

### 1. Frame the system

State the purpose, the consumers, what is in and out of scope, the constraints (time, team,
compliance, hosting), the quality attributes that matter (performance, reliability,
security, operability, cost) and the decision drivers.

Take the project's **positioning and purpose** from the card, the `## Handoff` or the
existing README; do not invent it. If it is missing, write a `question` and stop — the
architecture style depends on it. From that positioning, name the signals the style
decision needs: how much of the value is domain rules and invariants, how many subdomains
exist, whether domain experts and contested terms exist, and how long the model must live.

Record whether the project is a **community open-source project** — outside contributors and
a public channel for vulnerability reports — or a private one. Take it from the card, the
`## Handoff` or the existing README; when none of them says, write a `question` and stop
rather than assuming either. The answer decides the community-document group in Step 4,
including whether the project ships a licence file.

Name the system boundary and the external systems and contractual obligations it carries.
Design those contracts in Step 3, not here.

Output: `docs/architecture.md` for a new project, or `.meerkat/<id>/architecture.md` for a
card-local change, with the positioning, the boundary and the quality attributes.

### 2. Decide the direction

Run the decision round (the policy this handoff names) before choosing: the frontier of
questions whose prerequisites are settled, one round, one question string, a recommended
answer each. The architecture style and the tech stack are in the **same** round, style
first. Record the answers in `plan.md`. Do not build while a frontier item is open.

Put 2–3 viable options side by side: boundaries, data flow, operational cost, migration
risk, and why the rejected ones lost. An option without rejected alternatives is not a
decision. Record each durable decision as an ADR at `docs/adr/NNNN-<slug>.md`: 1–3
sentences of Context, Decision and Why; add `Status`, `Considered Options` and
`Consequences` when they help.

#### Choose the architecture style

Decide whether the system needs domain-driven design (DDD) from its positioning and domain
complexity, not from fashion. DDD pays when the domain model is the hard part; on a thin or
CRUD-shaped domain it adds layers, mappings and maintenance without a payoff. This is the
"not over-engineered" test applied to the largest decision in the flow.

| Signal | Points toward DDD | Points away |
|---|---|---|
| Where the value is | Business rules and invariants are the hard part | The work is CRUD, glue, reporting or translation |
| Domain expertise | Experts exist and terminology is contested | One obvious vocabulary serves everyone |
| Model shape | Several subdomains need different models and an anticorruption layer | One model serves the whole product |
| Lifetime and ownership | Long-lived, multiple teams, rules change often | A short-lived tool, prototype, script or pipeline |
| Cost of indirection | The team can carry the extra layers and mapping | The team or the deadline cannot |

Separate the two halves: **strategic DDD** (bounded contexts, ubiquitous language, context
mapping) usually pays earlier than **tactical DDD** (aggregates, repositories, domain
events, factories). Adopt either, both or neither, and say which.

If you adopt DDD, name the bounded contexts, their aggregates and invariants, the terms
that enter `GLOSSARY.md`, and the context map (shared kernel, anticorruption layer,
customer/supplier). If you do not, **name the simpler style** — layered, hexagonal-lite,
transaction-script, functional core / imperative shell — and record why DDD was rejected
and the cost you accepted. The style is never `n/a`.

Either way the style constrains the module boundaries in Step 3 and the directory tree.
Record it in an ADR with a revisit trigger (for example, "revisit when a second bounded
context appears"). The style is an E5 decision.

Output: the style decision and its ADR, and the bounded-context or layer list the skeleton
instantiates.

#### Record the stack

Before designing the skeleton, fix and record the stack as **one** decision bundle, not one
row at a time. Write a `## Tech stack` table into `docs/tech-spec.md` (new project) or
`.meerkat/<id>/tech-spec.md` (card-local change); `docs/architecture.md` points at it. Every
row records a concrete choice, or `n/a — <reason>` when the layer does not apply.

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
2. An existing project inherits its stack: read its standard, build and package manifests
   and its container files, and record `inherited — <path>`. Do not re-choose or migrate
   without a card that asks for it. If the inherited table is missing, write a `question`
   and stop; do not choose a stack for another card.
3. Check compatibility across the rows: framework ↔ build tool ↔ language; engine ↔
   driver/ORM ↔ migration tool; base image ↔ runtime; UI component layer ↔ styling layer.
4. A departure from the confirmed table, a new dependency or a licence carries a written
   rationale, an ADR and the human's E5 confirmation. Pin the runtime and major framework
   versions.
5. The confirmed table is the project's baseline: implementation cards inherit it and may
   not substitute a row silently. A substitution is a new recorded decision.

There is no preferred stack. The card chooses and justifies; the table records that choice,
it is not a menu to pick from.

Output: the answered questions in `plan.md`, the ADRs, and the `## Tech stack` table in
`docs/tech-spec.md` (or the card-local delta), linked from `.meerkat/<id>/plan.md`.

### 3. Design the system skeleton

Define the module boundaries and the dependency direction, the public interfaces and
contracts, the data model and migrations, the error model, configuration, observability,
the security boundaries, and the smallest vertical slice that proves the skeleton. The data
model and its migrations follow the persistence engine and migration tool recorded in
Step 2.

One artifact is canonical per design area; every other location points to it.

| Design area | Canonical artifact |
|---|---|
| Boundaries and data model | `docs/architecture.md` |
| Architecture style | `docs/adr/NNNN-<slug>.md`, summarised in the architecture document |
| Standard and conventions (stack, naming, layering, errors, configuration, constants, enumerations, logging, tests, gates) | `docs/tech-spec.md`; the architecture document, the baseline and the README point at it, and it points at the detailed artifacts |
| External contract | The OpenAPI document (or the stack's schema language); the architecture document only points at it |
| Configuration | `.env.example` plus the typed schema; other documents point at them |
| Constants and enumerations | The definition module in the source tree; the standard records the rule, and the contract and the UI label map point at it |
| Directory tree | `docs/architecture.md`; `CLAUDE.md`/`AGENTS.md` carry a top-level map and a pointer |
| Vocabulary | Root `GLOSSARY.md`; it links the product glossary rather than copying its terms |
| Change and integration policy | `CONTRIBUTING.md`; the agent-instruction baseline points at it |
| Release record | `CHANGELOG.md` |
| Community files (only when Step 1 records a community open-source project) | `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS` and the issue/PR templates |

#### Module boundaries and data model

Name each module, what it owns and what it may import; the dependency direction is one
way. Define the public interfaces and the error model (one error taxonomy, mapped to the
contract at the boundary), and the data model and its migrations; the security boundaries
get their own section below. Choose the smallest vertical slice that proves the skeleton and
name it.

**Constants and enumerations.** A literal a second module would need is a named constant in
one home — the module that owns the concept — not a copy. A value that differs per
deployment is configuration (the surface below); a value an operator changes at runtime is
data. An enumeration has one definition: the canonical set, its wire form and its
unknown-value policy live in one place, and every consumer imports it. It is a closed set —
adding a member is additive within the API version, removing or renaming one is breaking,
and a value arriving from outside is rejected or mapped to a documented fallback, never
accepted silently. The database constraint, the contract's enum and the UI's label map are
checked against that one definition.

Output: the boundaries, data model, error model, constants and enumeration homes and the
vertical slice in the architecture document.

#### External contracts

Skip this only when the system exposes no HTTP, RPC or event interface; record
`n/a — <reason>` instead. Distinguish **exposing** a contract (design the server side) from
**consuming** a third-party one (record the client boundary and the external specification;
do not impose your envelope on someone else's API). A static site that only calls APIs has
no server contract to design.

Default to **RESTful HTTP** over the resource model unless the card or the user names
another style (GraphQL, gRPC, an RPC envelope, event-driven). A preference is recorded, not
assumed; do not mix two styles for one surface, and inherit an existing non-REST contract
rather than rewriting it to the default.

Resources and transport:

- model nouns, not verbs; a collection and its items; the HTTP method carries the operation;
- the status code carries the transport outcome (`2xx` success, `4xx` client, `5xx` server),
  while the envelope carries the business outcome;
- version the surface (`/api/v1` or a version header) and state the breaking-change policy:
  changes within a version are additive, a breaking change is a new version and a human
  decision. Data migrations remain append-only.

One envelope, success and error:

```json
{"code": "0", "message": "ok", "data": { }, "errors": []}
```

- `code` is a stable, documented application code **independent of the HTTP status**; one
  documented value means success; a client switches on the code, never on the message. A
  numeric-looking code is fine if it is stable.
- `message` is a short human-readable summary, safe to display and never a stack trace, SQL
  fragment or internal path; the client does not parse it.
- `data` carries the payload: an object for one resource, a collection object for a list,
  and `null` on error.
- `errors` is a list of `{ "field"?, "code", "message", "detail"? }`; `field` is required on
  an input error. It says which input failed and why, not just that something failed.
- Success carries `data` and an empty `errors`; failure carries `errors` and a `null`
  `data`. Exactly one of them carries the result.
- Pagination metadata has one recorded home: inside `data` (the default, because the
  envelope has no `meta`) or a top-level `meta`, chosen once.
- One serializer produces the envelope, not each handler. A bare array, a bare scalar or a
  second envelope is a contract bug.
- Exceptions are listed in the contract: `204`, file downloads and streams, webhooks, and
  health/metrics endpoints may skip the envelope.

Validation and collections:

- validate at the boundary with one schema validator (the stack's idiomatic one): parse →
  validate → typed input for body, query, path and headers. Record the unknown-field policy
  and the coercion rules; handlers do not re-validate by hand.
- a validation failure is `400` (or `422` — pick one and record it) with the envelope and
  one `errors` entry per offending field. Validation errors are distinct from domain
  errors, which map their own codes to statuses. Never return the raw exception.
- paginate collections explicitly: offset (`page`, `page_size`, `total`, `has_more`) or
  cursor (`next_cursor`, `has_more`), with defaults and a maximum page size; offset paging
  needs a stable sort. The collection shape lives inside `data`, and an invalid page or
  cursor is a validation error, not an empty list.
- cross-cutting, recorded once: a request id echoed in the response and logs; an idempotency
  key for unsafe creates; one field-naming convention; UTC timestamps in ISO 8601; auth and
  rate-limit failures use the same envelope.
- name the contract's source of truth: schema-first or code-first, one canonical artifact
  (OpenAPI or the stack's equivalent), the generated side never hand-edited. CI checks
  drift.

Output: the contract in `docs/api-contract.md` (or the architecture document), the envelope
and error-code definitions, the validator path, the collection and pagination shape, and
the canonical contract path.

#### Configuration surface

Configuration is a contract with the operator, not a bag of environment reads.

- **Configuration or constant.** A value that differs per deployment, per environment or per
  operator is configuration and belongs in the inventory below; a value that is part of the
  program's meaning and identical everywhere — a protocol constant, a key name, a retry
  count the contract fixes — is a named constant in one home, never an environment read; a
  value an operator changes while the system runs is data, not configuration. Promoting a
  constant to a key and freezing a deployment-dependent value in code are each a recorded
  decision, never a convenience.
- **One inventory.** `.env.example` names every key the application reads, one per line,
  with a safe placeholder and a comment giving its purpose, allowed values and default. A
  real secret never appears; a key the application reads but the file omits is a defect, and
  a key the file lists but nothing reads is dead configuration.
- **One source of truth.** Either the typed schema or `.env.example` is canonical; the other
  points at it. Every document that mentions configuration points there instead of
  restating the keys.
- **One load order.** Process environment wins over the env file, which wins over built-in
  defaults; command-line flags, when the application has them, win over both. Document it
  once and implement it in one loader; a module that reads the environment directly is a
  second source of truth.
- **Typed and validated at startup.** Parse the resolved values into a typed configuration
  object once and fail fast, naming every missing or malformed key. Mark each key required
  or optional-with-default; record the unknown-key policy; never fall back silently for a
  required key.
- **Secrets.** The env file is gitignored; deployment secrets live in the deploy
  environment; a token file is `0600`; a secret never reaches a log, an error or the
  committed example.
- **Environments.** Commit `.env.example`, ignore `.env`, `.env.local` and `.env.<env>`, and
  say where each environment's values come from.
- **Hot reload is a policy, not a side effect.** It means runtime configuration reload, not
  a development server's HMR. Default to restart-required. Name the keys that may reload
  without a restart (feature flags, log level, limits) and the keys that never do
  (listeners, ports, database DSNs, secrets). A reload validates the new value first, swaps
  it atomically, and records the change; a bad value keeps the old configuration and
  reports. A production filesystem watcher is a decision, not a default.

For a library, a static site or anything with no long-running process, record
`n/a — no runtime configuration` or `n/a — no long-running process` for the reload policy.

Output: the configuration section of the architecture document, the `.env.example`, the
loader path and the reloadable-key list.

#### Logging

Logging is a contract with the operator, like configuration: designed once here, scaffolded
in Step 4, and binding on every role through the agent-instruction baseline.

- **One logging module.** Application code gets a logger from one factory and never writes
  to `console` directly; the factory is configured once at startup from the configuration
  surface (`LOG_LEVEL` and the format) and fails fast on an invalid level.
- **Levels have one meaning.** `error` — the operation failed and a human must know;
  `warn` — degraded but handled; `info` — a key flow started, finished or changed state;
  `debug` — diagnosis, off by default. The level is configuration; the choice at a call
  site is not.
- **Key flows log `info` — mandatory.** Process start and stop (version and a secret-free
  config summary); every inbound request, task or job at entry and completion (correlation
  id, outcome, duration); every outbound dependency call (target, outcome, duration); every
  recorded state transition; every background pass; every configuration load or reload
  decision. A key flow with no `info` line is an omission, not a style choice.
- **Exceptions log `error` — mandatory.** Every caught exception is logged once, at the
  boundary that decides its fate, with the error taxonomy code, the correlation id and the
  operation context — never a bare message, and never a stack trace on a success path. A
  layer that only rethrows does not log; one incident produces one `error` line. Startup
  failure and a failed health check are `error`.
- **Structured, one event per line.** Timestamp, level, a stable event name, a correlation
  or request id, and the relevant ids as fields; the human message does not carry data a
  consumer would parse. One correlation id threads a flow.
- **Never a secret or PII.** Tokens, passwords, keys, full request bodies and personal data
  are redacted at the logger boundary, not at each call site.
- **Test it.** The scaffold ships a test that a key flow emits its `info` line and a thrown
  exception emits one `error` line carrying its code.

For a library or a static site with no long-running process, record
`n/a — no runtime logging`; the host application owns its own start/stop and health
logging, and a library still logs its caught exceptions through the caller's logger.

Output: the logging section of the architecture document, the logger path, the level and
format keys, the mandatory `info` and `error` call sites, and the correlation id.

#### Observability

Name what is measured, the threshold that matters and who acts on it — latency, error rate,
saturation, queue depth or the domain's own counters — before naming a platform. Instrument
the vertical slice; a dashboard or alert with no consumer is not added. Logging, designed
above, is one signal, not the observability plan.

Output: the observability section of the architecture document — the signals, their
thresholds and their consumers.

#### Security boundaries

Name what is trusted and what is validated at each edge: loopback versus remote, anonymous
versus authenticated, the validation performed at every boundary crossing, where secrets
live and how they are rotated, and the one place each authorization decision is made. A
boundary that trusts by convenience is a recorded decision.

Output: the security boundaries in the architecture document.

#### Directory structure

Plan the tree before creating it. The tree makes the architecture visible: a reader should
see the style chosen in Step 2 and the boundaries chosen above in the directory names.

- one purpose per directory, named for the context or layer it owns; a directory that needs
  an "and" in its name is two directories;
- the dependency direction is visible: `domain`/`application`/`infrastructure`, or one
  directory per bounded context with the same split inside;
- in a monorepo, record the package boundaries and the public versus internal surface;
- tests mirror the source tree at the same paths, so a missing test is visible;
- source, tests, docs, migrations, scripts, deploy and generated output are separate;
- generated output, build artifacts and data directories are gitignored, not committed;
- every entry point is named.

Record the tree in the architecture document and instantiate exactly it in Step 4. Step 5
copies a top-level map and a pointer into the agent instructions. An existing project
records `inherited — <path>`; if no tree is recorded, reconstruct it with the human or ask,
never invent it silently.

Output: the directory tree in the architecture document, each directory with its purpose.

Step output: the skeleton design in the architecture document — boundaries and data model,
the external contract, the configuration surface, the constants and enumeration homes, the
observability plan, the security boundaries and the directory tree — with the vertical
slice named, and the standard in `docs/tech-spec.md` complete.

#### The technical specification

The project has one standard: `docs/tech-spec.md` — a card-local foundation delta is
`.meerkat/<id>/tech-spec.md`. It is written across the flow: Step 2 seeds its `## Tech stack`
table, this step fixes its sections and rules, and Step 4 fills them against the scaffold.
It is normative, not a design narrative: what a code change
must comply with, in the fewest lines that can be checked. The architecture document keeps
the design — positioning, style, boundaries, data model and tree — and points here; this
document points at the canonical artifact for each detail and never restates it.

| Section | Must contain | Done when |
|---|---|---|
| Authority and change | what it binds, who may change it (a card, an ADR, the human's E5), the review gate, what it deliberately does not govern | a reader knows how to change a rule and where the decision is recorded |
| Tech stack | the `## Tech stack` table: frontend, backend, persistence, container/build and contracts, versions pinned, `n/a — <reason>` per absent layer | every row is a concrete choice; no `TBD` |
| Structure and dependencies | the one-way dependency direction, module ownership, the constants home, the enumeration definition module and the tree rule; pointer to the tree in the architecture document | a new file, literal or enum member has exactly one legal home |
| Naming | files, modules, types, routes, database objects, environment keys, constant and enum names, and test files | a reviewer can reject a name by citing one line |
| Errors and contract | one error taxonomy, the envelope, validation, pagination, versioning, the wire enumerations and their unknown-value policy; pointer to the contract artifact | a failure has one code and one shape, and an unknown enum value has one documented fate |
| Configuration | one inventory, one loader, the load order, fail-fast, the configuration-versus-constant boundary and the reload policy; pointer to `.env.example` | an unlisted key is a defect, and a deployment-dependent literal in code is not a key |
| Logging | one logger, the level meanings, the mandatory `info` and `error` sites, the correlation id and redaction | a key flow has its line; no secret is logged |
| Tests and gates | test layout and naming, the coverage floor, the local gates and the CI checks | a change knows what must pass before delivery |
| Security toolchain | one row per arm — dependency audit, secret scan, SAST, SBOM — with the tool, its version floor, the exact local and CI command, the report path and who may waive a finding; `n/a — <reason>` per arm the project does not run | every arm has a command that fails on an unaddressed high/critical finding, or records why it does not apply |
| Release and delivery | release and deploy invariants, artifact immutability, rollback and its data plan | each path records its invariant or its `n/a` |
| Project documents | the core set and its paths — `README.md`, `GLOSSARY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`; the community group (`LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS`, issue/PR templates) when Step 1 records a community open-source project, otherwise `n/a — not a community open-source project`; who owns the vocabulary, the change policy and the release record | every required document exists or its `n/a` is recorded, and no two documents restate the same rule |

A rule is one line, imperative, with the enforcement that catches a violation — a test, a
lint rule, a gate, or `review`. A rule with no enforcement point is a wish: remove it or
record it as review-only. Number the rules (`TS-01`, …) so a card and a review can cite one.
The six design principles live in the architecture document's design stance; this document
cites them rather than restating them.

Changing a rule is a recorded decision — an ADR and the human's E5, never a silent edit; a
pinned version changes through the same path. A published rule is not weakened quietly: the
change names the rule it replaces and why.

Output: `docs/tech-spec.md` (or the card-local delta) with every section filled, the stack
table in its own section, and every rule naming its enforcement point.

### 4. Scaffold the project

Instantiate exactly the stack recorded in Step 2; a substitution is a recorded decision.
The scaffold is complete only when every row below has its artifact. "Not applicable" is a
written `n/a — <reason>`, never a missing file.

| Area | Must contain | Done when |
|---|---|---|
| Layout and entry points | the directory tree planned in Step 3, instantiated exactly; source tree, test tree, docs, migrations, entry files | a newcomer finds the entry from the README and every planned directory exists |
| Standard | every section of `docs/tech-spec.md` filled from the recorded decisions, each rule naming its enforcement | the stack table matches the manifests, no section says `TBD`, and a rule the scaffold cannot meet is a recorded decision, not a silent drift |
| Contracts | when the system exposes an HTTP API: the envelope and error helper, the boundary validator, the pagination helper, the canonical contract document and one smoke request; otherwise the recorded `n/a` | a request round-trips through the envelope and a validation failure returns the documented error shape |
| Configuration surface | `.env.example` naming every key the app reads, the typed loader and schema, the load order, the reload policy, no secret | a missing required key fails loudly, never a silent default |
| Constants and enumerations | one constants home and one definition per enum carrying its wire form, unknown-value policy and label map; the lint rule or test that fails on a duplicated literal or a second copy of a set | a duplicated value or a divergent copy fails the gate |
| Logging | the logger module and factory, the startup level and format keys, the correlation-id helper, and the mandatory `info`/`error` call sites wired into the vertical slice | a key flow emits its `info` line, a thrown exception emits one `error` line with its code, and no application module calls `console` directly |
| Build and manifests | package/build manifest, lockfile, scripts for install / build / run / test / lint / typecheck / migrate | a clean environment builds with one command |
| Quality tooling | formatter, linter and type checker configuration | all three run locally and fail non-zero |
| Test harness | runner configuration, fixture conventions, one smoke test that boots the skeleton | the smoke test passes |
| Local run | one documented command plus ports and configuration | from zero to reachable |
| Container / build path | only when the runtime form is a container: build file, non-root user, healthcheck, local multi-service definition; otherwise the recorded `n/a` | the build file builds and the healthcheck passes |
| CI skeleton | a pipeline running the Step 6 checks | it runs on a pull request |
| VCS | ignore rules for build output, data directories and environment files | no generated file is committed |
| Docs | the document set in `#### Project documents` below | every required document exists and every link resolves |

#### Project documents

The documents that outlive any one card are scaffolded here, each with one owner and one
canonical location. The core set is always created; the community group is created, or
recorded as `n/a — not a community open-source project` in the standard, from the posture
Step 1 recorded.

| Document | Must contain | Done when |
|---|---|---|
| `README.md` | purpose, run, test and links to the architecture document and the standard | every link resolves |
| `GLOSSARY.md` | the codebase's canonical terms; a `## Product language` section that links the product glossary or states product terms are not recorded; no copied product terms | every role reads one vocabulary file |
| `CONTRIBUTING.md` | where parallel work is isolated, the protected line, the ref a card starts from and the ref acceptance lands into, the confirmation gate, the commit rule, the cleanup order and the local gate commands | a newcomer can land a change without asking |
| `CHANGELOG.md` | one empty `## [Unreleased]` section between releases and one `## [X.Y.Z] - YYYY-MM-DD` section per released version, written at the release merge and never on a feature branch | the pre-tag gate can read a section for the version |
| `LICENSE` | the licence text and copyright holder for the licence decision Step 2 recorded; only when Step 1 records a community open-source project | the file is the recorded decision, not a default |
| `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS`, issue/PR templates | the vulnerability-disclosure path, the contribution conduct and the ownership map; only when Step 1 records a community open-source project | each exists, or the standard records `n/a — not a community open-source project` |

An existing project inherits its document set: read what it already has and record the delta.
Adding a missing document is a change, not a rewrite — the same rule the recorded foundation
follows.

Never commit a secret, add a dependency or licence without a decision, or create a second
source of truth.

Output: the scaffold tree, a passing smoke test, and the local run command recorded in the
README.

### 5. Initialize the agent instructions

The agent-instruction baseline is a **requirement for every agent** on this project, not an
optional nicety. Produce it after the scaffold so it observes the real tree: the host's init
step writes `CLAUDE.md` or `AGENTS.md` per the host's read order. Without an init step,
produce the same content directly and say so. Name the standard by its actual path:
`docs/tech-spec.md` is the path this flow creates for a new project (or the card-local
delta); an existing project binds the document or small set of documents its own README or
architecture document already names as the standard, and the baseline points there — never
at a substitute. The spec, not the baseline, carries the rules. A project that records no
standard is not an architecture delivery: this flow creates one or asks.

On an existing project, improve the baseline that is there: keep every section that still
resolves, add what is missing, and regenerate only when the card asks for it — a rewrite that
drops an existing agreement is a regression.

Review the generated file — an init step guesses commands and layout. Resolve every line
before accepting it: open each named path against the tree, run each documented command or
confirm the manifest defines it, and check every port, environment key and directory against
the recorded configuration surface and tree. Remove or correct what does not resolve; a
fabricated path or an undefined command is the failure this review exists to catch. Then
apply two tests to every remaining line: the **ownership test** — if another document owns
the fact, keep a one-line pointer and delete the restatement — and the **deletion test** —
without it, would a fresh session make a mistake? Keep one source of truth: if the host
reads `CLAUDE.md`, write it; if it reads `AGENTS.md`, generate it; make the other a pointer.
Do not maintain `CLAUDE.md` and `AGENTS.md` as competing copies.

The task entry — the `/meerkat` keywords and the card scope — belongs to the install
skill; if the file already carries it, leave it untouched.

The file is the entry map every session and every role reads first, not a manual. It must
carry:

1. **Purpose and boundary** — what the project is, in one paragraph.
2. **Commands** — the entry commands exactly as the scaffold defines them: build, test
   (including a single file), run, lint, typecheck and migrate; add the non-obvious variant
   a fresh session cannot guess (the container gate, a required env file). Do not transcribe
   scripts the manifest already lists in full.
3. **Layout** — the entry points and the top-level directories a newcomer must know first,
   one line of purpose each, with a pointer to the canonical tree in `docs/architecture.md`.
   Do not restate the full tree: `ls` and the architecture document already carry it.
4. **Conventions** — point at `docs/tech-spec.md`: the project's standard carries the
   dependency direction and module boundaries, the error model, the configuration surface,
   the external contract and the logging contract (key flows log `info`, a caught exception
   logs one `error` with its code, never a secret), and it points at `.env.example` and the
   contract file. Name it once here; do not restate a rule.
5. **Design principles** — the six principles bind every agent, not only the architect:
   simple, reliable, efficient, elegant, not over-engineered, and high cohesion / low
   coupling, with the conflict ordering including the boundary rule. Name all six in the
   generated file, not "the six principles" as a phrase; a change that violates one is
   recorded as an explicit decision, never a silent drift.
6. **Gates** — what must pass before delivery: the gate path, the coverage floor and the
   security scan's three arms (dependency audit, secret scan, SAST), each with the command
   the standard records or its recorded `n/a — <reason>`; point at the CI pipeline for the
   job detail.
7. **Working agreement** — how a session works in this project: decompose before executing;
   test-first, or the project's own red/green equivalent; verify in the place the project
   designates; confirm with the human before landing, closing or deleting. State the rule,
   not the ceremony.
8. **Change and integration policy** — the project's own contract for how a change lands:
   where parallel work is isolated, which branch or release line is protected, the ref a
   card starts from and the ref acceptance lands into, what must be confirmed before it
   lands, the commit rule that makes a delivery verifiable (the delivered tree is committed
   and the report names that commit), and the cleanup order. Point at `CONTRIBUTING.md` or
   the standard for the detail; carry only the rules a fresh session would otherwise
   break.
9. **Operational invariants** — the state a fresh session can break and cannot see from the
   code: who may write a given surface (one writer per surface; a second writer is a defect),
   where runtime identity and configuration are read from, and which artifacts are generated
   and must never be hand-edited. One line each; point at the standard for the detail.
10. **Pointers** — link the standard first (its recorded path; `docs/tech-spec.md` on a
    project this flow created), then `docs/architecture.md`, `GLOSSARY.md`,
    `CONTRIBUTING.md`, `docs/adr/`, the contract artifact and the configuration surface; do
    not copy their content.

These items are a floor, not a ceiling. A rule a fresh session can break that no pointed-at
document owns belongs here, one line each, with its enforcement.

Leave out architecture prose, design documents, ADR bodies, directory inventories and
details that will drift. This file is a map, not a mirror: every line is resident in every
session, so carry only what a fresh session cannot reconstruct with `ls`, the manifest or a
pointer — the rest goes behind the pointer. Update the file when a command, a gate or the
layout changes; a stale pointer is worse than none. A session reads the standard before the
first code change; the baseline says so and does not repeat it.

Output: the agent-instruction baseline — `CLAUDE.md` or `AGENTS.md` — reviewed, with the
entry-point map, the design principles, the working agreement, the change and integration
policy, the operational invariants and the pointer to the standard, named as the entry
baseline in the delivery.

### 6. Record the gates, the release and the deploy path

The local gate path runs the same checks as CI, so a host-only bypass cannot ship. It stays
offline and fast, prints what it runs, and is idempotent.

| Stage | Must stop | Done when |
|---|---|---|
| Local pre-commit | formatting, lint or typecheck failures on staged files; an edited or non-contiguous migration; a secret, a host-absolute path or a generated file | it returns in seconds; a fixable finding is fixed and re-staged |
| Local pre-push | a failing test suite (the affected set, plus the full suite before a merge); a stale contract or interface snapshot; a declared request schema that differs from the handler; a canonical contract document that no longer matches the handlers; a lockfile that does not match its manifest | it runs the same checks as the CI test job |
| Local pre-tag | a version that disagrees with the manifest; a tag without its CHANGELOG section; a release build that fails | it passes before the tag is created |

CI runs on every push and pull request: install from the lockfile → lint, format check and
typecheck (including the duplicated-literal rule) → tests with the coverage floor → contract
and canonical-contract checks → a configuration-key check (every key the application reads
is named in `.env.example`) → an enumeration drift check (each documented wire enum matches
the values its handler accepts) → build the artifact → security scan (dependency audit,
default `osv-scanner`; secret scan; SAST) with no unaddressed high or critical finding. Each
arm's command is recorded in the standard; an arm the project does not run records
`n/a — <reason>`.

#### Security toolchain

Four arms and one rule each: an arm either has a command that fails on an unaddressed
high/critical finding, or it records `n/a — <reason>` in the standard. Every default tool
is free to use; the standard records the exact command, never a tool name alone.

| Arm | Default tool | What the standard records | Blocks when |
|---|---|---|---|
| Dependency audit | `osv-scanner` (alternative: `trivy`, or `npm audit --audit-level=high` for a JS lockfile) | one scan of every lockfile and the tree, as JSON | an advisory scores CVSS >= 7.0 and no unexpired waiver covers it |
| Secret scan | `gitleaks` | a tree and history scan, as JSON | a credential is committed, in the tree or the history |
| SAST | CodeQL on a public GitHub repository; `semgrep` on any other host or offline | the static-analysis invocation, its rule set and the languages it does not cover | a high/critical rule finding is unaddressed |
| SBOM (inventory) | `syft` | SPDX or CycloneDX output | never blocks; it is the inventory the other answers are checked against |

Pin each tool to a minimum version, and record the check that proves it is present. A
committed secret is not waivered the way an advisory is: rotate it, purge it, then record
what happened. A `.vue` (or Svelte) single-file component has no extractor in either SAST
default: the standard records those files `n/a — no extractor`, and the reviewer's manual
checklist covers them.

#### Release and deploy

**Release** publishes a version; **deploy** runs it somewhere. They are separate paths and
each records its own `n/a — <reason>`: a library, a CLI or a local-first tool publishes and
never deploys, so recording `n/a` for both would erase the release that does happen.

- **Release** builds the artifact once and publishes exactly the bytes that passed CI; it
  never rebuilds per environment. A published version is immutable: it is never reused or
  overwritten, and a defect is fixed forward under a new version with the bad one deprecated
  rather than silently replaced. A tag is cut only from the mainline, only when the version,
  the release notes and the built artifact agree, and the last proof is installing and
  starting the published artifact outside the source tree.
- **Deploy** promotes that same artifact to a runtime target, only from a release tag or the
  mainline. Secrets live in the deploy environment, never in the repository; every deploy
  has a healthcheck, a recorded rollback, and a post-deploy check that the running system —
  not the pipeline — serves the new version.
- **Rollback** names its trigger, who decides, and the exact previous artifact. A rollback
  of the artifact is not a rollback of the data: a release that changes stored data records
  its own recovery step, and a published version is not rolled back at all.

Record each path's invariant and its done-when, never the tool that implements it: the
project names its pipeline file, registry and environment settings in its own baseline.

Output: the local gate path wired, the CI pipeline file, and the release and deploy paths
— each with its `n/a` when absent — with the rollback each one relies on.

### 7. Self-check

Run `self-check.md` (Architecture branch). It is the authoritative checklist and this flow
does not restate it; this step names only the proof the architecture package must carry:

- every requirement and quality attribute maps to the architecture document or an ADR;
- the design stance is evidenced: the simplest reliable option was chosen, every abstraction
  and dependency names its forcing function, no layer exists only for symmetry, and modules
  have one reason to change with dependencies pointing one way;
- the recorded standard is complete: every section is filled, the stack table lives there
  and nowhere else, and every rule names its enforcement point;
- the architecture package in Step 8 is complete; the agent-instruction baseline carries
  the working agreement, the change and integration policy and the operational invariants,
  and every path and command it names resolves against the tree and the manifest;
- the document set is complete and single-sourced: `README.md`, `GLOSSARY.md`,
  `CONTRIBUTING.md` and `CHANGELOG.md` exist, the community group exists or its recorded
  `n/a` stands in, each document has one owner, and no two restate the same rule;
- no secret, no host-absolute path, no second source of truth.

Output: the requirement → artifact table in `plan.md`.

### 8. Architecture review

Present the **architecture package** — the design-stance evidence, the options, the style
ADR, the recorded standard (`docs/tech-spec.md` for a project this flow created; its stack
table with pinned versions, its rules and their enforcement), the boundaries, the external
contract, the configuration surface, the directory tree, the project document set, the gate
path, the release and deploy paths and the agent-instruction baseline — to the project
session. E5 belongs to the human; a public API contract is E5, and a configuration key that
touches a secret is E4.
Record the decision on the card. Do not start implementation before the review is recorded.

Output: the recorded E5 decision on the card.

### 9. Deliver

Commit the work on the card's branch before you report — a report that cites a path must
carry the `commit` anchor (`DELIVERY_NEEDS_COMMIT`), and `report template` stamps `HEAD`
only on a clean tree; on a dirty tree pass `--commit <sha>`. Do not merge, rebase or push
from this card; landing and cleanup belong to the project session.

Re-export the brief, mark the handoff required, and write the architecture variant of the
`## Handoff` block into the delivery report's `conclusion`: one architecture-package sentence
naming the standard (`docs/tech-spec.md` for a new project, the inherited binding or the
card-local delta otherwise), the architecture document, `.meerkat/<id>/architecture.md` (when
the change is card-local), the style and
other ADR paths, the contract artifact, the configuration surface, the directory tree, the
document set, the gate path, the release and deploy paths (or their recorded `n/a`), the
agent-instruction baseline (`CLAUDE.md` or `AGENTS.md`), the acceptance source,
the `Delivery shape` (one task, or an epic with children) and the proposed implementation
card(s). Deliver at `in_review` with the evidence. Do not create the implementation card;
the project session triages it, seeds its acceptance and links it to this card as a blocker
(or as a parent for an epic), using the `meerkat` board skill's relation command.

The self-check audits this card; the `## Handoff` block is the cross-card transfer. A
producer card has both.

## Boundaries

- This flow designs the system, not a feature or module inside it; a module-scoped card
  belongs to `implementation-workflow.md`.
- An existing project inherits its style, contract, configuration surface and tree;
  changing one is a recorded decision, not a silent retrofit.
- The standard is one document: changing a rule is a recorded decision (an ADR and the
  human's E5), never a silent edit.
- Write only the skeleton and its smoke test here; product behaviour belongs to the
  implementation branch.
- Migrations are append-only. A published contract or schema change needs the human.
- No destructive operation and no secret.
