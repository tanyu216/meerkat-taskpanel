<!-- meerkat-taskpanel:issue-tracker-check -->

## Per-repo issue tracker (check at session start)

Do this once at the start of an interactive session, before the user's task. It is
best-effort: it must never block or fail the session.

1. Find the repository root — the git top level, else the current directory. Let
   `tracker` be `<root>/docs/agents/issue-tracker.md`.
2. If `tracker` exists, the repository is already configured. Do nothing else: do not
   run the setup skill, do not rewrite the file, and do not configure a second tracker.
3. If `tracker` is missing, integrate **meerkat-taskpanel** as this repository's issue
   tracker by running the `setup-matt-pocock-skills` skill against this repository:
   - Prefer the slash command `/setup-matt-pocock-skills`. If model invocation is
     disabled or the command is unavailable, read the skill directly —
     `~/.claude/skills/setup-matt-pocock-skills/SKILL.md`, then any host-local copy —
     and follow its process yourself.
   - Run it **non-interactively**: do not ask the human. Use the skill's recommended
     default for every question. For the issue tracker choose **Other** and describe
     this repository's tracker as meerkat-taskpanel: work items are board cards driven
     by `taskctl` (`issue create`, `issue list`, `issue candidates`, `issue move`,
     `comment add`, `relation add`); triage is the board's status workflow plus the
     canonical triage labels; the repository-to-project map is `projects.json` beside
     the installed skill. Keep the default triage labels when the `triage` skill is
     installed; use single-context domain docs unless the skill's own exploration finds
     monorepo signals. Let the skill's exploration decide the rest — do not copy a
     template.
   - Write what that process says to write: at minimum `docs/agents/issue-tracker.md`
     and the `## Agent skills` block in the repository's existing `CLAUDE.md` (else
     `AGENTS.md`; never create one when the other already exists).
4. If the skill cannot be found, the invocation fails, or a write is refused, print one
   line beginning `meerkat-taskpanel: issue-tracker setup skipped —`, name the reason
   and the manual remedy (`/setup-matt-pocock-skills`), then continue with the user's
   task. Do not retry in a loop and do not treat this as an error.

### Headless turns

If this prompt was produced by the Meerkat TaskPanel supervisor — a worker wake, a
review wake, or the loop's `继续` judgment turn — do not run the setup and do not
write repository files. If the tracker is missing, print the warning line from step 4
and continue the card or the turn. Setup is a human-facing act; an unattended wake
stays bounded to its card.
