# 0018 — The board has one automation identity: `Board`, kind `system`

- **Status:** Accepted (2026-11-06)
- **Context:** ADR 0004 made the board's writes `kind=system`, and the loop's workflow
  pass carried the actor id `Orchestrator` while core board events (rollup, the label GC,
  agent sessions) carried the id `system`. Both recorded the same kind, so the roster and
  the historical trail showed two automation authors for one writer. The owner asked for
  one identity and one kind.
- **Decision:** The kind stays `system`. `system` stops being an identity: the single
  automation identity is the actor id **`Board`**, kind `system`, and it covers every
  automated write, whichever actor triggered it — core board events and the loop's control
  writes alike. `BOARD_ACTOR` resolves to `{ kind: "system", id: "Board" }`; no write path
  names the actor id `system` or `Orchestrator`, and the retired `ORCHESTRATOR_ACTOR_ID`
  constant is removed rather than aliased. `Director` remains its own identity. The
  `taskd` SLA mechanism label is not an actor id and does not change.
- **Why:** A reader's job is to tell a person from an agent from the board. Two ids for one
  writer made the roster and the audit trail name two automation authors, and a second
  spelling of one identity is exactly the drift the identity rule exists to prevent. The
  kind already says "no person and no agent wrote this"; the id only has to say *which*
  automation, and there is one.
- **Consequences:** `BOARD_ACTOR_IDS` in the loop's subscriber carries one automation id
  (`Board`); `system` leaves it because suppression is by id and `system` is no longer an
  id, while the historical `taskd` importer id stays. Historical `comments` and
  `task_reports` rows authored by `system`/`Orchestrator` are merged into `Board` by the
  one-off, backed-up, trigger-restoring repair in `scripts/repair/merge-automation-actor.mjs`
  (the only recorded exception to the append-only comment/report triggers for this change).
  Historical `task_activities` rows keep their old ids: the audit log is append-only
  history and is not rewritten. The grep guard in `test/contract/actor-kind.test.mjs` fails
  when a source write names either retired id.
