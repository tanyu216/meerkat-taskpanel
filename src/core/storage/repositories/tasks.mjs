/**
 * Tasks — reads, and every write as a compare-and-swap.
 *
 * There is no `save(task)`: a blind write would race. Every mutation states the
 * version it expects, and a 0-row result is turned into the *reason* it lost
 * (version conflict vs. claim lost vs. gone) by re-reading inside the same
 * transaction. That is I1/I3/D4 in one place.
 *
 * **Internal contract** (R3). These methods are the storage half of a use-case,
 * not a public API: the domain decision that says *whether* a write is allowed
 * lives in `src/core/domain/**`, the audit row that records it lives in
 * `src/core/commands/**`, and a caller that invokes a `*Cas` directly gets the
 * CAS without either. So nothing outside `src/core` may import this module —
 * `src/cli/**` and `src/server/**` reach writes through `board.commands`, the
 * layer that wraps them in one transaction with their domain checks and their
 * activity row — and the `*Cas` methods are called only from
 * `src/core/commands/**`. Both directions are asserted, not documented:
 * `test/concurrency/repository-boundary.test.mjs`.
 */

import { DomainError } from "../../../shared/errors.mjs";
import { HEARTBEAT_FRESH_MS, TASK_LIST_DEFAULT_LIMIT } from "../../../shared/constants.mjs";
import { holderLabel, isUnownedContainer } from "../../domain/claim.mjs";
import { holdsClaim } from "../../domain/status.mjs";
import { TASK_COLUMNS, taskFromRow, taskToRow } from "../../domain/task.mjs";
import { mapSqliteError } from "../sqlite-errors.mjs";
import { transaction } from "../unit-of-work.mjs";

/** Columns a caller may patch through `updateCas` (camelCase). */
const PATCHABLE = [
  "title",
  "description",
  "priority",
  "kind",
  "labels",
  "sortOrder",
  "assigneeId",
  // 0023 — the kind travelling with each reference. A caller that patches the
  // reference patches the kind in the same write, because the two are one fact:
  // an assignment whose kind stayed behind would name a person the card is no
  // longer about.
  "assigneeKind",
  "reporterId",
  "reporterKind",
  "agentSession",
  "threadId",
  "threadSource",
  "sourceHash",
  "meta",
  // 0016 — carried onto the row by a re-import (`md/import.mjs#patchFrom`), so
  // a card whose reason changed is corrected rather than silently skipped.
  "blockedReason",
];

const SELECT_LIST = TASK_COLUMNS.join(", ");

