# The role layer

A **role** is a standalone skill: `skills/<role>/` carries `SKILL.md` (the workflow), `role.json`
(the machine-readable identity, with the `meerkat-role` marker) and `references/`. The board
does not know roles; `taskd` stores a card's assignee as an actor id, and every role decision is
made on the host that discovered the skills. This page describes discovery, routing, the local
catalog and the one place roles touch a write.

## Discovery

Only the agent kinds `claude`, `codex` and `pi` are loop kinds (`ROLE_KINDS`); `openclaw` is an
install target, not a loop kind. The supervisor scans each installed kind's skills tree,
`<home>/<agent-dir>/skills/*/role.json`:

- an explicit `--roles-dir` / `MEERKAT_TASKPANEL_ROLES_DIR` directory of role directories
  replaces the scanned set (it is still read, and is not "legacy" when it carries `role.json`);
- otherwise each loop kind's skills tree, in the **effective order** `[primaryKind, …configured
  order]`. A kind the order omits is appended; omission is a preference, not an exclusion.
- hits are merged by role id. The first hit wins and decides the agent name; later hits only add
  the kind to `installedOn` and record that kind's files as a variant.

`role.json` is validated with bounded sizes, an id grammar, a lane vocabulary
(`worker|reviewer`), and count caps. A malformed file is reported and skipped; it never wedges
a poll.

## The kind order

The order comes from the install: `install.sh` writes the normalized `--target` order (loop
kinds only, the selected primary first) as `MEERKAT_TASKPANEL_AGENT_KIND_ORDER` in each per-kind
config. Precedence is process env > per-kind config > default `claude,codex,pi`. A direct
per-kind installer run defaults to `<that kind>,<the rest>`.

**Installation location is the routing.** A role installed on codex runs on codex. When several
kinds carry it, the chain is the primary kind first, then the configured order. Availability is
the CLI probe, not the directory: an unavailable carrier falls back only to another kind that
also carries the role; if none is available, the card is not claimed and the gap is reported
(`taskctl loop status`, `taskctl loop doctor`).

Changing the order moves the **fallback** preference. Changing the **primary** kind is the
unit's `--actor-kind` and needs `install.sh … --supervisor=enable` re-run.

## How the roles sequence

The board stores an assignee and the `parent`/`blocks` edges; it does not schedule roles.
Order comes from two places: a project's `docs/agents/epic-graphs.md` names the stages, roles
and dependencies of a multi-role epic, and the `blocks` edges built from it withhold a card
until its predecessors are `done`. The supervisor never sequences roles. The director reads
the graph during triage to fill a missing stage, but it does not own the graph: the project
does. Outside a graph, a role's classification of its card is the role's own judgement
(description plus frozen acceptance), not a generic contract.

## The claim set and the writer identity

Two different questions:

- **What may the loop claim for?** Every discovered worker-lane role's board name, plus every
  discovered reviewer-lane role's board name. There is no scan-set configuration key. A
  reviewer-lane role is scanned for its review cards but never takes the public pool.
- **Who does the loop write as?** Its own writer identity: `--agent` (rendered into every
  scheduling unit), else `TASKCTL_AGENT` (the shim), else the OS user. A writer identity with no
  role skill can write, but its name is **not claimable**; the workaround is to install a role
  skill. The review card the workflow creates is the one automation write with a reviewer
  assignee, and that assignee is the catalog's `default_reviewer`.

This split is ADR 0013. It removed `MEERKAT_TASKPANEL_AGENTS`, whose unique content was a custom
identity with no role skill — exactly the case the model says is not a claim identity.

## The local role catalog

The supervisor publishes the discovered set through `taskctl role sync --file -` (payload on
stdin, full replacement) to `<config root>/roles.json` (`MEERKAT_TASKPANEL_CONFIG_DIR`
relocates it). `taskctl role list` reads it; both commands are local — no board, no token, no
`--actor-kind`.

- **Shape:** `{schema:"meerkat-role-catalog/1", source, primary_kind, updated_at, roles:[…]}`.
  A role carries `id`, `agent`, `native_agent`, `title`, `summary`, `lanes`, `shapes`,
  `responsibilities`, `boundaries`, `installed_on`, `default_reviewer`. Host paths (`skillDir`,
  the per-kind files) are deliberately not projected.
- **Idempotent:** content comparison excludes `updated_at`; an unchanged sync leaves the stored
  timestamp alone. The poll calls it on every tick — including a poll with no resident pool — so
  a deleted or hand-broken file heals on the next tick (one small CLI spawn per default 600 s).
- **Bounded and atomic:** a hard 64 KiB read cap, validation before use, temp-file-then-rename
  write, mode preserved. A malformed, oversized or newer-schema file is reported and treated as
  **absent**, never half-applied.
- **Local, never board state.** No table, migration, route or event; `/roles.json` is in
  `.gitignore` and `.dockerignore`. A session on another machine has its own file or none.

The catalog is a **projection**, never the routing source: the running supervisor routes by the
set it discovered, and the file exists for humans and the skills.

## The assignee check

`issue create` and `issue assign` read the catalog before the HTTP call. When it is non-empty,
an `--assignee` that matches no role `agent` or `id` (case-insensitive) is refused with
`ASSIGNEE_NOT_IN_CATALOG` (exit 1), naming the candidates and pointing at `taskctl role list` /
`--force-create`.

It is skipped when:

- the catalog is absent, empty or unusable — the bootstrap state, before the first sync;
- `--assignee-id` is given (the structural spelling);
- the assignee is explicitly a human (`--assignee-kind human`);
- there is no assignee at all;
- `--force-create` is set — the documented escape, also meaning "allow an assignee outside the
  catalog".

**It looks at the assignee, never the writer.** `system` / `Orchestrator` / `Director` are
writer identities for closure work (verdict, move, acceptance, comment, reconcile) and are
never assignees; `Director` is the decision lane's signature even though it is not a role. The
two system-created cards are the review card (the catalog's `default_reviewer`, named by
`--assignee` at that one argv builder) and the rework child (`--assignee-id`). A system
writer that names a worker assignee is checked like anyone else.

**A CLI guard, not a board invariant.** A caller that speaks HTTP directly bypasses it by
design, because the board never learns roles. Every supported surface — the `meerkat` skill, a
worker, the Director, a human — goes through `taskctl`.

## How this differs from the `actors` dictionary

The board's `actors` dictionary is the identity record every write points at: an `agent` or
`human` kind plus a display name. It is **not** a role registry; it has no lanes, shapes or
platform installation. A role name reaches the board only when a card is assigned to it (or the
actor first appears in a write), and the dictionary never decides which roles are valid,
claimable or installed. The role catalog is the host-local authority for that question; the
dictionary is the board's authority for who wrote what.

## Decisions and costs

- The 600 s sync cadence means a removed role can still be named until the next tick; the
  stranded-card reporting then surfaces it.
- A malformed catalog opens the assignee range rather than closing it. Failing open is the
  deliberate choice: refusing every create on a corrupt local file would be worse than
  accepting a name the next sync narrows.
- The assignee check compares exact `agent`/`id` names; it does not replicate the dictionary's
  fuzzy prefix matching. The hint tells the caller to use an exact role name.
- Reviewer roles are in the catalog but are not routed ordinary work; the `meerkat` skill filters
  to worker-lane roles.

See ADR 0007 (roles are skills; installation location routes), ADR 0012 (the kind order comes
from the install) and ADR 0013 (the local catalog and the discovered scan set).
