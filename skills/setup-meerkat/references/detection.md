# Detection

`scripts/detect.mjs` is read-only. It never writes, never starts a board, and runs
`taskctl` only with `--version` (`--help`/`--version` are answered before identity and
board resolution). All other probes use `TASKD_NO_AUTOSTART=1`.

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

- Board/loop/setup skills: `<home>/<agent-dir>/skills/<name>/SKILL.md`.
- Loop body: `<home>/<agent-dir>/meerkat-taskpanel/scripts/supervisor.mjs`.
- Supervisor units: `<agent-dir>/scheduling/{launchd,systemd,cron}`.
- Live pool: `<agent-dir>/meerkat-taskpanel/sessions.state.json` (`poolPid` alive and a
  heartbeat fresher than five minutes).

## Pi subagents

Pi has no native subagent mechanism, and the loop's project session spawns one subagent per
card. The check looks for `~/.pi/agent/extensions/subagent` (and the `pi-subagents` alias)
and reports:

- `installed` — the directory exists;
- `extensionDir` — the directory found, or the expected path;
- `recommended` — `pi install npm:pi-subagents` when missing, else `null`.

For an `--actor-kind pi` run, a missing extension is added to `missing`, an
`install-pi-subagents` action is emitted, and a warning names the install command. Other
actor kinds report the field but are not blocked by it.

## Fixed human name

Resolution: process `TASKCTL_HUMAN`, Claude `~/.claude/settings.json` `env.TASKCTL_HUMAN`,
the actor-kind config `TASKCTL_HUMAN` / `MEERKAT_TASKPANEL_HUMAN_NAME`, the rendered shim's
`human="…"` line, the env file, then `USER`/`LOGNAME`. A fallback is reported as
`configured: false`; ask the user and set the explicit name.

## JSON

```json
{
  "version": 1,
  "home": "…",
  "actorKind": "claude",
  "projectDir": "…",
  "checkout": {"found": true, "path": "…", "source": "flag|env-root|env-repo|cwd|config"},
  "taskctl": {"found": true, "path": "…", "source": "path|server|shim|checkout", "version": "…"},
  "server": {"url": "…", "urlSource": "flag|env|env-file|pointer|default", "loopback": true,
             "class": "loopback|remote", "probed": true, "reachable": true, "health": {}, "error": null},
  "human": {"configured": true, "name": "…", "source": "env|settings|config|shim|env-file|fallback"},
  "skills": {"board": {}, "loop": {}, "setup": {}},
  "skillsByKind": {"claude": {"board": true, "loop": true, "setup": true}},
  "loopBody": {"installed": true, "path": "…"},
  "supervisor": {"installed": true, "body": "…", "units": [], "running": false, "poolPid": null, "reason": "…"},
  "roles": {"global": {}, "project": {}, "state": {}, "explicit": {}, "effective": {}},
  "mattPocock": {"skill": {}, "tracker": {"path": null, "exists": false, "mentionsTaskpanel": false, "unrelated": false}},
  "piSubagents": {"installed": false, "extensionDir": "…/.pi/agent/extensions/subagent", "recommended": "pi install npm:pi-subagents"},
  "missing": [],
  "actions": [],
  "warnings": []
}
```

`roles.effective` is the root the loop will actually load (`source` =
`explicit|project|loop-skill|state`, plus the manifest and role count), or `null` when
there is none. `--no-network` leaves `server.probed` false and does not mark the server
missing. `--fail-on-missing` exits 1 when `missing` is non-empty.
