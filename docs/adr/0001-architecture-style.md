# 0001 — Layered modulith, and why not domain-driven design

## Status

Accepted (reconstructed) — 2026-10-30 (E5).

Read back from the tree at `999a5a8c` and accepted on that basis; the provenance stays so a
later reader can tell a derived decision from one taken in a decision round.

## Context

The product's value is in its rules: a card's state machine, the delivery gate, review identity,
dependency edges, acceptance resolution. The repository ships as one process tree against one
SQLite file, with four front doors (CLI, HTTP, loop, browser) that must never disagree about the
same state. The vocabulary is settled in `GLOSSARY.md` and no domain expert is contesting it.

## Decision

A **layered modulith** with a one-way dependency direction:

```
cli | server  ->  core  ->  foundation
orchestrator  ->  foundation        (the loop speaks only `taskctl`)
web           ->  the HTTP contract  (never `src/`)
```

`src/core/domain/` imports **no Node builtins**, so the model is pure and testable directly.
`src/orchestrator/` carries no board discovery or token code and imports nothing from `core`,
`cli` or `server` — the absence of an import is what enforces "the loop speaks only `taskctl`".

**Domain-driven design is rejected**, both halves:

- *Strategic* DDD has nothing to map yet: one bounded context, one ubiquitous language, no
  upstream/downstream team boundary to write a context map or an anticorruption layer for.
- *Tactical* DDD would add aggregates, repositories and domain events as machinery. The rules
  already live in a small, explicit domain module with tests; the extra indirection would give
  one reason to change per aggregate but add a mapping layer to every read, for no second caller.

The cost accepted: as the domain grows, `src/core/domain/` is a single module rather than a set
of bounded contexts, so a new subdomain has to be carved out deliberately instead of appearing as
a new context by default.

## Considered options

| Option | Boundaries | Data flow | Cost | Why rejected |
|---|---|---|---|---|
| Layered modulith (chosen) | four layers, one model | direct calls, one process | a large domain module later | — |
| Tactical DDD | aggregates + repositories + domain events | mapping at each layer | new indirection now, payoff only with a second model | no forcing function |
| Microservices by surface (CLI / HTTP / loop / board) | one service per front door | a network hop per call, shared database | operational load; a shared DB across services is a distributed monolith | the system is one local process with one writer |
| Event-sourced core | an append-only event log as the model | every read is a projection | replay, versioning, migration of event schemas | the audit trail is already append-only; full event sourcing buys nothing more |

## Consequences

- A rule that must hold for every writer lives in the database first (trigger or `CHECK`),
  mirrored by a domain check — the app-layer half alone is walkable past.
- Cross-layer types live in `src/foundation/`; a module that needs a new shared literal adds it to
  `constants.mjs` rather than declaring a second copy.
- Revisit when a second bounded context appears (for example a hosted, multi-tenant board with
  its own model), or when the domain module grows past what one reader can hold.
