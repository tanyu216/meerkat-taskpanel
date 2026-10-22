# Install and repair

## Source selection

1. `--checkout` / `MEERKAT_TASKPANEL_ROOT` / `MEERKAT_TASKPANEL_REPO`.
2. The cwd, when it contains `src/cli/index.mjs` and `skills/`.
3. The published installer, if `npx meerkat-taskpanel` is available. Try it **once**.
4. A shallow clone: `git clone --depth 1 https://github.com/tanyu216/meerkat-taskpanel.git
   ~/.cache/meerkat-taskpanel/checkout`.

The npm package is not live yet (the unscoped registry name currently returns 404).
`npx` is the future path, not the default today; a clone is the non-checkout fallback.

## `--target`

`all` means **six actor kinds + the server**; an explicit comma list is literal;
`--no-server` removes the server. The server is dispatched first because the agent shims
and loop config name it.

| Intent | Invocation |
|---|---|
| local server + Claude | `bash install.sh --target claude,server` |
| Claude only, remote board | `bash install.sh --target claude --no-automation` |
| all actor kinds + server | `bash install.sh --target all` |
| server only | `bash install.sh --target server` |

`--no-automation` skips the machine-wide taskd guard (and Codex automation). It is the
remote-board path: do not load a local keepalive behind a remote URL.

## The server tree

`<home>/.meerkat-taskpanel/` holds `bin/taskctl`, `bin/taskd`, `.env`, `.data` and
`web/dist`. The agent shims and the loop config point at it. `install.sh` seeds the env
file with `TASKD_URL=http://localhost:9527` once and never overwrites it.

For a remote board, merge the URL (and token) into that env file **before** installing:

```bash
node scripts/configure-env.mjs --file <home>/.meerkat-taskpanel/.env \
  --key TASKD_URL --value https://board.example.internal:9527 --json
```

A token belongs in `TASKD_TOKEN` or `TASKD_TOKEN_FILE` (0600). Never echo it; use
`--value-file` when the shell's process list is a concern. `/health` proves reachability,
not authorization; a data command (`taskctl project list`) proves the token.

## Confirmation gates

- Show `--dry-run` output before writing.
- Ask before loading/enabling the supervisor (`--supervisor=enable`).
- Ask before `--force`; forcing the loop skill replaces its `roles/` directory, so re-run
  `/setup-meerkat` afterwards.
- A remote URL that the user did not name is never assumed.

## Human name

`install.sh` renders `MEERKAT_TASKPANEL_HUMAN_NAME` (else `USER`/`LOGNAME`) into the shim's
`TASKCTL_HUMAN`. Set it explicitly when the fallback is not the person's fixed name:

```bash
MEERKAT_TASKPANEL_HUMAN_NAME="Terry" bash install.sh --target claude,server
```

`--as-human` signs that name; it is never the loop's own voice.

## `setup-meerkat` itself

`install.sh --target claude` copies `skills/setup-meerkat/` to
`~/.claude/skills/setup-meerkat`. Other actor kinds keep the board/loop skills; the
repository bundle and marketplace still expose the setup skill, but the bash installer
does not copy it there. OpenClaw gets the board only.
