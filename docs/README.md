# Docs

Documentation for Meerkat TaskPanel.

| Document | Contents |
|---|---|
| [install.md](install.md) | Installing the skill into Claude Code, OpenClaw, Codex or Pi; `install.sh` usage, the per-host table and flags. OpenCode has a `--target` of its own; Cursor is plugin-only — their sections show both routes. |
| [publishing.md](publishing.md) | Releasing a version: npm packaging / publish, the git tag + GitHub Release pipeline, and the per-host publication steps (Claude Code marketplace / OpenClaw / Codex / Pi / Cursor / OpenCode). |
| [development.md](development.md) | Repository layout, Node requirement, test / verify / build commands, the two build layers (engine vs `web/`) and the offline / dependency policy. |
| [docker.md](docker.md) | Why verification and the six-host installs run in a container; the image build, the offline `web/` build stage, profiles and troubleshooting. |
| [migration.md](migration.md) | Taking over the team's markdown cards: the dry run, shadow (read-only) mode, the single-point switch and the rollback. |
| [projects.md](projects.md) | What a project is, how its id becomes the identifier prefix, and why that prefix must be unique across projects. |
| [contract.md](contract.md) | The contract snapshots — the HTTP API (routes, error codes, wire fields) and the CLI surface (`taskctl` commands, flags, envelope keys): what each freezes, the `--update` workflow, and the pre-push / pre-tag / CI gates. |
| [scheduling.md](scheduling.md) | The ping/continue scheduler, the deterministic loop entries, the fire-only cost gate, the atomic-claim dispatch, the event subscriber, the three-host trigger differences, and why OpenClaw uses openclaw-team instead. |
| [events.md](events.md) | The live stream's event catalogue: every activity, its writer and payload, which surface consumes it, the feed's admission policy, the loop's dispatch whitelist, and the actor-kind rule. |
| [web-local-first.md](web-local-first.md) | The board frontend is loopback-only: why a remote browser gets 401 (no token injection) and what implementing it would take. |
| [`../skills/meerkat-taskpanel/SKILL.md`](../skills/meerkat-taskpanel/SKILL.md) | The agent-facing skill definition. |
| [`../skills/meerkat-taskpanel/references/cli.md`](../skills/meerkat-taskpanel/references/cli.md) | The `taskctl` command surface (implemented). |

Start with the [README](../README.md) for what the project is and its current status.

## On `ARCHITECTURE.md` citations

`ARCHITECTURE.md` is **not part of this repository** — there is no such file in the tree, and
none in the git history. Older code and prose nonetheless cite it by section (`ARCHITECTURE
§1`, `§3`, `§4.1`–`§4.8`, `§5.1`/`§5.4`, `§7`/`§7.1`, `§8`, `§9.1`, `§13`), across `src/**`,
`scripts/**`, `test/**`, `docs/**` and `design/**`.

Read those citations as **historical orientation only** — none of them resolves to a file in
this repository. Where a topic has a live authority, the citation names it explicitly:

| Cited as | Live authority |
|---|---|
| Project ordering (`ARCHITECTURE §4.6`) | [`../design/DESIGN.md`](../design/DESIGN.md) §20, implemented by `src/shared/project-order.mjs` |
| Container verification (`ARCHITECTURE §9.1`) | [docker.md](docker.md) |

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

