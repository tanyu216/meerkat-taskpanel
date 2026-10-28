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

An existing project inherits its recorded foundation. Read its architecture document, ADRs,
contract, `.env.example` and tree, and record `inherited — <path>`. A foundation change is
a delta; re-scaffolding or re-choosing a recorded decision is a decision the card must ask
for, not a side effect of running this flow.

## Inputs

- `.meerkat/<id>/card.md`, the live card and the frozen `acceptance` snapshot;
- `.meerkat/<id>/plan.md`;
- this card's `## Handoff` block, when the project session created this card from a design
  card;
- the existing repository, if any: its manifests, architecture document, ADRs, API
  contract, `.env.example`, directory tree and `GLOSSARY.md`. Extend it; never fork a
  second foundation.

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
| External contract | The OpenAPI document (or the stack's schema language); the architecture document only points at it |
| Configuration | `.env.example` plus the typed schema; other documents point at them |
| Directory tree | `docs/architecture.md`; `CLAUDE.md`/`AGENTS.md` carry a top-level map and a pointer |

#### Module boundaries and data model

Name each module, what it owns and what it may import; the dependency direction is one
way. Define the public interfaces and the error model (one error taxonomy, mapped to the
contract at the boundary), the data model and its migrations, and the security boundaries.
Choose the smallest vertical slice that proves the skeleton and name it.

Output: the boundaries, data model, error model and vertical slice in the architecture
document.

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

The observability plan names what is measured and alerted, without inventing a platform
before a consumer needs it; logging is designed above. The security boundaries name what is
trusted and what is validated at each edge. The vertical slice is the smallest end-to-end
path that proves the skeleton — not a product feature.

Output: the skeleton design in the architecture document — boundaries and data model, the
external contract, the configuration surface and the directory tree — with the vertical
slice named.

### 4. Scaffold the project

Instantiate exactly the stack recorded in Step 2; a substitution is a recorded decision.
The scaffold is complete only when every row below has its artifact. "Not applicable" is a
written `n/a — <reason>`, never a missing file.

| Area | Must contain | Done when |
|---|---|---|
| Layout and entry points | the directory tree planned in Step 3, instantiated exactly; source tree, test tree, docs, migrations, entry files | a newcomer finds the entry from the README and every planned directory exists |
| Contracts | when the system exposes an HTTP API: the envelope and error helper, the boundary validator, the pagination helper, the canonical contract document and one smoke request; otherwise the recorded `n/a` | a request round-trips through the envelope and a validation failure returns the documented error shape |
| Configuration surface | `.env.example` naming every key the app reads, the typed loader and schema, the load order, the reload policy, no secret | a missing required key fails loudly, never a silent default |
| Logging | the logger module and factory, the startup level and format keys, the correlation-id helper, and the mandatory `info`/`error` call sites wired into the vertical slice | a key flow emits its `info` line, a thrown exception emits one `error` line with its code, and no application module calls `console` directly |
| Build and manifests | package/build manifest, lockfile, scripts for install / build / run / test / lint / typecheck / migrate | a clean environment builds with one command |
| Quality tooling | formatter, linter and type checker configuration | all three run locally and fail non-zero |
| Test harness | runner configuration, fixture conventions, one smoke test that boots the skeleton | the smoke test passes |
| Local run | one documented command plus ports and configuration | from zero to reachable |
| Container / build path | only when the runtime form is a container: build file, non-root user, healthcheck, local multi-service definition; otherwise the recorded `n/a` | the build file builds and the healthcheck passes |
| CI skeleton | a pipeline running the Step 6 checks | it runs on a pull request |
| VCS | ignore rules for build output, data directories and environment files | no generated file is committed |
| Docs | README with purpose, run, test and a link to the architecture document | every link resolves |

Never commit a secret, add a dependency or licence without a decision, or create a second
source of truth.

Output: the scaffold tree, a passing smoke test, and the local run command recorded in the
README.

### 5. Initialize the agent instructions

The agent-instruction baseline is a **requirement for every agent** on this project, not an
optional nicety. Produce it after the scaffold so it observes the real tree: the host's init
step writes `CLAUDE.md` or `AGENTS.md` per the host's read order. Without an init step,
produce the same content directly and say so. A project without this file is not an
architecture delivery.

Review the generated file — an init step guesses commands and layout — and correct both
against the planned tree and the recorded stack. Keep one source of truth: if the host reads
`CLAUDE.md`, write it; if it reads `AGENTS.md`, generate it; make the other a pointer. Do
not maintain `CLAUDE.md` and `AGENTS.md` as competing copies.

The task entry — the board block and its scope — belongs to the install skill; if the file
already carries it, leave it untouched.

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
4. **Conventions** — the one-line rule for dependency direction and module boundaries, the
   error model, the configuration surface, the external contract and the logging contract
   (key flows log `info`, a caught exception logs one `error` with its code, never a
   secret), each pointing at its canonical artifact (the architecture document,
   `.env.example`, the contract file) rather than restating it.
5. **Design principles** — the six principles bind every agent, not only the architect:
   simple, reliable, efficient, elegant, not over-engineered, and high cohesion / low
   coupling, with the conflict ordering including the boundary rule. Name all six in the
   generated file, not "the six principles" as a phrase; a change that violates one is
   recorded as an explicit decision, never a silent drift.
6. **Gates** — what must pass before delivery: the gate path, the coverage floor and the
   security scan; point at the CI pipeline for the job detail.
7. **Pointers** — link `docs/architecture.md`, `GLOSSARY.md`, `docs/adr/`, the contract
   artifact and the configuration surface; do not copy their content.

Leave out architecture prose, design documents, ADR bodies, directory inventories and
details that will drift. This file is a map, not a mirror: every line is resident in every
session, so carry only what a fresh session cannot reconstruct with `ls`, the manifest or a
pointer — the rest goes behind the pointer. Update the file when a command or the layout
changes.

Output: the agent-instruction baseline — `CLAUDE.md` or `AGENTS.md` — reviewed, with the
entry-point map, the design principles and the pointers, named as the entry baseline in the
delivery.

### 6. Record the gates, the release and the delivery path

The local gate path runs the same checks as CI, so a host-only bypass cannot ship. It stays
offline and fast, prints what it runs, and is idempotent.

| Stage | Must stop | Done when |
|---|---|---|
| Local pre-commit | formatting, lint or typecheck failures on staged files; an edited or non-contiguous migration; a secret, a host-absolute path or a generated file | it returns in seconds; a fixable finding is fixed and re-staged |
| Local pre-push | a failing test suite (the affected set, plus the full suite before a merge); a stale contract or interface snapshot; a declared request schema that differs from the handler; a canonical contract document that no longer matches the handlers; a lockfile that does not match its manifest | it runs the same checks as the CI test job |
| Local pre-tag | a version that disagrees with the manifest; a tag without its CHANGELOG section; a release build that fails | it passes before the tag is created |

CI runs on every push and pull request: install from the lockfile → lint, format check and
typecheck → tests with the coverage floor → contract and canonical-contract checks → a
configuration-key check (every key the application reads is named in `.env.example`) →
build the artifact → security scan (dependency audit, secret scan, SAST) with no
unaddressed high or critical finding.

#### Release and delivery

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

Run `self-check.md` (Architecture branch). The architecture proof is:

- every requirement and quality attribute maps to the architecture document or an ADR;
- the design stance is evidenced: the simplest reliable option was chosen, every abstraction
  and dependency names its forcing function, no layer exists only for symmetry, and modules
  have one reason to change with dependencies pointing one way;
- the architecture style is recorded and justified (DDD with its contexts and aggregates,
  or a named simpler style with DDD's rejection), and the boundaries and tree instantiate
  it;
- the `## Tech stack` table is complete, versions are pinned and Step 4 instantiates it;
- when the system exposes an HTTP API, the envelope, error codes, validation and pagination
  are recorded, one helper implements the envelope, and the canonical contract matches;
- the configuration surface is recorded: `.env.example` names every key, the loader fails
  loudly, and the reload policy lists reloadable and restart-required keys;
- the logging contract is recorded and scaffolded: one logger module, key flows emit
  `info`, caught exceptions emit one `error` with their code and correlation id, and no
  secret is logged;
- the directory tree is planned, scaffolded exactly, and carried by the agent-instruction
  baseline as a top-level map with a pointer;
- `CLAUDE.md`/`AGENTS.md` exists as the baseline every role reads, carries the entry
  commands, the entry-point map and the gates, and links rather than copies the architecture
  document and the full tree;
- every ADR has a status, alternatives and consequences;
- the scaffold checklist in Step 4 is complete, the smoke test passes and the documented
  local run works;
- the local gate path exists at pre-commit, pre-push and pre-tag, and is idempotent;
- the release and deploy paths are recorded separately, each with its `n/a` when absent: a
  release publishes the artifact CI passed and keeps a published version immutable, and a
  deploy carries a healthcheck, a post-deploy verification and a recorded rollback with its
  data plan when stored data changes;
- no secret, no host-absolute path, no second source of truth;
- the root `GLOSSARY.md` carries the `## Product language` pointer (or says product terms
  are not recorded) and does not copy `design/glossary.md`.

Output: the requirement → artifact table in `plan.md`.

### 8. Architecture review

Present the **architecture package** — the design-stance evidence, the options, the style
ADR, the stack table with pinned versions and rejected alternatives, the boundaries, the
external contract, the configuration surface, the directory tree, the gate path, the release
and deploy paths and the agent-instruction baseline — to the project session. E5 belongs to
the human; a public API contract is E5, and a configuration key that touches a secret is E4.
Record the decision on the card. Do not start implementation before the review is recorded.

Output: the recorded E5 decision on the card.

### 9. Deliver

Re-export the brief, mark the handoff required, and write the architecture variant of the
`## Handoff` block into the delivery report's `conclusion`: one architecture-package sentence
naming the architecture document, `.meerkat/<id>/architecture.md` (when the change is
card-local), the style and other ADR paths, the contract artifact, the configuration
surface, the directory tree, the gate path, the release and deploy paths (or their recorded
`n/a`), the agent-instruction baseline (`CLAUDE.md` or `AGENTS.md`), the acceptance source,
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
- Write only the skeleton and its smoke test here; product behaviour belongs to the
  implementation branch.
- Migrations are append-only. A published contract or schema change needs the human.
- No destructive operation and no secret.
