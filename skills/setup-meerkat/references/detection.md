# Detection

`scripts/detect.mjs` is read-only. It never writes, never starts a board, and runs
`taskctl` only with `--version` (`--help`/`--version` are answered before identity and
board resolution). All other probes use `TASKD_NO_AUTOSTART=1`.

`scripts/audit-config.mjs` is the other read-only probe: it reads the env layers, the shim
and the host kind's identity settings, and reports conflicts. It never writes and never
prints a secret value. Its contract is in `config.md`.

## Versions

`checkout.version` is the source `package.json`; `taskctl.version` is the installed CLI;
`server.health.version` is a local board's `/health`. Compare them as
`major.minor.patch` numbers. `taskctl.source` says where the CLI came from (`path`, `server`,
`shim`, `checkout`); a shim or checkout source with a local server tree is a stale-shim
candidate, not an upgrade by itself.

## The board URL ladder

1. `--url` — a pin; never probed or rewritten.
2. `TASKD_URL` in the process environment.
3. `TASKD_URL` in the effective env file (`--env-file` > `MEERKAT_TASKPANEL_ENV_FILE` >
   `<home>/.meerkat-taskpanel/.env` > the checkout `.env`).
4. The runtime pointer (`TASKD_RUNTIME_POINTER`, else the platform's machine-wide
   `runtime.json`).
5. `http://localhost:9527`.

`GET <url>/health` is the reachability test (1 s timeout). `status: "ok"` at the top
level or under `data` is healthy.

## Local vs remote

A URL is **loopback** when its hostname is `localhost`, `::1`, any `127.0.0.0/8`, or
`::ffff:127.x`. That is the same rule the CLI's transport uses. A dead loopback address
may fall through to a local start; a dead remote address is an error and must never fall
back to localhost. `/health` proves reachability, not authorization: a remote data
command also needs the token.

## taskctl

Candidates, in order: `--taskctl`, `PATH`, `<home>/.meerkat-taskpanel/bin/taskctl`, the
actor kind's shim (`<home>/<agent-dir>/bin/taskctl`), the checkout's
`src/cli/index.mjs` (run with `node`). The version probe parses
`{"ok":true,"data":{"version":"…","schema_version":…}}`.

## Skills and supervisor

- Board/chat/director/setup skills: `<home>/<agent-dir>/skills/<name>/SKILL.md`.
- Loop state: `<home>/<agent-dir>/meerkat-taskpanel/` (`sessions.state.json`, the queue and ledger).
  The loop itself runs as `taskctl run`, so there is no copied body to probe.
- Supervisor units: `<agent-dir>/scheduling/{launchd,systemd,cron}`.
- Live pool: `<agent-dir>/meerkat-taskpanel/sessions.state.json` (`poolPid` alive and a
  heartbeat fresher than five minutes).

## The per-kind config

`<program root>/.env.<actor-kind>`, reported as `kindConfig.path`. The program root is
resolved in order: `MEERKAT_TASKPANEL_CONFIG_DIR`, the installed tree
(`<home>/.meerkat-taskpanel`), a named checkout (`--checkout` / `MEERKAT_TASKPANEL_ROOT` /
`MEERKAT_TASKPANEL_REPO`), the shim's rendered `exec node "<root>/src/cli/index.mjs"`, then
cwd when it is a checkout. A legacy `<agent-dir>/meerkat-taskpanel.env` is **not** read;
re-run `install.sh` to migrate it.

## Fixed human name

Resolution: process `TASKCTL_HUMAN`, Claude `~/.claude/settings.json` `env.TASKCTL_HUMAN`,
the per-kind config `TASKCTL_HUMAN` / `MEERKAT_TASKPANEL_HUMAN_NAME`, the rendered shim's
`human="…"` line, the env file, then `USER`/`LOGNAME`. A fallback is reported as
`configured: false`; ask the user and set the explicit name.

## JSON

