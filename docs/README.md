# Docs

Documentation for Meerkat TaskPanel, grouped by **reader**: what a session must follow while
working in this repository, what the product is designed to do, and what an operator runs.

## Agent execution

The rules and gates a session follows while working in this repository. The tracker files are
the per-repository outputs of the Matt Pocock integration; the rest are this repository's own
operating procedure.

| Document | Contents |
|---|---|
| [development.md](agents/development.md) | Repository layout, Node requirement, test / verify / build commands, the two build layers (engine vs `web/`) and the offline / dependency policy. |
| [docker.md](agents/docker.md) | Why verification and the four-agent-kind installs run in a container; the image build, the offline `web/` build stage, profiles and troubleshooting. |
| [contract.md](agents/contract.md) | The contract snapshots — the HTTP API (routes, error codes, wire fields) and the CLI surface (`taskctl` commands, flags, envelope keys): what each freezes, the `--update` workflow, and the pre-push / pre-tag / CI gates. |
| [migration.md](agents/migration.md) | The append-only SQL schema gate, and the note recording the MCP integration's removal. |
| [issue-tracker.md](agents/issue-tracker.md) | How this repository's work is tracked as cards: the `taskctl` workflow, the commands the engineering skills expect, and the conventions that differ from a hosted tracker. |
| [domain.md](agents/domain.md) | How the engineering skills consume this repository's domain documentation (`GLOSSARY.md`, ADRs, `design/`). |
| [triage-labels.md](agents/triage-labels.md) | The five canonical triage roles and the label strings this repository uses for them. |

## Design

How the product behaves, and why.

| Document | Contents |
|---|---|
| [acceptance.md](acceptance.md) | The acceptance model — who may close a card: the two-layer vocabulary (`projects.acceptance` vs `tasks.acceptance_mode`), resolution at creation and why the fallback is `agent`, the three modes, review's independence from the closer, the standing states, the three enforcement layers, and the two deliberate gaps. |
| [scheduling.md](scheduling.md) | The scheduling model: the ping/continue clocks, the deterministic loop passes, the fire-only cost gate, the atomic-claim dispatch, the event subscriber, the three-agent-kind trigger differences, and why OpenClaw installs the board skill only. |
| [sla.md](sla.md) | The SLA design: the wait-time model, why the board computes and the loop notifies, the threshold table and tier ladder, the working-hours basis, the alert tuple, the row detectors, de-duplication and pre-emit re-check, the peer watchdog, and the decisions with their costs. |
| [events.md](events.md) | The event system's design: the append-only activity log and its revision cursor, the SSE contract and its delivery semantics, each consumer's refresh policy (board, ledger, feed, loop, card watcher), the local event hub, the event catalogue, and the decisions and costs behind them. |
| [projects.md](projects.md) | The project subsystem: the id and the effective identifier prefix (derivation, uniqueness, immutability), what a project carries, its lifecycle and wire surface, the server-ranked `PROJECTS` order, and why the working directory lives in the machine-local `projects.json` instead. |
| [security.md](security.md) | Dependency security: what the supply-chain scan covers, what blocks, how an advisory is waived, and why an alert does not red a build unless someone asks. |
| [access.md](access.md) | Access and security design: the local-first trust model, the request gate (loopback / allow-list / token), the credential's shape, storage and rotation, managing access from the panel and the CLI, what remote clients get today (and why the built board is loopback-only), the API surface's other guards, and the limits this design does not cover. |
| [im-integration.md](im-integration.md) | The planned IM integration: the plugin host + `channel-kit` contract, how “needs a human” is pushed, how replies are anchored and written as human comments, the resident IM session, and the per-platform adapter strategy (third-party SDKs, independent packages). |

## Operations

Installing, releasing and watching a deployment.

