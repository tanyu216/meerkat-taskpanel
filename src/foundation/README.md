# `src/foundation`

DTOs, type shapes, constants and small pure helpers used by more than one surface
(`src/core`, `src/cli`, `src/server` and the `web/` frontend).

In M1+ this module owns the vocabulary that every surface agrees on: task/agent shapes,
status and priority enums, the `task-interface v1` payload schemas, ID formats, and the
constants exported from `constants.mjs`. Nothing here may import from `src/core` — the
dependency direction is `core/cli/server → foundation`, never the reverse.

## Configuration

| module | what it owns |
|---|---|
| `env-file.mjs` | `parseEnvText` — the `KEY=VALUE` text format, no I/O |
| `env-config.mjs` | `loadEnvFile` — locate the install-root `.env`, parse and validate the allowed keys, and merge file values under the process environment; `readConfigFileVars` re-reads the file for a per-request resolver |
| `sla-config.mjs` | the `TASKD_SLA_*` vocabulary: `DEFAULT_SLA_ROWS`, `readSlaConfig` (process env > `.env` > default), validation, and the `/api/v1/sla` wire shape |
| `runtime-locator.mjs` | `resolveEnvFilePath`, `repoRoot` — the install root and the env-file path |

`loadEnvFile` is called by the entry points only (`src/cli/index.mjs#run`,
`src/server/main.mjs`); library callers receive the parsed
values explicitly, so embedding the engine never reads a developer's `.env`.

## The card brief

Both writers of `.meerkat/<identifier>/card.md` — the loop's exporter and the CLI
watchers — take their path text and their file discipline from here, so a subagent is
never told to read a path, or a format, the other side does not write.

| module | what it owns |
|---|---|
| `card-brief.mjs` | `MEERKAT_PROCESS_DIR`, `CARD_BRIEF_FILE`, `taskDirName`, `cardDirRel`, `cardFileRel` — the path text, pure |
| `card-write.mjs` | `cardTempPath`, `commitCardTemp`, `removeCardTemp`, `writeCardFileAtomic` — the unique-temp + atomic-rename discipline, `node:fs` only; not an exporter |

## `transport/**`

`foundation/transport/**` is the **taskd transport seam**, kept below the CLI surface rather
than inside it (the charter rule: nothing imports `cli`/`server`):

| module | what it owns |
|---|---|
| `http.mjs` | `requestJson`, `withQuery`, `domainErrorFromPayload` — the HTTP envelope + error rebuild |
| `client.mjs` | `createBoardClient` — the interface commands are written against |
| `autostart.mjs` | spawn `taskd`, wait for the pointer, probe `/health` |
| `runtime.mjs` | `ensureBoard`, `readPointer` — find (or start) the board |
| `token.mjs` | `resolveToken`, `isTokenShape` — the `--token` > `$TASKD_TOKEN` > tokenFile ladder |
| `board-url.mjs` | `normalizeBoardUrl`, `isLoopbackUrl` — the board URL's shape and loopback test |
| `actor.mjs` | `resolveActor` — who is running the command |
| `errors.mjs` | `usageError`/`ioError`, exit codes, `errorPayload`, `renderErrorText` |

Unlike the pure helpers above, these modules touch I/O (HTTP, `node:fs`, spawning). They
live here — not in `src/cli` — so the seam sits below the surface and any caller reaches
one implementation, which is what keeps a gate refusal identical everywhere.
`test/foundation/transport-imports.test.mjs` pins the layering.
