# Install and repair

## Source selection

1. `--checkout` / `MEERKAT_TASKPANEL_ROOT` / `MEERKAT_TASKPANEL_REPO`.
2. The cwd, when it contains `src/cli/index.mjs` and `skills/`.
3. The published installer, if `npx meerkat-taskpanel` is available. Try it **once**.
4. A shallow clone: `git clone --depth 1 https://github.com/tanyu216/meerkat-taskpanel.git
   ~/.cache/meerkat-taskpanel/checkout`.

The npm package is not live yet (the unscoped registry name currently returns 404).
`npx` is the future path, not the default today; a clone is the non-checkout fallback.

## Always install non-interactively

An agent must pass explicit flags (as below) or `--non-interactive`. Never use
`--interactive`/`-i`, and never invoke `install.sh` with no arguments from a terminal: with
no options on a TTY it opens a wizard and blocks waiting for a human. Piped input,
`--dry-run` and `--non-interactive` never prompt, so the non-interactive form is the
agent's default everywhere.

## `--target`

`all` means **the four agent kinds + the server**; an explicit comma list is literal;
`--no-server` removes the server. The server is dispatched first because the agent shims
and per-kind config name it. The first `claude|codex|pi` in the list is the **primary
kind**: it receives the director, the chat console, `setup-meerkat` and a fresh install's
role skills.

| Intent | Invocation |
|---|---|
| local server + this kind | `bash <checkout>/install.sh --target <kind>,server` |
| this kind only, remote board | `bash <checkout>/install.sh --target <kind> --no-automation` |
| all actor kinds + server | `bash <checkout>/install.sh --target all` |
| server only | `bash <checkout>/install.sh --target server` |

`<kind>` is the platform this skill runs on (claude, codex or pi), not a fixed value.

`<checkout>` is the detected source tree (or the cloned cache), not the user's project.

`--no-automation` skips the machine-wide taskd guard (and the Codex scheduling units). It is the
remote-board path: do not load a local keepalive behind a remote URL.

## The server tree

`<home>/.meerkat-taskpanel/` holds `bin/taskctl`, `bin/taskd`, `.env`, `.data` and
`web/dist`. The agent shims and the per-kind config point at it. `install.sh` seeds the env
file with `TASKD_URL=http://localhost:9527` once and never overwrites it.

An **agent-only** install (`--target claude`, no server) has no such tree: its install-root
`.env` is the checkout's (or npm package's) `.env`, and the dry run names that path. Read
the dry run before writing if the checkout must stay untouched; `MEERKAT_TASKPANEL_ENV_FILE`
selects another file for the CLI and the installer's env write.

For a remote board, merge the URL (and token) into that env file **before** installing:

```bash
node <skill-dir>/scripts/configure-env.mjs --file <home>/.meerkat-taskpanel/.env \
  --key TASKD_URL --value https://board.example.internal:9527 --json
```

A token belongs in `TASKD_TOKEN` or `TASKD_TOKEN_FILE` (0600). Never echo it; use
`--value-file` when the shell's process list is a concern. `/health` proves reachability,
not authorization; a data command (`taskctl project list`) proves the token.

## Confirmation gates

These gates are asked inside the setup interview's frontier (`SKILL.md` §The setup
interview); `--yes` accepts the recommended non-destructive answers and never authorizes a
gate on its own.

- Show `--dry-run` output before writing.
- Ask before loading/enabling the supervisor (`--supervisor=enable`).
- Ask before moving a role skill from one kind's skills tree to another; removing the
  source copy is a separate, explicit yes, and a role the user did not name is never
  touched. One kind for all roles is the recommended default.
- Ask before `--force`; it replaces the skill's own files. A retired `meerkat-loop` tree is
  reported as legacy and kept. The project map is not in the skill directory any more: an old
  skill-beside `projects.json` is migrated to the config root, never replaced.
- A remote URL that the user did not name is never assumed.

## Human name

`install.sh` renders `MEERKAT_TASKPANEL_HUMAN_NAME` (else `USER`/`LOGNAME`) into the shim's
`TASKCTL_HUMAN`. Set it explicitly when the fallback is not the person's fixed name:

```bash
MEERKAT_TASKPANEL_HUMAN_NAME="Terry" bash install.sh --target claude,server
```

`--as-human` signs that name; it is never the supervisor's or a role's own voice.

## The security toolchain — Linus owns it

The security toolchain is the Linus role skill's system-initialization duty. This skill does
not check, install, upgrade or write CI security files. When a machine must be
pre-provisioned, that work runs from the Linus skill:

```bash
node <linus-skill-dir>/scripts/security-tools.mjs --check --json --project <dir>
```

`--print`, `--install`, `--upgrade`, `--ci-plan` and `--ci-write` behave as Linus's
`references/security-tools.md` documents; the recorded floors are
`skills/linus/assets/security/toolchain.json`. Point the user at Linus rather than running
it here.

## `setup-meerkat` itself

`install.sh` copies `skills/setup-meerkat/` to the **primary kind's** skill directory (for
example `~/.codex/skills/setup-meerkat` when codex is primary). Other actor kinds keep the
board skill only; the repository bundle and marketplace still expose the setup skill, but
the bash installer does not copy it there. OpenClaw gets the board only.
