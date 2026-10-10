# The API contract snapshot

`test/contract/` proves the API *behaves*. It cannot prove the API *still looks
the same*: a route quietly renamed, a route's request field dropped or retyped,
an error code's HTTP status moved, a wire field dropped or retyped, an MCP
argument added or its type or allowed values changed. Those are precisely the
changes that break a client, and none of them fails a behavioural test that was
written against the old shape.

`scripts/verify/contract.mjs` closes that gap. It reads the live surface and
writes it down as JSON — a **snapshot** — which is committed and compared on
every push and every pull request. A change to the surface must be accompanied
by an explicit snapshot update; drift is a failure, not a warning.

## What is frozen

| Section | Source of truth | Frozen |
|---|---|---|
| `routes` | `registerApiRoutes` in `src/server/index.mjs` (the same function `createTaskd` calls), plus the endpoints served outside the JSON router (`/health`, `/meta`, `/api/v1/events`, attachment bytes) | `METHOD /path`, and the route's **declared request schema** (`{query, body}`) down to `type`, `enum`, `items`, `anyOf`, `properties`, `required` and `additionalProperties` — recursively |
| `errors` | `ERROR_CODES` in `src/shared/errors.mjs` | the code and its HTTP status |
| `wire` | every `*ToWire` projection in `src/shared/wire.mjs` | the name **and JSON type** of every field each shape emits, including the nested `task.assignee` / `task.reporter` / `task.report_waiver` |
| `mcp_tools` | `TOOLS` in `src/mcp/registry.mjs` | each tool's name and its `inputSchema` down to `type`, `enum`, `items`, `anyOf`, `properties`, `required` and `additionalProperties` — recursively |

Nothing is a second copy of a list. The routes are *enumerated* by registering
them against a stub router (registration only records `{method, pattern, handler,
request}` — no handler runs), the error codes are read from `ERROR_CODES`, the
wire names and types from the projections themselves, the tools and their
schemas from `TOOLS`, and each route's request shape from the declaration that
same registration carries. A route therefore cannot be added to the server
without appearing in the snapshot, nor can one of its request fields move
without the snapshot saying so.

The wire **type** is read off a probe projection: each `*ToWire` function is
called with one subject that populates every field it reads, so the emitted type
is the type a client actually receives when the field is present (`task.version`
is a `number`, `task.labels` is an `array`). A projection that starts emitting a
string where it emitted a number moves the snapshot; an empty probe would have
frozen "everything is `null`" and nothing more.

Bumping the snapshot's own layout (not a section) bumps `schema_version`. It is
**3** as of the route request shapes described below; **2** added the wire field
types and the recursive MCP `inputSchema` facts; **1** was the original
routes/errors/wire-names/MCP-arguments snapshot.

## What is deliberately *not* frozen

Error **messages** and **hints**, route handler internals, and JSON-Schema
`description`s (and any other prose key). Those are prose — they are expected to
change, and freezing them would turn every wording edit into a snapshot chore.
Only what a client binds to is frozen.

## Routes: the declared request shape

Every route registration carries a **declarative request schema** — `{query,
body}` — as a third argument (`src/server/requests.mjs` owns the vocabulary):

```js
router.post("/api/v1/tasks/:ref/move", handler, { body: MOVE_BODY });
```

The snapshot freezes it exactly as it freezes a tool's `inputSchema`: each route
gains `request.query` / `request.body`, canonicalised to `type`, `enum`, `items`,
`anyOf`, `properties`, `required` and `additionalProperties`, and a facet of it
can be diffed by name (`POST /api/v1/tasks/:ref/move.body.to.enum`). A `null`
side is itself a fact worth freezing: *this* route takes no body, *that* one
takes no query.

Three things follow, and the third is the point:

- **The vocabulary is the domain's.** `STATUSES`, `PRIORITIES`, `RELATION_TYPES`,
  `COMMENT_KINDS` and friends come from `src/core/domain/enums.mjs` — the same
  literals the SQL `CHECK (... IN (...))` clauses and the domain validators use —
  so a status added to the domain widens the declared request shape too, and the
  gate reports the drift rather than letting the two disagree.
