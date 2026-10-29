# Development operations

The operational facts you cannot read off the code. Everything else has a canonical home;
this page points at it rather than restating it:

- commands, repository layout, the one-way import rule and the constraints →
  [CLAUDE.md](../../CLAUDE.md)
- the pull-request, merge and release flow → [CONTRIBUTING.md](../../CONTRIBUTING.md)
- the API and CLI contract → [contract.md](contract.md)
- access, tokens and the allow-list → [../access.md](../access.md)
- the event stream and its cursor → [../events.md](../events.md)
- configuration keys, their files and their precedence → [../ops/install.md](../ops/install.md)
- logging, levels and rotation → [../ops/observability.md](../ops/observability.md)
- the standard and the security decision policy → [../tech-spec.md](../tech-spec.md)
- verification in the container, and which checks are host-allowed → [docker.md](docker.md)

## Two build layers: engine and web

The repository builds two independent layers plus a release tree, and the two `dist` names
are **not** the same directory:

| Layer | Source | Build | Output |
|---|---|---|---|
| Engine | `src/**`, `scripts/**` | nothing — Node runs the sources directly | *(no build step)* |
| Web board | `web/**` | Vite (`npm --prefix web run build`) | `web/dist` — the **hosted frontend root**, served by `taskd` (`STATIC_DIR_REL`) |
| Release tree | the tree as the npm whitelist sees it | `node scripts/build.mjs` | `dist/` — the npm **release tree**; never served |

The web layer is the only part with dependencies. Vue/Vite/Tailwind/daisyUI are build-time
devDependencies, installed by the image's `webbuild` stage from the committed npm cache at
`web/.vendor/npm-cache` (`npm ci --offline`) and pinned by `web/package-lock.json`; only the
built `web/dist` crosses into the runtime image, which installs nothing. The cache is a
**generated artefact** (linux/arm64) — after a dependency bump, re-vendor it per
[docker.md](docker.md#re-vendoring-the-npm-cache) and commit it with the lockfile.

`web/dist` is not committed, so the two suites that read it
(`test/web/blocks.bundle.test.mjs`, `test/web/blocks.dom.test.mjs`) skip in a tree that has
not built the frontend. `node scripts/verify/web-dist.mjs` is the verdict: it names the legs
that ran, and `npm run verify` runs it. See
[docker.md](docker.md#which-of-node---tests-legs-actually-ran).

`dist/` is the npm release tree only. Runtime data (`.data/`, logs) and the machine-local
config are outside the repository; their topology is in [../ops/install.md](../ops/install.md).

## Server operations

`node src/server/main.mjs` starts the service; `taskctl` starts it on demand. The routes,
authentication and the event contract live in the documents named above. The three
invariants below are the ones an operator can break without noticing.

### One writer per data directory

The single-writer model is enforced, not assumed. On startup the daemon takes
`<dataDir>/writer.lock` with `O_EXCL` **before** it opens the database; a second `taskd` on
the same `TASKD_DATA_DIR` is refused with `BOARD_ALREADY_RUNNING` (409 in the payload; the
program prints the message and exits non-zero), naming the pid that holds the lock.

- **A crashed daemon needs no cleanup.** A lock whose pid is gone is a fossil: the next
  start logs `writer_lock_stale`, removes it and carries on. Only a *live* holder blocks a
  start.
- **The runtime pointer belongs to its owner, and the owner is the `(pid, dataDir)`
  pair.** A process removes the pointer only while the file names its own pid *and* its own
  data directory, so an exiting instance cannot unplug a live board. A board whose data
  directory is not the sitting board's is addressed beside its own data directory at
  `<dataDir>/runtime.json`.
- **The reader falls back to that file.** `taskctl` resolves *explicit `--url`* → *a healthy
  runtime pointer* → *lazy start*. The pointer step prefers the machine-wide slot, and
  falls back to `<dataDir>/runtime.json` only when the slot is absent, unreadable, or names
  a different data directory. A path the caller *named* (`TASKD_RUNTIME_POINTER`) is obeyed
  verbatim; autostart hands the slot to the child only when the caller named it, so starting
  a board cannot overwrite the slot a live board sits in.

If you see `BOARD_ALREADY_RUNNING` and believe no board is running, stop the named pid; a
lock left by a dead process is removed automatically on the next start (or by hand:
`rm <dataDir>/writer.lock`).

### Stopping the daemon

`SIGTERM` / `SIGINT` is the graceful stop, and it is **bounded**. The daemon releases the
database (no `-wal` is left), removes its runtime pointer, releases the lock and exits 0.

What has to be bounded is the SSE stream. `server.close()` stops accepting and settles only
when every socket is gone — and an `/api/v1/events` response has no reason to end on its
own. The daemon therefore ends those streams itself with a named `shutdown` frame
(`event: shutdown`, carrying no `id:`, so no client advances its cursor past unseen
events), then destroys anything still connected after a short grace (`src/server/index.mjs`:
`closeServer`, `SHUTDOWN_GRACE_MS`).

The board client takes that frame as a restart, not a failure, and owns its reconnect:
exponential backoff (1 s, 2 s, 4 s … held at 30 s), resumed from `?after=<cursor>`, the
ladder reset by a successful `open`. The browser's built-in retry is a fixed interval that
repeats forever; a board down for an hour must not be polled twice a second.

### Lock contention is a 503, not a 500

Writes take the SQLite write lock for one transaction. When another writer holds it past
`busy_timeout` (5 s, pinned per connection), the request is retried a bounded number of
times (`DB_BUSY_MAX_ATTEMPTS` in `src/foundation/constants.mjs`) and then answered with:

```
503 DB_BUSY   Retry-After: 1
```

The write changed nothing, so the retry is safe. An operation that holds the write lock
longer than `busy_timeout × attempts` (a large migration, a stalled disk) makes online
writes retry and then fail; the honest fix is to shorten the hold, not raise the timeout.
Tests pass `busyTimeoutMs` to `createTaskd`/`openBoard`, which is the only supported
override.

The access token is never echoed in a response and never logged. The SSE stream filters
`task_heartbeat` out of the increments because a pulse changes no board state; the row
still exists in `task_activities` and under `/tasks/:ref/activities` (or `/activities`).

> **The built board is loopback-only.** It injects no token, so a browser reaching `taskd`
> from a non-loopback address is answered 401 for every request — a known local-first
> limitation, not a defect. See [../access.md](../access.md) for the full model.
