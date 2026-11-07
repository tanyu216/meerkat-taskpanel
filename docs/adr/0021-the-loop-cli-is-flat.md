# 0021 — The loop CLI is flat, and each status is named for its subject

- **Status:** Accepted (2026-11-07)
- **Context:** `taskctl loop <verb>` was a namespace around ten unrelated verbs
  (`patrol`, `workflow`, `poll`, `tick`, `console`, `doctor`, `status`, `run`,
  `subscribe`, `session`) with no second caller. Beside it, `taskctl status` read
  the board client's runtime pointer, so one word covered two different subjects.
  The surfaces had also grown apart in spelling: the loop was `loop status` while
  the board was bare `status`, and the pool harness was `loop session`. The words
  `loop` and the Claude Code `/loop` skill overlap, which made an unqualified
  `loop tick` ambiguous in agent-facing prose.
- **Decision:** Flatten the namespace. The ten verbs become top-level commands,
  and `loop` stays as one top-level command that reports the loop's runtime
  verdict and takes `--take-over` / `--stop`. The board read is renamed from
  `status` to `board`; the pool daemon is renamed from `session` to `pool`. Two
  old spellings map straight to the new names — `loop status` → `loop`,
  `loop session` → `pool`; the other eight keep their verb and merely lose the
  prefix. Every retired spelling exits 2 with a migration error naming the new
  spelling and reminding the operator to re-run `install.sh` (the installed
  scheduling units carry the old argv). The internal dispatch keys stay
  `status` / `session` until the in-process operations layer replaces the 2A
  bridge.
- **Why:** Each top-level command names its subject — `board` reads the board,
  `loop` reads the loop — which is the same symmetry the loop's own output
  already printed (`board: running` / `supervisor: …`). A group with one caller
  is a namespace with no boundary; deleting it removes a level from every help
  page and flag declaration. `loop` is the one word in the glossary that covers
  supervisor, pool, subscriber and units together, which `supervisor` does not
  (it names one component and collides with the installer's
  `--supervisor=enable|status`). The hard cut with an explicit error is what
  makes the renames safe: an operator who upgrades without refreshing the units
  sees the new spelling, not an unexplained "unknown command".
- **Consequences:**
  - `taskctl --help` lists eleven top-level commands and no `loop` group.
  - The loop's shared flags are documented once in
    `skills/meerkat/references/cli.md` under `shared-flags:runtime`; `board` is
    outside that block because it declares none of the flags.
  - Installed systemd/launchd/cron units from before this change fail on their
    next start until `install.sh` is re-run. The migration error names the cause.
  - `taskctl status` is also retired, hinting `taskctl board`; the rename is not
    a silent alias.
  - The release scripts' historical `--group loop` is unaffected: it names a
    changelog section, not the CLI namespace.
- **Alternatives:**
  - **Keep the group and add aliases.** Rejected: two spellings of one command
    surface, and the brief asks for a hard cut.
  - **Rename `loop` to `supervisor`.** Rejected: it names one component and
    collides with the installer flag; the glossary word is `loop`.
  - **Keep `status` for both subjects.** Rejected: the two reads answer about
    different processes, and the pool harness had already outgrown the word.