- **Query values are strings.** `?limit=50` reaches a handler as `"50"`, and
  `?status=a&status=b` as an array, so a query schema declares a string where the
  handler will parse an integer. Declaring `number` would describe a value the
  route is never handed.
- **It is declared, not enforced.** Handlers still read `query.get(...)` /
  `body.…` and unknown fields are still ignored — which is why the declared
  objects are `additionalProperties: true` and why adding a declaration changes
  nothing a caller can observe. The schema is the shape the route *promises*, and
  the snapshot is what keeps a promise from changing silently. Validating against
  it would be a behavioural change and belongs in a card that says so.

`test/verify/contract.test.mjs` pins the premise in both directions: every route
must carry such a declaration, and each one is checked down to its facets — and
the drift tests retype, drop and widen a route request field and assert the gate
goes red (exit 1) and back green.

## Commands

```bash
node scripts/verify/contract.mjs            # compare live vs committed
node scripts/verify/contract.mjs --update   # rewrite the committed snapshot
node scripts/verify/contract.mjs --print    # the live snapshot, to stdout
node scripts/verify/contract.mjs --base <dir>   # compare against another tree
node scripts/verify/contract.mjs --file <name>  # a non-default snapshot path
```

Exit codes: **0** the tree matches the snapshot (or `--print` / `--update` ran);
**1** drift — the API moved and the snapshot was not updated; **2** bad usage, or
the snapshot file is missing, unreadable or not valid JSON.

The snapshot lives at `test/fixtures/contract/api.snapshot.json`. Node builtins
only — no `npm install`, no network.

## Determinism

The snapshot is deterministic by construction: keys are sorted at every level,
`enum` and `required` lists are sorted, properties are ordered by key, every
other list has an explicit sort order, and the file ends in one newline. Two runs
on the same tree are byte-identical, so a diff always means a contract change and
never a reordering — reordering a `STATUSES` array in `src/` is not a contract
change and must not turn the gate red.

The checker enforces this rather than assuming it: a file that is semantically
equal but hand-reordered or re-indented is reported as a `format` change and must
be regenerated with `--update`. (That is why the check is stronger than a
`diff` against freshly printed output — it pins *this* file, not a second copy.)

## Where it runs

| Door | What it runs |
|---|---|
| `.githooks/pre-push` | the contract check on **every** push (the API ships in every commit, not only a tag), then the tag↔CHANGELOG rule |
| `.githooks/pre-tag` | the same two rules, by hand, *before* `git tag` |
| `.github/workflows/contract-gate.yml` | the contract check on every branch push and pull request |
| `.github/workflows/version-gate.yml` | the contract check at tag time, next to the changelog gate |
| `docker/verify-in-container.sh` | the contract check inside the full container suite (`npm run verify:docker`) |

`check.yml` is owned by a concurrent change and is deliberately not touched, the
same reason the changelog rule lives in `version-gate.yml`; `contract-gate.yml`
is the pull-request-time authority. See
[`.githooks/README.md`](../.githooks/README.md) for the hook table.

## Changing the API

1. Make the change in `src/` and, if it is behavioural, add the test under
   `test/contract/` that proves it.
2. Read what moved:

   ```bash
   node scripts/verify/contract.mjs
   ```

   A `route_added` / `route_request_changed` / `error_removed` /
   `wire_field_added` / `wire_type_changed` / `mcp_schema_changed` /
   `mcp_tool_added` line is the change, spelt out. The `mcp_schema_*` and
   `route_request_*` lines name the exact facet (`task_move.to.enum`,
   `GET /api/v1/tasks.query.limit.type`, not just the tool or the route), so a
   widened status vocabulary reads as the one value that moved.
3. If it is intended, refresh the snapshot and commit it **with** the change:

   ```bash
   node scripts/verify/contract.mjs --update
   git add test/fixtures/contract/api.snapshot.json
   ```

If it is *not* intended, the checker has just caught a regression before it
reached a client.

## See also

- [`../src/core/README.md`](../src/core/README.md) — the domain rules the error
  codes name.
- [`../src/mcp/README.md`](../src/mcp/README.md) — the 18-tool MCP surface.
- [`publishing.md`](publishing.md) — the release flow the tag-time gates sit in.
