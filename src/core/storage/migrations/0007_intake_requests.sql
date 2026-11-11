-- 0007 — intake requests: a human's free-text work request, before any card.
--
-- The web's create surface hands the team one description instead of a filled
-- form. That description is a board row, not an event: the entry point that
-- submits it (`POST /api/v1/intake`) and the decision lane that consumes it are
-- in different processes, and the request's state — pending, consumed, failed —
-- has to outlive both. The activity row written in the same transaction is the
-- signal; this table is the state a consumer re-reads.
--
-- Three deliberate shapes:
--
--   * `created_by` / `created_kind` carry **no foreign key** to `actors`.
--     A request is a log-shaped record: it must outlive a roster row the way
--     `task_activities.actor_id` does, and it is never joined for display. The
--     `attribution-boundary` contract enumerates every `-> actors` reference;
--     this table is not one of them, on purpose.
--   * `settled_at` / `settled_by` cover **both** terminal states. A refusal is
--     a decision too: `failed` records who declined and why (`last_error`), so
--     the human can read the outcome instead of a request that vanished.
--   * no revision trigger. Every write here appends its `task_activities` row
--     in the same transaction, so the global cursor already advances; a
--     per-table trigger would move it twice for one change.
--
-- The CHECKs are the invariants a second writer cannot skip. The terminal one
-- is written as `CASE` rather than `IN`, so it never enters the
-- `CHECK (col IN (...))` vocabulary `SQL_ENUM_SETS` mirrors; `status`'s own IN
-- set is declared there and checked against this file by `sql-parity`.

CREATE TABLE intake_requests (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  text              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','consumed','failed')),
  idem              TEXT,
  created_by        TEXT NOT NULL,
  created_kind      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  settled_at        TEXT,
  settled_by        TEXT,
  settled_by_kind   TEXT,
  created_refs_json TEXT NOT NULL DEFAULT '[]',
  last_error        TEXT,
  CHECK (length(text) > 0),
  CHECK (json_valid(created_refs_json) AND json_type(created_refs_json) = 'array'),
  CHECK (CASE
    WHEN status = 'pending'  THEN settled_at IS NULL AND settled_by IS NULL
                                  AND settled_by_kind IS NULL AND last_error IS NULL
    WHEN status = 'consumed' THEN settled_at IS NOT NULL AND settled_by IS NOT NULL
                                  AND settled_by_kind IS NOT NULL AND last_error IS NULL
                                  AND json_array_length(created_refs_json) >= 1
    WHEN status = 'failed'   THEN settled_at IS NOT NULL AND settled_by IS NOT NULL
                                  AND settled_by_kind IS NOT NULL
                                  AND length(trim(last_error)) > 0
    ELSE 0
  END)
) STRICT;

-- A submit retried by the same client (a double click, a lost response) is one
-- request, not two. The key is project-scoped because a caller's token need only
-- be unique inside the project whose cards it will produce.
CREATE UNIQUE INDEX IF NOT EXISTS ux_intake_idem
  ON intake_requests(project_id, idem)
  WHERE idem IS NOT NULL;

-- The supervisor's read is `status = 'pending'` oldest-first.
CREATE INDEX IF NOT EXISTS ix_intake_status
  ON intake_requests(status, created_at);