/** @param {import('node:sqlite').DatabaseSync} db */
export function createTasksRepository(db) {
  const selectById = db.prepare(`SELECT ${SELECT_LIST} FROM tasks WHERE id = ?`);
  const selectByIdentifier = db.prepare(
    `SELECT ${SELECT_LIST} FROM tasks WHERE project_id = ? AND identifier = ?`,
  );
  // The idempotency guard's read. Mirrors the partial index's predicate exactly
  // (non-terminal only) so a key released by `done`/`canceled` is not reused
  // here — the same rule in two places, deliberately (0009_task_idem.sql).
  const selectByIdemActive = db.prepare(
    `SELECT ${SELECT_LIST} FROM tasks
      WHERE idem = ? AND status NOT IN ('done','canceled')
      ORDER BY created_at ASC LIMIT 1`,
  );
  // 0025 — the review cards of one original. `review_of_id` is an internal id,
  // so this read never depends on how a caller spells a reference.
  const selectReviewsOf = db.prepare(
    `SELECT ${SELECT_LIST} FROM tasks WHERE review_of_id = ? ORDER BY created_at ASC, identifier ASC`,
  );
  const selectReviewCardsByProject = db.prepare(
    `SELECT ${SELECT_LIST} FROM tasks
      WHERE review_of_id IS NOT NULL AND project_id = ?
      ORDER BY created_at ASC, identifier ASC`,
  );
  const selectReviewCards = db.prepare(
    `SELECT ${SELECT_LIST} FROM tasks
      WHERE review_of_id IS NOT NULL
      ORDER BY created_at ASC, identifier ASC`,
  );

  /** @param {string} id */
  const requireTask = (id) => {
    const task = taskFromRow(selectById.get(id));
    if (task === null) {
      throw new DomainError("NOT_FOUND", { message: `no task ${id}`, details: { taskId: id } });
    }
    return task;
  };

  return {
    /** @param {object} task a Task DTO */
    insert(task) {
      const row = taskToRow(task);
      try {
        db.prepare(
          `INSERT INTO tasks(${TASK_COLUMNS.join(", ")})
           VALUES (${TASK_COLUMNS.map(() => "?").join(", ")})`,
        ).run(...TASK_COLUMNS.map((column) => row[column] ?? null));
      } catch (err) {
        throw mapSqliteError(err, { op: "tasks.insert", table: "tasks" });
      }
      return requireTask(task.id);
    },

    get(id) {
      return taskFromRow(selectById.get(id));
    },

    getByIdentifier(projectId, identifier) {
      return taskFromRow(selectByIdentifier.get(projectId, identifier));
    },

    /**
     * The non-terminal task holding `idem`, or `null`. This is the read half of
     * the creation guard; the partial unique index is the write half, and the
     * two must agree on "non-terminal only".
     * @param {string} idem
     */
    findByIdemActive(idem) {
      return taskFromRow(selectByIdemActive.get(idem));
    },

    /**
     * Identifier across projects — what an agent has in hand when it types
     * `taskctl issue get PROJ-0007`. Identifiers are only unique per project, so
     * an ambiguous one is refused rather than guessed.
     * @param {string} identifier
     */
    findByIdentifierAnyProject(identifier) {
      const rows = db
        .prepare(`SELECT ${SELECT_LIST} FROM tasks WHERE identifier = ? ORDER BY created_at ASC, project_id ASC LIMIT 2`)
        .all(identifier);
      if (rows.length > 1) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `identifier ${identifier} exists in more than one project — pass the project id`,
          details: { identifier, candidates: rows.length },
        });
      }
      return taskFromRow(rows[0]);
    },

    /**
     * The cards that audit `originalId` (0025's structural read).
     * @param {string} originalId
     */
    listReviewsOf(originalId) {
      return selectReviewsOf.all(originalId).map(taskFromRow);
    },

    /**
     * Every review card — optionally one project's. Used by the read surfaces
     * that need the whole marker set (the board's waiting projection does its
     * own derivation client-side; this is for server/tests).
     * @param {string} [projectId]
     */
    listReviewCards(projectId) {
      return (projectId === undefined ? selectReviewCards : selectReviewCardsByProject)
        .all(...(projectId === undefined ? [] : [projectId]))
        .map(taskFromRow);
    },

    /** Either id or identifier — whichever the caller has. */
    resolve(projectId, idOrIdentifier) {
      return (
        taskFromRow(selectById.get(idOrIdentifier)) ??
        taskFromRow(selectByIdentifier.get(projectId, idOrIdentifier))
      );
    },

    /**
     * The board read.
     *
     * `assigneeId` accepts an array as well as a value, and `unassignedOnly`
     * selects the open pool — both exist so a caller can push a whole *scope*
     * into SQL instead of filtering a page in JS (R16: the candidate read used to
     * do `list({status:"todo"})` — capped at 200 — and only then filter by
     * assignee, i.e. truncate-before-filter).
     *
     * `limit: null` asks for **no `LIMIT` clause at all**. It is the honest way to
     * say "I need the whole scoped set", which is what an order computed in JS
     * needs before it paginates: sorting a page and slicing it is how you get a
     * beautifully ordered wrong page.
     *
     * @param {{projectId?: string, status?: string|string[], assigneeId?: string|string[], unassignedOnly?: boolean, includeArchived?: boolean, limit?: number|null, offset?: number}} [filter]
     */
    list(filter = {}) {
      const clauses = [];
      const values = [];
      if (filter.projectId !== undefined) {
        clauses.push("project_id = ?");
        values.push(filter.projectId);
      }
      // `kind` is the container reconciler's scope read (commands/rollup.mjs):
      // it needs every non-terminal epic without paging the whole board.
      if (filter.kind !== undefined) {
        clauses.push("kind = ?");
        values.push(filter.kind);
      }
      if (filter.status !== undefined) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        values.push(...statuses);
      }
      if (filter.assigneeId !== undefined) {
        const ids = Array.isArray(filter.assigneeId) ? filter.assigneeId : [filter.assigneeId];
        if (ids.length === 0) {
          clauses.push("1 = 0");
        } else {
          clauses.push(`assignee_id IN (${ids.map(() => "?").join(", ")})`);
          values.push(...ids);
        }
      }
      if (filter.unassignedOnly === true) {
        clauses.push("(assignee_id IS NULL OR assignee_id = '')");
      }
      if (!filter.includeArchived) clauses.push("archived_at IS NULL");

      const unbounded = filter.limit === null;
      const limit = Number.isInteger(filter.limit) ? filter.limit : TASK_LIST_DEFAULT_LIMIT;
      const offset = Number.isInteger(filter.offset) ? filter.offset : 0;
      const sql = `SELECT ${SELECT_LIST} FROM tasks
                   ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
                   -- Deterministic: two tasks created in the same millisecond
                   -- must not come back in a random order (exports depend on it).
                   ORDER BY sort_order ASC, created_at ASC, project_id ASC, identifier ASC
                   ${unbounded ? "" : "LIMIT ? OFFSET ?"}`;
      return (unbounded ? db.prepare(sql).all(...values) : db.prepare(sql).all(...values, limit, offset)).map(
        taskFromRow,
      );
    },

    /**
     * Patch a task if it is still at `ifVersion`.
     *
     * @param {{id: string, ifVersion?: number, patch: object, now: string}} input
     * @returns {object} the updated Task DTO
     */
    updateCas(input) {
      const { id, ifVersion, patch, now } = input;
      const unknown = Object.keys(patch).filter((field) => !PATCHABLE.includes(field));
      if (unknown.length > 0) {
        throw new DomainError("VALIDATION_FAILED", {
          message: `not patchable: ${unknown.join(", ")}`,
          details: { fields: unknown, allowed: PATCHABLE },
        });
      }

      return transaction(
        db,
        () => {
          const row = taskToRow(patch, Object.keys(patch));
          const sets = Object.keys(row).map((column) => `${column} = ?`);
          const values = Object.values(row);
          sets.push("version = version + 1", "updated_at = ?");
          values.push(now);

          const where = ["id = ?"];
          const whereValues = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            whereValues.push(ifVersion);
          }

          let info;
          try {
            info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).run(...values, ...whereValues);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.updateCas", table: "tasks" });
          }
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.updateCas" },
      );
    },

    /**
     * Claim a `todo` task. Returns `{claimed: false}` when the CAS found nothing
     * — the caller decides why, via `domain/claim.mjs#explainLostClaim`.
     *
     * @param {{id: string, ifVersion?: number, actor: string, now: string}} input
     * @returns {{claimed: boolean, task: object|null}}
     */
    claimCas(input) {
      const { id, ifVersion, actor, claimedKind = null, now } = input;
      const where = ["id = ?", "status = 'todo'"];
      const values = [id];
      if (ifVersion !== undefined) {
        where.push("version = ?");
        values.push(ifVersion);
      }

      return transaction(
        db,
        () => {
          let info;
          try {
            info = db
              .prepare(
                `UPDATE tasks
                    SET status = 'in_progress', claimed_by = ?, claimed_kind = ?, claimed_at = ?, heartbeat_at = ?,
                        status_changed_at = ?, version = version + 1, updated_at = ?
                  WHERE ${where.join(" AND ")}`,
              )
              .run(actor, claimedKind, now, now, now, now, ...values);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.claimCas", table: "tasks" });
          }
          if (Number(info.changes) === 0) return { claimed: false, task: taskFromRow(selectById.get(id)) };
          return { claimed: true, task: requireTask(id) };
        },
        { op: "tasks.claimCas" },
      );
    },

    /**
     * Move a task's status. The delivery gate and the round bump are triggers,
     * so this method passes no policy — only the CAS.
     *
     * `waiver` (F-B1) stamps the three `report_waiver_*` columns in the *same*
     * UPDATE as the status change. That is what makes the trigger's waiver
     * branch see them, and what keeps a waived delivery to one revision.
     *
     * `awaitingReason` (M1) does the same job for the `awaiting` entry category:
     * entering `awaiting` stamps `E1..E5`, and **leaving** it clears the column
     * in the same UPDATE. Clearing is not tidiness — a resumed or canceled card
     * that kept a stale reason would make `issue get` claim it is still waiting
     * on somebody, and the revision trigger would report a change that did not
     * happen. The column is therefore written on every move, derived from the
     * destination status, never left to the caller.
     *
     * `blockedReason` (0016) is the same shape for the `blocked` card's class:
     * written on entry, cleared by every exit. It is the deliberate opposite of
     * `blocked_at` just below — that one is *kept* on the way out, because it
     * dates the last blockage — whereas the reason describes the *current*
     * block, so a card that has moved on must not keep claiming it is waiting on
     * something. Both stay inside this one UPDATE, so status, timestamps and
     * reasons can never disagree.
     *
     * The **execution claim** (`claimed_by`/`claimed_at`/`heartbeat_at`) follows
     * the same "derive it from the destination" rule
     * (T-20261014-152924), keyed on `status.mjs#holdsClaim`: the lock is held
     * while the card is in the work cycle and released by the one UPDATE that
     * takes it out. Releasing it *here*, in the same write, is what makes the
     * schema's `CHECK (claimed_by IS NULL OR status <> 'backlog')` unreachable
     * from the service: `in_progress → todo` used to leave `claimed_by` behind,
     * and the legal `todo → backlog` then tripped the CHECK — surfacing to the
     * board as a raw `CHECK constraint failed: …`. See
     * `domain/status.mjs#CLAIM_HOLDING_STATUSES` for why `in_review`/`blocked`
     * count as *inside* the cycle.
     *
     * @param {{id: string, ifVersion?: number, to: string, now: string, reportLatestId?: number|null, waiver?: {round: number, reason: string}|null, awaitingReason?: string|null, blockedReason?: string|null}} input
     */
    moveCas(input) {
      const { id, ifVersion, to, now, reportLatestId, waiver, awaitingReason, blockedReason } = input;
      return transaction(
        db,
        () => {
          const sets = ["status = ?", "status_changed_at = ?", "version = version + 1", "updated_at = ?"];
          const values = [to, now, now];
          // M1 — the reason column follows the status: set on entry, cleared on
          // every exit (including a move that never touches `awaiting`).
          sets.push("awaiting_reason = ?");
          values.push(to === "awaiting" ? (awaitingReason ?? null) : null);
          // 0016 — the block's class, written the same way and for the same
          // reason: an unset reason is NULL (never ""), and every exit clears it.
          sets.push("blocked_reason = ?");
          values.push(to === "blocked" ? (blockedReason ?? null) : null);
          if (to === "blocked") {
            sets.push("blocked_at = ?");
            values.push(now);
          }
          // The execution lock follows the work cycle: leaving it (a move to
          // `todo`, `backlog`, `done` or `canceled`) releases the claim in this
          // same UPDATE, so no reader can ever see a card carrying a claim it
          // no longer owns — and the backlog CHECK cannot be reached from here.
          if (!holdsClaim(to)) {
            sets.push("claimed_by = NULL", "claimed_kind = NULL", "claimed_at = NULL", "heartbeat_at = NULL");
          }
          if (reportLatestId !== undefined) {
            sets.push("report_latest_id = ?");
            values.push(reportLatestId);
          }
          if (waiver !== undefined && waiver !== null) {
            sets.push("report_waiver_round = ?", "report_waiver_reason = ?", "report_waived_at = ?");
            values.push(waiver.round, waiver.reason, waiver.at ?? now);
          }
          const where = ["id = ?"];
          const whereValues = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            whereValues.push(ifVersion);
          }

          let info;
          try {
            info = db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`).run(...values, ...whereValues);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.moveCas", table: "tasks" });
          }
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.moveCas" },
      );
    },

    /**
     * Take over a task that is `in_progress` but whose claim went stale — the
     * one deliberate exception to "claims only start from todo".
     *
     * **The staleness predicate lives here** (R3). It used to live only in the
     * command layer (`domain/claim.mjs`), which meant this bare method would
     * happily steal a claim that had just been taken: two direct calls —
     * `claimCas` then `stealStaleClaim` — wrote the row twice, and two
     * `stealStaleClaim` calls stole from each other in sequence. Neither is
     * reachable from the CLI or the HTTP surface, but "the only thing between a
     * correct caller and a double write is etiquette" is not a guarantee.
     *
     * So the write states its own precondition, and it **clamps it**:
     *
     *   * `staleBefore` is mandatory — the instant before which a heartbeat
     *     counts as stale. A caller that omits it gets a `VALIDATION_FAILED`,
     *     not a permissive default.
     *   * the effective bound is `min(staleBefore, now − HEARTBEAT_FRESH_MS)`.
     *     That floor is the repository's own: a claim whose heartbeat is fresher
     *     than the *fresh* window is never stealable, by anyone, however loose a
     *     bound the caller passes. A caller may ask for something stricter; it
     *     cannot ask for something looser. Without the clamp, a caller passing
     *     `staleBefore = now` would make the guard vacuous again.
     *
     * The comparison goes through `julianday()` so it is an *instant* comparison
     * rather than a string one — two ISO renderings of the same moment
     * (`…:00Z` and `…:00.000Z`) must not order differently. It also means an
     * unparseable timestamp yields `NULL`, the predicate is false, and the steal
     * is refused: garbage is not evidence of staleness.
     *
     * After a takeover the heartbeat is `now`, so a second, unfreshened steal
     * matches nothing and loses the CAS.
     *
     * @param {{id: string, ifVersion?: number, actor: string, now: string, staleBefore: string}} input
     */
    stealStaleClaim(input) {
      const { id, ifVersion, actor, claimedKind = null, now, staleBefore } = input;
      const bound = stealBound({ now, staleBefore });
      return transaction(
        db,
        () => {
          const where = [
            "id = ?",
            "status = 'in_progress'",
            "(heartbeat_at IS NULL OR julianday(heartbeat_at) <= julianday(?))",
          ];
          const values = [id, bound];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            values.push(ifVersion);
          }
          const info = db
            .prepare(
              `UPDATE tasks
                  SET claimed_by = ?, claimed_kind = ?, claimed_at = ?, heartbeat_at = ?, version = version + 1, updated_at = ?
                WHERE ${where.join(" AND ")}`,
            )
            .run(actor, claimedKind, now, now, now, ...values);
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.stealStaleClaim" },
      );
    },

    /**
     * Refresh the heartbeat. Does not touch `status` or `claimed_by`, so it can
     * never resurrect a task somebody else moved.
     *
     * A 0-row result is explained from the re-read row, and the three ways to
     * match nothing are three different answers: the card is no longer being
     * executed (there is nothing to pulse — `INVALID_TRANSITION`), it is being
     * executed by somebody else (`EXECUTION_ACTIVE`), or it is `in_progress`
     * with no holder at all, which is the corrupt state I2 names
     * (`EXECUTION_STATE_CORRUPT`). The last two used to share one branch, so an
     * unclaimed card reported itself as "held by null".
     *
     * `describeHolder` is the same injected resolver `decideClaim` takes: since
     * `0020` `claimed_by` is an actor **id**, and the `EXECUTION_ACTIVE` message
     * should name the holder rather than print a uuid. The command layer supplies
     * it (this repository has no dictionary); with no resolver the id stands in.
     * The `details.claimedBy` payload stays the **id** — it is the stable
     * machine-readable value a client keys on, and the message is the prose.
     *
     * @param {{id: string, actor: string, now: string, describeHolder?: ((id: string) => string|null|undefined)}} input
     */
    setHeartbeat(input) {
      const { id, actor, now, describeHolder } = input;
      try {
        const info = db
          .prepare(
            `UPDATE tasks SET heartbeat_at = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND status = 'in_progress' AND claimed_by = ?`,
          )
          .run(now, now, id, actor);
        if (Number(info.changes) === 0) {
          const current = taskFromRow(selectById.get(id));
          if (current === null) {
            throw new DomainError("NOT_FOUND", { message: `no task ${id}`, details: { taskId: id } });
          }
          const details = { taskId: id, status: current.status, claimedBy: current.claimedBy, actor };
          if (current.status !== "in_progress") {
            throw new DomainError("INVALID_TRANSITION", {
              message: `task ${current.identifier} is ${current.status}, not in_progress — nothing to pulse`,
              details,
            });
          }
          if (current.claimedBy === null || current.claimedBy === "") {
            // An epic in `in_progress` with no holder is the container
            // auto-start, by design — not the I2 corruption of a work card
            // that lost its holder (T-20261018-060214).
            if (isUnownedContainer(current)) {
              throw new DomainError("INVALID_TRANSITION", {
                message: `task ${current.identifier} is an epic; a container carries no claim — nothing to pulse`,
                details,
              });
            }
            throw new DomainError("EXECUTION_STATE_CORRUPT", {
              message: `task ${current.identifier} is in_progress but nobody claims it`,
              details,
            });
          }
          throw new DomainError("EXECUTION_ACTIVE", {
            message: `task ${current.identifier} is held by ${holderLabel(current.claimedBy, describeHolder)}`,
            details,
          });
        }
      } catch (err) {
        throw mapSqliteError(err, { op: "tasks.setHeartbeat", table: "tasks" });
      }
      return requireTask(id);
    },

    /**
     * Point `report_latest_id` at a report. The "it belongs to this task" rule
     * is a trigger (`tr_latest_report_belongs`) — not repeated here.
     *
     * `updated_at` is deliberately untouched: pointing at a report is
     * bookkeeping, not an edit of the card, and bumping the timestamp would
     * make a pure export/import round trip look like a modification.
     * @param {{id: string, reportId: number}} input
     */
    setReportLatest(input) {
      try {
        const info = db
          .prepare("UPDATE tasks SET report_latest_id = ? WHERE id = ?")
          .run(input.reportId, input.id);
        if (Number(info.changes) === 0) {
          throw new DomainError("NOT_FOUND", { message: `no task ${input.id}`, details: { taskId: input.id } });
        }
      } catch (err) {
        throw mapSqliteError(err, { op: "tasks.setReportLatest", table: "tasks" });
      }
      return requireTask(input.id);
    },

    /**
     * Archive a finished task. Status is never touched (I6) — the trigger
     * refuses anything non-terminal, and the waiting period is policy applied by
     * the caller.
     * @param {{id: string, ifVersion?: number, now: string}} input
     */
    archive(input) {
      const { id, ifVersion, now } = input;
      return transaction(
        db,
        () => {
          const where = ["id = ?"];
          const values = [id];
          if (ifVersion !== undefined) {
            where.push("version = ?");
            values.push(ifVersion);
          }
          let info;
          try {
            info = db
              .prepare(`UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ? WHERE ${where.join(" AND ")}`)
              .run(now, now, ...values);
          } catch (err) {
            throw mapSqliteError(err, { op: "tasks.archive", table: "tasks" });
          }
          if (Number(info.changes) === 0) throw lostUpdate(db, id, ifVersion);
          return requireTask(id);
        },
        { op: "tasks.archive" },
      );
    },
  };
}

/**
 * The instant a heartbeat must be at or before for a steal to be allowed (R3).
 *
 * `staleBefore` is the caller's stated bound and is mandatory; the *fresh*
 * window is the repository's own floor and clamps it. A caller can be stricter
 * than the floor, never looser.
 *
 * @param {{now: string, staleBefore: string}} input
 * @returns {string} a canonical ISO instant for `julianday()`
 */
function stealBound({ now, staleBefore }) {
  if (typeof staleBefore !== "string" || staleBefore.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", {
      message: "stealStaleClaim: staleBefore is required — a steal must state the staleness bound it enforces",
      details: { field: "staleBefore", op: "tasks.stealStaleClaim" },
      hint: { fix: "pass the ISO instant before which a heartbeat counts as stale" },
    });
  }
  const stated = new Date(staleBefore).getTime();
  const at = new Date(now).getTime();
  if (!Number.isFinite(stated) || !Number.isFinite(at)) {
    throw new DomainError("VALIDATION_FAILED", {
      message: "stealStaleClaim: now and staleBefore must be parseable timestamps",
      details: { field: Number.isFinite(at) ? "staleBefore" : "now", now: String(now), staleBefore: String(staleBefore) },
    });
  }
  return new Date(Math.min(stated, at - HEARTBEAT_FRESH_MS)).toISOString();
}

/**
 * A CAS that matched nothing: say why, from inside the same transaction so the
 * answer cannot itself be stale.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {number|undefined} ifVersion
 */
function lostUpdate(db, id, ifVersion) {
  const current = db.prepare("SELECT id, version FROM tasks WHERE id = ?").get(id);
  if (current === undefined) {
    return new DomainError("NOT_FOUND", { message: `no task ${id}`, details: { taskId: id } });
  }
  if (ifVersion !== undefined && Number(current.version) !== ifVersion) {
    return new DomainError("VERSION_CONFLICT", {
      message: `task ${id} is at version ${current.version}, expected ${ifVersion} — re-read and retry once`,
      details: { taskId: id, currentVersion: Number(current.version), expectedVersion: ifVersion },
    });
  }
  return new DomainError("VALIDATION_FAILED", {
    message: `task ${id} could not be updated`,
    details: { taskId: id, expectedVersion: ifVersion ?? null, currentVersion: Number(current.version) },
  });
}
