# Docs

Documentation for Meerkat TaskPanel.

| Document | Contents |
|---|---|
| [install.md](install.md) | Installing the skill into Claude Code, OpenClaw, Codex or Pi; `install.sh` usage, the per-host table and flags. |
| [publishing.md](publishing.md) | Releasing a version: npm packaging / publish, the git tag + GitHub Release pipeline, and the Claude marketplace / OpenClaw / Codex / Pi publication steps. |
| [development.md](development.md) | Repository layout, Node requirement, test / verify / build commands, the two build layers (engine vs `web/`) and the offline / dependency policy. |
| [docker.md](docker.md) | Why verification and the four-host installs run in a container; the image build, the offline `web/` build stage, profiles and troubleshooting. |
| [migration.md](migration.md) | Taking over the team's markdown cards: the dry run, shadow (read-only) mode, the single-point switch and the rollback. |
| [projects.md](projects.md) | What a project is, how its id becomes the identifier prefix, and why that prefix must be unique across projects. |
| [contract.md](contract.md) | The API contract snapshot (routes + error codes + wire fields): what it freezes, the `--update` workflow, and the pre-push / pre-tag / CI gates. |
| [scheduling.md](scheduling.md) | The two-layer poll/patrol model, the fire-only cost gate, the atomic-claim dispatch, the host-external supervisor, the three-host trigger differences, and why OpenClaw uses openclaw-team instead. |
| [web-local-first.md](web-local-first.md) | The board frontend is loopback-only: why a remote browser gets 401 (no token injection) and what implementing it would take. |
| [ui-align-retirement-audit.md](ui-align-retirement-audit.md) | The assertion-coverage reconciliation after `ui-align` was retired from this repository: which of the deleted manifest's rows the contract layer still guards, the 52 it does not, and how to re-derive the counts. |
| [`../skills/meerkat-taskpanel/SKILL.md`](../skills/meerkat-taskpanel/SKILL.md) | The agent-facing skill definition. |
| [`../skills/meerkat-taskpanel/references/cli.md`](../skills/meerkat-taskpanel/references/cli.md) | The `taskctl` command surface (M2, implemented). |

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