| Document | Contents |
|---|---|
| [install.md](ops/install.md) | Installing: `npx` / npm and source-checkout methods, the server runtime tree at `~/.meerkat-taskpanel`, and installing the skill into Claude Code, OpenClaw, Codex or Pi; `install.sh` usage, the per-agent-kind table and flags. |
| [publishing.md](ops/publishing.md) | Releasing a version: npm packaging / publish (the tarball is a runnable board carrying `web/dist`), the git tag + GitHub Release pipeline, and the per-agent publication steps (Claude Code marketplace / OpenClaw / Codex / Pi). |
| [observability.md](ops/observability.md) | The metrics sidecar (`/metrics`, the SLO `/health` verdict, Prometheus rules, OTLP export) and the processes' own structured logs: levels, the text line, request correlation, redaction, `taskd.log` ownership and rotation, and the `TASKD_LOG_*` keys. |

The agent-facing skill definitions live beside the skills themselves:
[`../skills/meerkat/SKILL.md`](../skills/meerkat/SKILL.md) and
[`../skills/meerkat/references/cli.md`](../skills/meerkat/references/cli.md).

Start with the [README](../README.md) for what the project is and its current status. `design/`
is a live oracle for tests and a record of past rounds, not documentation: its citations of
`docs/…` paths name the pre-move layout and are deliberately not kept in step with this tree.

## On `ARCHITECTURE.md` citations

`ARCHITECTURE.md` is **not part of this repository** — there is no such file in the tree, and
none in the git history. Older code and prose nonetheless cite it by section (`ARCHITECTURE
§1`, `§3`, `§4.1`–`§4.8`, `§5.1`/`§5.4`, `§7`/`§7.1`, `§8`, `§9.1`, `§13`), across `src/**`,
`scripts/**`, `test/**`, `docs/**` and `design/**`.

Read those citations as **historical orientation only** — none of them resolves to a file in
this repository. Where a topic has a live authority, the citation names it explicitly:

| Cited as | Live authority |
|---|---|
| Project ordering (`ARCHITECTURE §4.6`) | [`../design/DESIGN.md`](../design/DESIGN.md) §20, implemented by `src/foundation/project-order.mjs` |
| Container verification (`ARCHITECTURE §9.1`) | [docker.md](agents/docker.md) |

**Do not add a new `ARCHITECTURE.md` citation.** Name the live document instead.

## On `docs/verify/`

This tree used to hold **verification-run records**: one directory per `T-<card>` work lane,
each carrying that lane's report plus the harness, evidence dumps and screenshots that
produced it. They were never documentation. They accounted for **224 of the 237 files and
98.8% of the bytes under `docs/`**, nothing in the repository read them, and because `docs` is
in `package.json`'s `files` while `docker/Dockerfile` does `COPY . .`, they were being shipped
in the npm package and baked into the container image — carrying a developer's home directory
with them, which is exactly the disclosure `scripts/verify/paths.mjs` exists to prevent.

They now live **outside the repository**, in each card's own workspace under `repo-verify/` —
the same place the `design/fidelity-rNN.md` round records already send the oracle and probe
harnesses they keep out of the repository. So a bare `T-<card>` citation you meet in `src/**`,
`test/**`, `web/**` or `design/**` (for example `T-20261014-150729`) names a **card**, not a
file in this repository.

**Do not land run records here again.** `test/fixtures/host-paths-allowlist.json` is now
deliberately empty, so `scripts/verify/paths.mjs` fails on *any* tracked file carrying a
host-absolute path — and all 65 records it used to exempt carried one.

## On retired audits

`docs/` holds **live** documentation: what a reader needs to install, run, operate or extend
the repository. A one-off audit is not that. `ui-align-retirement-audit.md` lived here until
2026-10-17 and was removed alongside the run records above — a reconciliation pinned to two
historical commits (`b7d6379`, `f61e02a^`), by then 97 commits behind `dev`, of a tool
(`ui-align`) that no longer exists anywhere in this tree, and referenced by nothing.

Its question was real — whether retiring `ui-align` cost checking power — but its **answer does
not survive checking.** Most rows it lists as having "no guard whatsoever" name guards that are
present in `test/web/blocks.contract.mjs` *at the very commit it pins*: it calls
`[data-access-panel]` `count: 1` unguarded, while `b7d6379` asserts exactly that bound. **So its
headline number is not a backlog — do not open work against it.** Two of the hooks it names
(`[data-side-text]`, `[data-caret]`) really are unnamed by every harness, but that is two
absence-claims, not fifty-two lost guards.

