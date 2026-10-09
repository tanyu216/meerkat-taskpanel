# `src/shared`

Shared DTOs, type shapes, constants and small pure helpers used by more than one surface
(`src/core`, `src/cli`, `src/mcp`, `src/server` and the `web/` frontend).

In M1+ this module owns the vocabulary that every surface agrees on: task/agent shapes,
status and priority enums, the `task-interface v1` payload schemas, ID formats, and the
constants exported from `constants.mjs`. Nothing here may import from `src/core` — the
dependency direction is `core/cli/mcp/server → shared`, never the reverse.

## `transport/**`

`shared/transport/**` is the **taskd transport seam**, shared by the two client surfaces
so neither has to import the other (the charter rule: nothing imports `cli`/`mcp`/`server`):

| module | what it owns |
|---|---|
| `http.mjs` | `requestJson`, `withQuery`, `domainErrorFromPayload` — the HTTP envelope + error rebuild |
| `client.mjs` | `createBoardClient` — the interface commands are written against |
| `autostart.mjs` | spawn `taskd`, wait for the pointer, probe `/health` |
| `runtime.mjs` | `ensureBoard`, `readPointer` — find (or start) the board |
| `token.mjs` | `resolveToken`, `isTokenShape` — the `--token` > `$TASKD_TOKEN` > tokenFile ladder |
| `actor.mjs` | `resolveActor` — who is running the command |
| `errors.mjs` | `usageError`/`ioError`, exit codes, `errorPayload`, `renderErrorText` |

Unlike the pure helpers above, these modules touch I/O (HTTP, `node:fs`, spawning). They
live here — not in `src/cli` — because `src/mcp` needs the same seam, and one seam is what
keeps a gate refusal identical for both surfaces. `test/shared/transport-imports.test.mjs`
pins the layering.
