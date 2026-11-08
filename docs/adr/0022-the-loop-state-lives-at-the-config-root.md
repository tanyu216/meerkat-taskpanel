# 0022 — The loop state lives at the config root, not the agent home

- **Status:** Proposed
- **Context:** The supervisor's runtime state (queue, `sessions.state.json`, locks,
  ledgers and bounded worker transcripts) lived at `<home>/<agent-dir>/meerkat-taskpanel/`.
  That tied a board's loop to whichever agent kind was the primary and put runtime
  output under `~/.claude` even when the board ran from a project checkout. The
  owner asked for the state to live with the project instead.
- **Decision:** The state directory is `<config root>/loop/`, where the config root
  is the directory that already holds `.env.<kind>` and `projects.json`
  (`resolveConfigDir`: the checkout, the installed tree, or
  `MEERKAT_TASKPANEL_CONFIG_DIR`). `MEERKAT_TASKPANEL_STATE_DIR` (process env, then
  the per-kind config) or `--state-dir` names another; the default is one directory
  per board installation, shared by every actor kind. It is deliberately **not**
  under the board's `.data`: the database and the loop have independent backup,
  teardown and permission lifecycles. The pre-migration
  `<home>/<agent-dir>/meerkat-taskpanel` is a read-only fallback and the installer's
  migration source; a write verb refuses a legacy-only directory.
- **Why:** A checkout install now keeps its loop state in the project; an installed
  tree keeps it beside `logs/` and `scheduling/`. One state directory per board
  preserves the one-supervisor/one-queue/one-lock invariant (ADR 0015), while the
  session records inside it still carry the actor kind. Moving or renaming the
  checkout no longer strands board rows because the state directory holds a stable
  `loop.id`.
- **Consequences:**
  - The migration is one-time and conservative: the installer stops every loaded
    loop kind, waits for the pool/subscriber/tick/queue locks to quiesce, copies
    the durable files (keeping the old directory as
    `meerkat-taskpanel.migrated-<timestamp>`), and records the old loop ids so the
    first reconcile closes their board rows. Several legacy directories (an old
    multi-kind install) are refused, never merged, and a relocation that cannot
    finish fails the install instead of reporting a loop that never moved.
  - An agent-only npm/npx install keeps its config root inside the package tree, so
    an upgrade can replace the state. The docs say to use a combined install or set
    `MEERKAT_TASKPANEL_CONFIG_DIR`/`MEERKAT_TASKPANEL_STATE_DIR` to a durable path.
  - `.gitignore`/`.dockerignore` gain `/loop/`; a per-card `.meerkat/<identifier>/`
    is unchanged and remains a different thing.
  - `--home` no longer selects the state; it only derives the agent skill/role
    directories.
