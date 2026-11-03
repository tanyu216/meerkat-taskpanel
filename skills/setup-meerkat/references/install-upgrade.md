# Install and upgrade

Step 1. Detection has already answered what is installed; this step decides the source,
the target set and whether an upgrade is warranted.

Report the detected versions, locations, board class and human name as facts. Ask only when
the answer changes what happens: a source is ambiguous or missing, the install would widen
beyond the kinds detection already shows, the source is newer, the board is unreachable, or
the human name is a fallback. Equal versions are `unchanged`, not a question.

## Source selection

Pick the first source that works, in this order:

1. `--checkout` / `MEERKAT_TASKPANEL_ROOT` / `MEERKAT_TASKPANEL_REPO`.
2. The cwd, when it contains `src/cli/index.mjs` and `skills/`.
3. The published installer, via `npx meerkat-taskpanel`. Try it **once**.
4. A shallow clone of `https://github.com/tanyu216/meerkat-taskpanel.git` into
   `~/.cache/meerkat-taskpanel/checkout`.

Prefer the published installer when it resolves; a shallow clone is the offline fallback.
When every source fails, stop and report — never guess a path or half-install. When exactly
one source is usable, report it and move on; ask only when two or more are viable or none is.

## Version comparison

Read `taskctl.version`, `server.health.version` (local board only) and
`checkout.version`. Compare `major.minor.patch` numerically; `0.10.0` is newer than `0.9.9`.
The source is the target:

- source **newer** → ask once whether to upgrade: it replaces the skill bundle and the CLI
  shim, and a running daemon is restarted only if the user also approves that separate
  question;
- source **equal** → report `unchanged`; nothing is written and nothing is asked;
- source **older** → report the mismatch and stop; never downgrade silently;
- version **unknown** (no `package.json`, offline registry) → report `unknown` and let the
  user decide.

When the source is a published package, one `npm view meerkat-taskpanel version` is allowed;
an offline failure is `unknown`, not an error to loop on.

A `taskctl.source` of `shim` or `checkout` while a local server tree exists can hide a stale
shim. Report the two versions, prefer `<home>/.meerkat-taskpanel/bin/taskctl`, and suggest a
re-run of the installer to refresh the shim.

## Local or remote board

`server.class` is `remote` when `TASKD_URL` names a non-loopback host. `/health` proves
reachability, not authorization.

- **Local, reachable**: report it as a fact and do not restart what is healthy. Upgrade only
  when the source is newer.
- **Local, unreachable**: ask once whether to start the local board. The recommended answer
  installs `--target <kind>,server` and the taskd guard keeps the board alive; this starts a
  background service, so it is a separate safety confirmation.
- **Remote, reachable**: report the URL and use `--target <kind> --no-automation` (no local
  server, no guard). Never fall back to localhost. Verify the token with one read-only data
  command; a 401/403 asks for `TASKD_TOKEN` or `TASKD_TOKEN_FILE` (mode 0600, never echoed).
- **Remote, unreachable**: report the failure, ask for a corrected URL, stop.
- **No URL/pointer**: report `source: "default"` and confirm `http://localhost:9527` before
  installing.

`--no-automation` is the remote-board path. It skips the machine-wide taskd guard and the
Codex scheduling units. It is not "no supervisor": the agent kind's own loop scheduling
units may still be planned, and they are what claims cards against the remote board. If the
user does not want a supervisor at all, use `--supervisor=disable` and say so.

## The installer

Show the plan first, then run the same command without `--dry-run`:

```bash
# local board
bash <checkout>/install.sh --target <kind>,server --agent-name <name> --dry-run
# remote board
bash <checkout>/install.sh --target <kind> --no-automation --dry-run
```

Always drive the installer with explicit flags (or `--non-interactive`); never `-i`, and
never a bare `install.sh`: with no `--target` it installs every kind **and the server**, can
write a taskd guard, and can start a daemon. Never run `install.sh --supervisor=enable`
without a separate explicit yes.

An agent-only run (`--target <kind>`, no `server`) started from the source checkout writes
`.env.<kind>` and the project map into that checkout and points the shim and units at it.
When the machine already has an installed tree, pin the install to it:

```bash
MEERKAT_TASKPANEL_REPO=<home>/.meerkat-taskpanel \
MEERKAT_TASKPANEL_CONFIG_DIR=<home>/.meerkat-taskpanel \
MEERKAT_TASKPANEL_ENV_FILE=<home>/.meerkat-taskpanel/.env \
bash <checkout>/install.sh --target <kind> --agent-name <name> --dry-run
```

After the run, verify `kindConfig.programRoot`, `kindConfig.path`, `.env.<kind>` and the
shim's `exec node` line all name the installed tree, not the checkout.

The first `claude|codex|pi` in `--target` is the primary kind and receives the team skills;
an upgrade refreshes a role on the kind that already carries it. The default target set is
the kind this skill runs on plus every kind where detection found the `meerkat` skill; ask
before widening it. A remote-board target set never includes `server`.

Switches that need care, in plain language:

- `--target <kind>` copies the skills to that agent kind; add `server` to install the local
  runtime tree as well.
- `--no-automation` skips the machine-wide taskd guard and the Codex scheduling units; the
  agent kind's own loop units may still be planned.
- `--supervisor=enable` starts the supervisor daemon and is always a separate safety
  question; `disable` unloads it.
- `--force` replaces the skill's own differing files; show the diff first and ask.
- `--link` links only the board skill; team and role skills are always copied.
- `--prefix <home>` installs under another home — the sandbox form; never the operator's
  real home unless the user asks.
- `--skip-web-build` is for a checkout with no `web/node_modules` or built `web/dist`; say
  the result is API-only rather than hiding the missing board UI.

## Names and secrets

Pass the human name as `MEERKAT_TASKPANEL_HUMAN_NAME=<name>`; the installer renders it into
`TASKCTL_HUMAN`. If detection reports a fallback (`USER`/`LOGNAME`), ask for the fixed name
and set it explicitly. `--agent-name` is the loop's writer identity (default `Worker`), not
the human.

A token goes in `TASKD_TOKEN` or `TASKD_TOKEN_FILE` (exactly one, mode 0600). Never print
it; use the value-file form when the shell's process list is a concern.

## What the installer places

`install.sh` copies `setup-meerkat`, `meerkat-director` and `meerkat-chat` to the **primary
kind**, and the board skill to every selected kind. Role skills go to the kinds that already
carry them (a fresh role defaults to the primary kind). OpenClaw gets the board skill only;
it has no loop and no director. The runtime finds the director wherever it is installed, so
its location is never a config value.

The security toolchain is not this step's: it ships with the **Linus role skill**. Point at
`<linus-skill-dir>/scripts/security-tools.mjs --check` and let Linus decide during system
initialization.