```json
{
  "version": 1,
  "home": "…",
  "actorKind": "claude",
  "projectDir": "…",
  "kindConfig": {"path": "…", "present": true, "programRoot": "…", "source": "env-config-dir|installed-tree|flag|env-root|env-repo|shim|cwd"},
  "checkout": {"found": true, "path": "…", "source": "flag|env-root|env-repo|cwd|config"},
  "taskctl": {"found": true, "path": "…", "source": "path|server|shim|checkout", "version": "…"},
  "server": {"url": "…", "urlSource": "flag|env|env-file|pointer|default", "loopback": true,
             "class": "loopback|remote", "probed": true, "reachable": true, "health": {}, "error": null},
  "human": {"configured": true, "name": "…", "source": "env|settings|config|shim|env-file|fallback"},
  "skills": {"board": {}, "director": {}, "chat": {}, "setup": {}},
  "skillsByKind": {"claude": {"board": true, "director": true, "chat": true, "setup": true}},
  "platforms": {
    "claude": {"kind": "claude", "dir": ".claude",
               "skills": {"board": true, "director": true, "chat": true, "setup": true, "names": ["…"]},
               "loopState": {}, "supervisor": {},
               "config": {"path": "…", "present": true, "kindOrder": ["claude"]},
               "roles": {}, "capabilities": ["design", "…"], "available": true}
  },
  "rolePlatforms": {"status": "split|single|no-platform",
                    "byPlatform": {"claude": ["Jobs", "Linus", "Reviewer"], "codex": ["Turing"]},
                    "singlePlatform": "claude", "singlePlatformAgents": ["Jobs", "Linus", "Turing", "Reviewer"],
                    "assignments": [{"roleId": "turing", "agent": "Turing", "platform": "codex", "tags": ["tests"]}]},
  "loopState": {"installed": true, "path": "…"},
  "supervisor": {"installed": true, "body": "…", "units": [], "running": false, "poolPid": null, "reason": "…"},
  "roles": {"source": "skills", "installedOn": {"claude": ["Jobs"]}, "list": [{"id": "jobs", "agent": "Jobs", "installedOn": ["claude"], "effective": "claude", "fallback": null}]},
  "legacy": [],
  "mattPocock": {"skill": {}, "tracker": {"path": null, "exists": false, "mentionsTaskpanel": false, "unrelated": false}},
  "missing": [],
  "actions": [],
  "warnings": []
}
```

`roles` is the discovery report: `source` is `skills` (or `null`), `installedOn` lists the
roles found per kind, and `list` carries each role's `id`, `agent`, `lanes`, `installedOn`,
`effective` and `fallback`. `legacy` names any retired `meerkat-loop` skill, roles tree or
old-shape `MEERKAT_TASKPANEL_ROLES_DIR` value — reported, never read or deleted. An explicit
`MEERKAT_TASKPANEL_ROLES_DIR` that names a directory of `role.json` directories is still
honored by the supervisor as a discovery override; only a tree without those markers is
retired. `--roles-dir <dir>` (the `MEERKAT_TASKPANEL_ROLES_DIR` form) points discovery at that
directory. `--no-network` leaves `server.probed` false and does not mark the server missing.
`--fail-on-missing` exits 1 when `missing` is non-empty.

**Fast-path signal:** `missing` empty, `actions` empty, and `human.configured` true mean the
machine is already set up. The project documents and the instruction entry are checked
read-only by the skill, not by detection; a missing or different document still runs its step.

## Platforms and the role split

`platforms` covers every loop kind (`claude`, `codex`, `pi`), not just `--actor-kind`; the
top-level fields stay the selected kind's for compatibility. Each entry reports what the
interview needs before it can ask **which platform runs which role**:

- `skills.names` — the installed skills under `<agent-dir>/skills/` that carry a `SKILL.md`
  (facts, not a score);
- `loopState` and `supervisor` — whether this kind can run the loop at all;
- `config.kindOrder` — this platform's kind preference from its own
  `<program root>/.env.<kind>`, so a proposal only names real diffs. There is no scan-set
  field: the claim set is the `roles` below;
- `roles` — the role skills this kind carries (`<agent-dir>/skills/<role>/role.json` with
  the `meerkat-role` marker), as agent names; installation location is the routing;
- `capabilities` — a static heuristic table (`PLATFORM_CAPABILITIES`), not detection;
- `available` — the director skill is present.

`roles` (top level) is the discovery report: every role with `installedOn`, `effective` and
`fallback`, plus `legacy` for a retired `meerkat-loop` skill, old-shape roles tree or
`MEERKAT_TASKPANEL_ROLES_DIR` value — reported, never read or deleted. A `MEERKAT_TASKPANEL_ROLES_DIR`
of `role.json` directories is not legacy; it is the explicit discovery override.

`rolePlatforms` is the capability proposal only. `status` is `single` (one platform for the
whole team), `split` (more than one), or `no-platform`; `singlePlatform` is always a valid
one-supervisor alternative. Nothing is enabled or written from detection.
