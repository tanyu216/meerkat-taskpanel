# Architecture

Reconstructed from the tree at `999a5a8c` — E5 pending.

This is the system record: what the product is, how it is layered, where each design area's
canonical artifact lives, and what the directory tree means. It points; it does not restate.
The **standard** — the normative rules a change must comply with — is
[`docs/tech-spec.md`](tech-spec.md).

Every fact below carries a disposition (see [Dispositions](#dispositions)): `inherited` when a
document already binds it, `reconstructed` when it is read off the tree, `not recorded` when no
evidence settles it. The reconstruction is **provisional** until the project session accepts it.

## Purpose and boundary

Meerkat TaskPanel is a **local-first task board for AI-agent teams**. Agents create projects and
cards, claim work, send heartbeats, report progress and roll results up a dependency tree; humans
watch the same state on a deliberately read-only kanban board. The board is the record, not the
driver. Positioning and rationale: [`README.md`](../README.md) § Why / What it solves.

- **Inside the boundary:** the card lifecycle and its delivery gate, the project and dependency
  model, the `taskctl` CLI, the local `taskd` HTTP + SSE surface, the Vue board, the four
  agent-kind installers, and the loop (`src/orchestrator/`) that drives the board through
  `taskctl`.
- **Outside:** no hosted service, no external database, no message broker, no network at
  runtime. IM integration is planned, not built ([`docs/im-integration.md`](im-integration.md)).
- **Consumers:** AI agents (through the `meerkat` skill), the loop, a human operator, and the
  browser board. The same state reaches all of them; none of them owns a private copy.

**Quality attributes, in the order the design optimizes them:**

| Attribute | What it means concretely | Where it is held |
|---|---|---|
| Reliability | A crashed agent never wedges a card (heartbeat staleness); one writer per data directory; a bounded graceful stop | [`docs/agents/development.md`](agents/development.md) |
| Traceability | The audit trail is append-only; a delivery needs a report for the current round | [`docs/lifecycle.md`](lifecycle.md) |
| Simplicity | Zero runtime dependencies, one SQLite file, no build step for the engine | [`docs/tech-spec.md`](tech-spec.md) |
| Operability | One process, structured logs with a request id, a `/health` probe, metrics | [`docs/ops/observability.md`](ops/observability.md) |
| Local-first security | Loopback by default, a token plus an optional CIDR allow-list | [`docs/access.md`](access.md) |

## Architecture style

**Layered modulith, not domain-driven design.** The dependency direction is one way and the whole
system ships as one repository with one database; the domain is rule-heavy but there is a single
bounded context with one vocabulary, no domain experts contesting terms, and no second model to
translate. Strategic DDD (a context map, an anticorruption layer) has nothing to map yet, and
tactical DDD (aggregates, repositories, domain events as first-class machinery) would add layers
without a second caller.

The four layers and the import rule they carry:

| Layer | Owns | May import |
|---|---|---|
| `src/foundation/` | DTOs, constants, the env loader, the logger, domain errors, the HTTP/CLI transport helpers, pure helpers | nothing under `src/` (Node builtins only) |
| `src/core/` | the domain model and invariants, SQLite storage and migrations, use-cases and `openBoard()` | `foundation` |
| `src/cli/`, `src/server/` | the `taskctl` surface; the `taskd` HTTP + SSE surface | `core`, `foundation` |
| `src/orchestrator/` | the loop: patrol, dispatch, claim, session pool | `foundation` only — it speaks to the board through `taskctl`, never through the HTTP API |

`src/core/domain/` imports **no Node builtins**, so the model stays testable as pure logic.
Decision and rejected alternatives: [`docs/adr/0001-architecture-style.md`](adr/0001-architecture-style.md).

## Module boundaries

One owner per module, one reason to change:

- **`src/core/domain/`** — the state machine, acceptance, review identity, dependency edges and
  the workflow planners. It returns domain errors, never bare `Error`s.
- **`src/core/storage/`** — the SQLite schema, the append-only migration runner, repositories,
  and the review-identity reader every layer shares.
- **`src/core/commands/`** — one command per board operation; the CLI and the server are thin
  adapters over these.
- **`src/foundation/`** — everything both front doors agree on. Two helpers are load-bearing
  singletons: `review-identity.mjs` (the only reader of a review card's identity) and
  `constants.mjs` (the only home for a shared literal).
- **`src/orchestrator/`** — the loop. It carries no board discovery or token code; that belongs
  to the CLI it spawns.

Shared constants and the closed enumerations have one home each —
`src/foundation/constants.mjs` and `src/core/domain/enums.mjs` (plus `priority.mjs`,
`acceptance-mode.mjs`, `blocked-reason.mjs`). The browser cannot import `src/`, so its copy lives
in `web/src/lib/board-enums.js`; `test/web/enums.drift.test.mjs` holds the two in step.

## Data model and migrations

A single SQLite database per board, through Node's built-in `node:sqlite` — no ORM, no
migration tool dependency. Migrations are numbered SQL under
`src/core/storage/migrations/`, **append-only**, applied at startup by the runner in
`src/core/storage/`; the runner refuses a database whose applied file has changed. Invariants that
must hold for every writer live in the database first (a trigger or a `CHECK`), mirrored by a
domain check and tested against it under `test/contract/`.

The data directory holds `board.sqlite`, `logs/`, the `writer.lock` and the runtime pointer. Its
topology, backup and upgrade behaviour: [`docs/agents/migration.md`](agents/migration.md) and
[`docs/ops/install.md`](ops/install.md). There is no squashed baseline to keep: `0001_init.sql`
is the first append and is never edited.

## External contract

The system **exposes** one HTTP surface — versioned `/api/v1`, RESTful over the card/project
resource model — and one CLI surface. It **consumes** nothing third-party at runtime.

- One serializer produces the envelope, and it is not the workflow default:
  `{"ok":true,"data":…}` on success and `{"ok":false,"error":{"code","message","http","details","hint"}}`
  on failure (`src/server/router.mjs`). The application `code` is stable and independent of the
  HTTP status; a client switches on it, never on the message. `/health`, `/meta` and the SSE
  stream are the recorded envelope exceptions.
- Request schemas are **declared, not enforced**: `src/server/requests.mjs` names the shape each
  handler reads, `scripts/verify/route-request.mjs` proves the declaration matches the handler,
  and domain validation produces `VALIDATION_FAILED`. This is a recorded deviation from the
  "one schema validator at the boundary" default; changing it is a contract change, not a
  refactor.
- The canonical artifacts are **code-first**: `test/fixtures/contract/api.snapshot.json` and
  `cli.snapshot.json`, regenerated with `--update` and checked by the pre-push hook and CI. There
  is no OpenAPI document, by decision.

Detail, including the pagination shapes in use: [`docs/agents/contract.md`](agents/contract.md).

## Configuration surface

One inventory: [`.env.example`](../.env.example) at the repository root — every key the
application reads, grouped by the file it lands in, held to `src/foundation/constants.mjs` by
`test/contract/config-keys.test.mjs`. Two files are actually written by an install, and both are
subsets of the inventory:

- `<install root>/.env` — the shared board surface, read by `taskd`, `taskctl` and the loop;
- `<program root>/.env.<actor-kind>` — the loop's per-agent-kind policy. The board loader
  deliberately ignores these keys (`PER_KIND_CONFIG_KEYS` is its allow-list).

Resolution order per key: flag → process environment → per-kind file → shared `.env` → built-in
default. The loader validates at startup, refuses an unknown key in our namespaces and fails
loudly rather than falling back silently. Reload policy: the SLA table and the access policy are
re-read per pass/request; every other key needs a restart. Operator topology:
[`docs/ops/install.md`](ops/install.md).

## Logging and observability

One logger, `src/foundation/log.mjs`: a logfmt line per event, a callable factory, `.child()`, and
`AsyncLocalStorage`-carried context so a request id threads a flow. Application modules do not
write to `console` directly. Key flows emit `info`; a caught exception emits exactly one `error`
at the boundary that decides its fate, carrying its code. Secrets and personal data are redacted
at the logger boundary.

Signals beyond logs — `/health`, `/metrics`, the Prometheus rules, the threshold set and the OTLP
export — are [`docs/ops/observability.md`](ops/observability.md). The worst-case blocking path is
the SQLite write lock: contention past `busy_timeout` becomes a bounded retry and then
`503 DB_BUSY` with `Retry-After`; the liveness probe does not share that resource.

## Security boundaries

Local-first, and every exposure-widening default is a recorded decision in
[`docs/access.md`](access.md):

- `taskd` binds loopback by default; a remote bind is a deliberate configuration.
- Three gates in order: loopback, then the CIDR allow-list (an empty list means no address
  outside loopback), then the token. `/health` is unauthenticated by design; the SSE stream is
  not.
- The access token never appears in a response or a log, and never in a URL or query string — the
  allowed channels are the `Authorization` header, `TASKD_TOKEN` in the environment, or a
  `0600` token file.
- The built board injects no token, so a browser reaching `taskd` from a non-loopback address is
  answered 401. That is a known local-first limit, not a defect.
- Authorization decisions are made in one place — the request gate in `src/server/index.mjs` —
  not spread across handlers.

## Directory tree

The tree makes the layering above visible. Canonical; other documents point here.

```text
meerkat-taskpanel/
├── src/
│   ├── foundation/     # DTOs, constants, env loader, logger, errors, transport helpers (imports nothing under src/)
│   ├── core/
│   │   ├── domain/     # the model: state machine, acceptance, review identity, edges, workflow (no Node builtins)
│   │   ├── storage/    # schema, migrations/ (append-only SQL), repositories, the review-identity reader
│   │   └── commands/   # one command per board operation
│   ├── cli/            # taskctl: argv, commands/, hub/ (the local event hub), output/
│   ├── server/         # taskd: index.mjs, routes/, SSE, the request gate
│   └── orchestrator/   # the loop: patrol, dispatch, session pool (talks only through taskctl)
├── web/                # the board: Vue 3 + Vite → web/dist (the hosted root taskd serves)
│   ├── src/lib/        #   pure browser helpers, incl. board-enums.js (the mirrored vocabularies)
│   └── .vendor/npm-cache/  # the committed offline cache the image's webbuild stage installs from
├── skills/             # the authored board skill, loop docs and the installer skill — never generated
├── scripts/            # build / install / release / verify / security checkers
├── docker/             # Dockerfile, compose files, verify-in-container.sh, profiles/
├── monitoring/         # the metrics sidecar (Prometheus / OTLP)
├── docs/               # this document, the standard, agents/ and ops/ ; index in docs/README.md
├── design/             # prototype, DESIGN/BLOCKS specs — a live oracle for tests, not documentation
├── test/               # mirrors src/ by path; contract/, web/, install/, concurrency/ alongside
└── .env.example        # the configuration inventory (this file is documentation, not a loadable env)
```

Entry points: `taskctl` → `src/cli/index.mjs`, `taskd` → `src/server/main.mjs`,
`meerkat-taskpanel` → `scripts/install/cli.mjs`, plus `install.sh` and the Pi extension under
`.pi/`. Generated output (`dist/`, `web/dist`, `.data/`, `.meerkat/`, `coverage/`) is gitignored
and never committed.

## The vertical slice

One path proves the skeleton: **create → claim → heartbeat → deliver → accept**. It crosses every
layer — CLI/server adapter, command, domain rule, database trigger, contract serializer, logger,
SSE increment — and it is what the container suite drives end to end
(`test/server/**`, `test/cli/**`, `test/concurrency/**`).

## Dispositions

| Fact | Disposition |
|---|---|
| Purpose, boundary, quality attributes | `inherited — README.md`, `docs/lifecycle.md` |
| Layered style, DDD rejected | `reconstructed — src/ import graph; recorded in docs/adr/0001` |
| Module boundaries and import direction | `reconstructed — src/**; enforced by review` |
| Data model, append-only migrations | `inherited — docs/agents/migration.md`, `src/core/storage/` |
| Envelope and contract snapshots | `inherited — docs/agents/contract.md` |
| Configuration inventory and load order | `reconstructed — src/foundation/env-config.mjs; inventoried in .env.example` |
| Logger contract | `inherited — docs/ops/observability.md`, `src/foundation/log.mjs` |
| Security boundaries | `inherited — docs/access.md` |
| Directory tree | `reconstructed — the tree itself` |
| Deployment target beyond compose | `not recorded — review question` (a maintainer's own deploy is not in this repository) |
| Multi-tenant or hosted operation | `n/a — the product is local-first by decision` |

## Revisit triggers

- A second bounded context appears (for example a hosted, multi-tenant board): revisit ADR-0001.
- A runtime dependency is proposed: revisit ADR-0002, with the licence and the offline guarantee.
- The request surface stops being declaration-based: revisit the contract section — that is a
  published-contract change and needs the human.
