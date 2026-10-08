# `src/mcp`

The stdio MCP server (M3). A host launches `node src/mcp/main.mjs`, speaks JSON-RPC 2.0
to it over stdin/stdout, and gets the board's tool surface — tasks, comments, relations,
agent sessions and the read-only dictionaries.

**It is a proxy, and only a proxy.** Three jobs, no fourth:

1. encode/decode JSON-RPC (`protocol.mjs`);
2. project tool arguments onto the `taskd` HTTP surface (`tools/*.mjs`);
3. project the service's answer — success or `DomainError` — into a tool result
   (`result.mjs`).

MCP exists as an *optional* outlet: the skill drives the CLI, and this is for hosts that
speak MCP instead of a shell. That makes "same semantics as the CLI" the whole point, and
"the delivery gate cannot be walked past" the acceptance criterion.

## What it does not own

* **No policy.** There is no delivery-gate logic in this directory — not a check, not a
  preflight `GET`. `task_move` posts `{to, if_version}` and forwards whatever comes back.
  The refusal an MCP caller sees is the `DomainError` `src/core/domain/delivery-gate.mjs`
  raised, rebuilt by `src/cli/client/http.mjs#domainErrorFromPayload` — the *same*
  function and therefore the *same object* the CLI sees, in a different container.
  `test/mcp/gate.test.mjs` asserts a refused `task_move` is field-for-field equal to the
  raw 422 body `taskd` sends.
* **No state machine, no optimistic-concurrency logic, no dictionary policy.** All of it
  lives in the service.
* **No dictionary management surface.** Three read tools (`label_list`, `assignee_list`,
  `reporter_list`) and nothing else. The advertised tool set must *equal* the frozen list
  in `registry.mjs`, and a blacklist assertion checks nothing matching
  `(assignee|reporter|label)_(create|update|rename|…)` got in — a structural guarantee
  rather than a promise.
* **No human renderer.** Nothing imports `src/cli/output/**`; there is no `--json`, and
  no tables. A failure is a JSON document plus, where it helps, one sentence of prose.
* **No database.** Nothing imports `core/storage` or `node:sqlite`. The single-writer
  model is the service's, and the daemon is reached over loopback HTTP like everyone else.

## The 18 tools

`task_list` `task_get` `task_create` `task_update` `task_move` `task_deliver` ·
`task_comment_list` `task_comment_add` ·
`task_relation_list` `task_relation_add` `task_relation_remove` ·
`session_list` `session_set` `session_close` ·
`label_list` `assignee_list` `reporter_list` · `project_list`

Two deliberate restrictions in that set:

* **`task_move` has no `no_report`/`reason`,** and `additionalProperties: false` means
  they cannot be smuggled in. The card makes `task_deliver` the only tool that may reach
  `in_review`, so `task_move → in_review` is a single-branch `REPORT_REQUIRED` and the
  audited waiver is expressible only through `task_deliver`. MCP is therefore *stricter*
  than the CLI, which does offer `issue move … --no-report --reason`; the escape hatch is
  still there, one tool over.
* **`task_update` has no `status`.** The route refuses it (`INVALID_TRANSITION`), so the
  tool cannot say it — the two cannot drift apart if only one of them can be spoken.

Argument vocabulary is the route vocabulary (`snake_case`, `project_id`, `if_version`,
…), so a tool call is a mechanical projection of an HTTP call and nothing is renamed
twice.

## Protocol decisions (hand-written, on purpose)

The project has zero runtime dependencies and an image that builds offline, so MCP's
protocol is written here rather than pulled in — the SDK's value (prompts, resources,
sampling, roots, progress, subscriptions, cursors, a transport matrix) is value this
milestone does not use. What replaces the SDK's guarantee is `protocol.mjs` plus a
contract test that asserts exact documents.

* **Transport:** newline-delimited JSON on stdin/stdout. Chunked arrival and a final line
  with no trailing newline are handled (`createLineFramer`); all writes are whole lines.
* **stdout carries JSON-RPC and nothing else.** Usage, help and warnings go to stderr.
  (Autostarted `taskd` writes to `<dataDir>/logs/taskd.log`, so it cannot corrupt the
  stream either.)
* **`initialize`** declares `capabilities: {tools: {}}` and nothing else — no `resources`,
  `prompts`, `logging` or `completions`, because a capability is a promise to answer a
  method, and this server would answer those with `-32601`.
* **protocolVersion:** known set `2024-11-05`, `2025-03-26`, `2025-06-18` (echoed back
  when the client asks for one of them); otherwise the newest we know.
* **Notifications are never answered.** `notifications/initialized`, `…/cancelled` and
  `…/roots/list_changed` produce zero output — asserted by waiting, not by inspection.
* **Batch is refused:** an array message gets `-32600` with
  `data.reason: "batch_not_supported"`. The 2025 specs do not require batching.
* **Two kinds of failure, kept apart:**
  * *protocol* → `{error: {code}}`: `-32700` unparseable, `-32600` not a request,
    `-32601` unknown method, `-32602` unknown tool / arguments that fail the schema. The
    tool never ran.
  * *tool* → `{result: {content, isError: true}}`: the tool ran and the board refused.
    The `content` is `DomainError.toJSON()`, so `code`, `message`, `http`, `details` and
    `hint` are exactly the service's.
* **No `outputSchema`, no `structuredContent`** — a success result is a single `text`
  block holding the `data` half as JSON. Declaring an output schema would commit this
  server to validating every payload shape; not declaring it commits to nothing.
* **argv is two flags wide.** `--url` and `--token`, meaning exactly what they mean to
  `taskctl`. Anything else is a usage error (exit 2) on stderr, because a host config
  with a typo should fail at launch, not at the first tool call.

## Layering

`mcp → cli (whitelist) → core (over HTTP) → shared`, plus `mcp → shared`.

`board.mjs` is the **only** module here that imports `src/cli`, and only from a whitelist:
`client/index.mjs`, `client/http.mjs`, `runtime.mjs`, `token.mjs`, `actor.mjs`,
`errors.mjs`. Reusing the CLI's transport seam is what makes the gate equivalence
structural rather than aspirational — a second HTTP client would be a second error
mapping. `test/mcp/imports.test.mjs` makes widening that list a deliberate, reviewable
act.

`client/http.mjs` is on the list because `domainErrorFromPayload` lives there. `http.mjs`
is the transport seam (`requestJson`, `withQuery`, the error rebuild), not policy.

## Tests

| file | what it pins |
|---|---|
| `test/mcp/imports.test.mjs` | the layering rules above, against the source text |
| `test/mcp/protocol.test.mjs` | handshake, version negotiation, JSON-RPC codes, the 18 schemas, framing, argv |
| `test/mcp/tools.test.mjs` | 18 tools × success, plus a failure with a stable code for each |
| `test/mcp/gate.test.mjs` | gate equivalence against the raw 422 body and against `taskctl --json`; round bumps; atomic delivery |
| `test/mcp/stdio.test.mjs` | a real child process over real pipes: framing, silence, stdout purity, exit codes |

Run them in the container like everything else: `npm run verify:docker`.

## Not yet

* `package.json` has no MCP `bin` entry and the coverage floor does not include
  `src/mcp/**` (both are outside this card's write surface).
* No `resources`/`prompts`; a deployment that needs them should re-open the SDK question
  rather than grow this file.
