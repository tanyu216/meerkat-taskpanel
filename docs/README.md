# Docs

Documentation for Task Panel.

| Document | Contents |
|---|---|
| [install.md](install.md) | Installing the skill into Claude Code, OpenClaw, Codex or Pi; `install.sh` usage, the per-host table and flags. |
| [publishing.md](publishing.md) | Releasing a version: npm packaging / publish, the git tag + GitHub Release pipeline, and the Claude marketplace / OpenClaw / Codex / Pi publication steps. |
| [development.md](development.md) | Repository layout, Node requirement, test / verify / build commands, the two build layers (engine vs `web/`) and the offline / dependency policy. |
| [docker.md](docker.md) | Why verification and the four-host installs run in a container; the image build, the offline `web/` build stage, profiles and troubleshooting. |
| [migration.md](migration.md) | Taking over the team's markdown cards: the dry run, shadow (read-only) mode, the single-point switch and the rollback. |
| [contract.md](contract.md) | The API contract snapshot (routes + error codes + wire fields + MCP tools): what it freezes, the `--update` workflow, and the pre-push / pre-tag / CI gates. |
| [scheduling.md](scheduling.md) | The two-layer poll/patrol model, the fire-only cost gate, the atomic-claim dispatch, the host-external supervisor, the three-host trigger differences, and why OpenClaw uses openclaw-team instead. |
| [web-local-first.md](web-local-first.md) | The board frontend is loopback-only: why a remote browser gets 401 (no token injection) and what implementing it would take. |
| [`../skills/task-panel/SKILL.md`](../skills/task-panel/SKILL.md) | The agent-facing skill definition. |
| [`../skills/task-panel/references/cli.md`](../skills/task-panel/references/cli.md) | The `taskctl` command surface (M2, implemented). |

Start with the [README](../README.md) for what the project is and its current status.
