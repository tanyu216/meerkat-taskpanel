# `src/core`

The engine of Meerkat TaskPanel. It owns the domain model and everything that can be
expressed without knowing which surface called it — so the CLI and the HTTP API are both
thin adapters over this module.

M1 lands the whole of it: the domain model (`domain/`), the SQLite repository and
migrations (`storage/`, local database `.data/board.sqlite`, overridable with `TASKD_DB`),
the use-cases (`commands/`), the markdown card exporter (`storage/md/`) and `openBoard()`
in `bootstrap.mjs`.

Rules that are enforced, not just documented:

* `domain/` imports no Node builtin at all (`test/core/domain/purity.test.mjs`);
* nothing here imports `cli/` or `server/` — the dependency direction is
  `cli|server → core → foundation`;
* every failure is a `DomainError` with a code, never a bare `Error`;
* a table rebuild re-creates **every** index and trigger the dropped table had, so an
  upgraded board and a fresh install end on the same schema. 0013's rebuild of `tasks`
  lost 0005's `ix_tasks_source` and 0014 restores it (0014's header carries the index
  count 0013's own header got wrong, since its text is frozen); the property is held by
  `test/core/storage/migrations-0013.test.mjs`, which derives the expected set from the
  board *before* 0013 instead of listing it. 0015 (the `deploy` kind) is the next
  rebuild of `tasks` and names all seven indexes itself — the set a board at 0014
  carries, which is what its own `migrations-0015.test.mjs` compares against a fresh
  one;
* the delivery gate is a database trigger *and* a domain check, and the two are
  tested against each other (`test/contract/`);
* the **acceptance baseline** is a column, not writable meta: `tasks.acceptance_json` +
  `acceptance_revision` (0032) are seeded once from `meta.acceptance` / the imported
  checkboxes, can only be appended to (a human may prune an item with an audited reason),
  and are locked once the card is `in_review`. `done` requires the current round's report to
  cover it (`domain/acceptance.mjs#coverageOf`, `commands/acceptance.mjs`), a review
  `APPROVE` requires the review report to cover the original's, and the auto-accept planner
  reads the same report so it never plans an acceptance the write gate would refuse. The DB
  trigger (`tr_tasks_acceptance_revision`) refuses a revision-less rewrite at the source;
* an **epic's** acceptance evidence is its **rollup** (0033): a delivery report marked
  `is_rollup` whose items name each child by `ref`. A report written on an epic is always a
  rollup (`commands/reports.mjs`, `commands/rollup.mjs#advanceContainer`), the delivery gate
  refuses an unmarked current-round report (`ROLLUP_REQUIRED`), `done` refuses a rollup that
  no longer matches the live children (`ROLLUP_STALE`), and the DB trigger
  `tr_tasks_epic_rollup_done` enforces the current-round row at the write. The same pure rule
  (`domain/acceptance.mjs#rollupGapOf`) is read by the sweep and by the workflow planner;
* **questions** (0034) are comments, not a column: an agent entering `awaiting` writes a
  `question` comment in the same transaction (`QUESTION_REQUIRED` if it has neither a
  `--question` nor an unanswered one), and **any human comment** re-queues the card to `todo`
  in the same transaction (`commands/comments.mjs`, `domain/awaiting.mjs#resumeDecision`).
  The board does not read the text: whether the answer is a complete decision is judged by the
  loop's worker, which asks again if it is not. `awaiting → todo` is a whitelist edge, not a
  reopen: the round does not move, the claim is released, and a fresh worker is dispatched;
* the **workflow decisions** are the board's: `domain/workflow.mjs` is pure (reconcile
  classification, review outcomes, review dispatch), and `commands/workflow.mjs` assembles
  a bounded board snapshot for it. `issue reconcile --workflow` exposes the plan; the loop
  executes its review actions. The board itself writes no review action;
* an `epic` is never claimable, **in every status**. Its container auto-start
  (`commands/rollup.mjs#startContainer`) enters `in_progress` with
  `claimed_by = NULL` by design, so the I2 `EXECUTION_STATE_CORRUPT` report is
  scoped to *work* cards: the heartbeat pre-check, `setHeartbeat`'s zero-row
  explainer and `decideClaim` all read one predicate
  (`domain/claim.mjs#isUnownedContainer`). What is deliberately **not** pushed
  into the schema is the reverse guard (`kind = 'epic' AND status = 'in_progress'
  ⇒ claimed_by IS NULL`): a raw trigger would refuse `issue update --kind epic`
  on a claimed card, which keeps its claim in place. Bare SQL can therefore
  still write a `claimed_by` onto an epic; after the service scoping that value
  is inert (the card can be neither claimed nor pulsed), and closing it needs
  the promotion semantics decided first (T-20261018-060214);
* a task command's **input** is declared once, in `commands/tasks-input.mjs`, in
  wire terms — field name, type, vocabulary, multiplicity, and which surface
  carries it. The route's request shape and the CLI's flags and body are
  *projected* from it (`server/requests.mjs#project`, `cli/commands/task-input.mjs`),
  so there is no second hand-kept field list to drift. Each side names its `op`,
  and `scripts/verify/route-request.mjs` proves the three still name the same one
  — as well as that each projection covers exactly the fields its `surface`
  marker says it should.

## Creation idempotency (the main gate is you, the creator)

Two agent turns can race to create the same card. The defence has two layers,
and the ordering matters: the mechanical key below is a **backstop**, not the
gate. The rule is stated in full below and implemented by `domain/idem.mjs`;
provenance: `guides/task-interface.md` §14.

**1 — Main gate: read before you create (semantic, an LLM does it).** Before
creating a card, the creator reads the existing **non-terminal** cards —
`taskctl issue list` — and decides whether the *intent* is already covered.
If it is, do **not** create: reuse the existing card. No mechanical rule can see
intent, so this step cannot be delegated to the key.

**2 — Backstop: the idempotency key (mechanical).** `domain/idem.mjs` derives

```text
idem = <kind> | <assignee> | <source> | <target>
```

(fields `String(x).trim()`, one space around each `|`; `source` is `review_of`,
else `parent`, else `""`). When a create carries a key and a **non-terminal**
task already holds it, the create is **refused and the existing task is
returned** — its `id`/`identifier` *is* the answer — with no new row and no new
activity. Terminal cards (`done`/`canceled`) **release** the key, so the same
work can be created again later — and a **reopen** (`done`/`canceled → todo`)
releases it too, in the same UPDATE that returns the card to the queue.
`--allow-dup` writes `NULL` and bypasses the guard entirely.

The key deliberately **does not look at the title**: a match means "the same
card was submitted twice", not "these are conceptually the same task". A generic
card with no assignee/source/target derives no key at all, so two ordinary cards
never refuse each other.

**The machine guarantee.** The read above is a race; the arbiter is the partial
unique index `ux_tasks_idem_active` (`storage/migrations/0009_task_idem.sql`),
which covers only non-terminal rows and lets `NULL` rows collide. A lost race
surfaces as `IDEM_EXISTS` and `commands/tasks.mjs#createTask` converges onto the
existing row (or re-throws if there is genuinely nothing to reuse).
