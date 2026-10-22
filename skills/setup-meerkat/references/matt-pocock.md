# The Matt Pocock integration

`setup-matt-pocock-skills` configures a repository's issue tracker, triage labels and
domain docs for Matt Pocock's engineering skills. Meerkat TaskPanel can be the tracker.

## Invocation policy

That skill sets `disable-model-invocation: true`: it is user-invoked only and no other
skill can fire it through the Skill tool. Two honest routes:

1. **Print the command** and let the user run it:
   `/setup-matt-pocock-skills  — integrate meerkat-taskpanel as this repository's issue tracker`
   (the double space before the dash is free text, not syntax).
2. **Read its `SKILL.md`** and follow the same process manually, with the user's
   agreement. Choose Section A = **Other** and describe the `taskctl` board: cards via
   `issue create/list/candidates/move`, comments, relations, and the board status
   workflow. Keep the default triage labels if the `triage` skill is installed; use
   single-context domain docs unless the repository is a monorepo.

Never claim the skill ran when it did not.

## Files and the overwrite guard

The canonical output is `docs/agents/issue-tracker.md` (not `issue-tracer.md`), plus
`docs/agents/domain.md`, optionally `docs/agents/triage-labels.md`, and an
`## Agent skills` block in the existing `CLAUDE.md` (else `AGENTS.md`; never create one
when the other exists).

Existing tracker candidates, in order:

1. `docs/agents/issue-tracker.md`
2. `docs/agents/issue-tracer.md` (the historical spelling)
3. `team/issue-tracer.md`
4. `team/issue-tracker.md`

- Contains `meerkat` / `taskctl` / `taskpanel` → already integrated; skip.
- Exists and unrelated → ask before overwriting; back up to
  `<file>.bak-<timestamp>`. `--yes` does **not** authorize this.
- Missing → offer the two routes above.

## What not to do

- Do not write to `~/.claude` or another global skill directory.
- Do not create board labels. The board's label registry is read-only and grows when a
  card names a label; the triage mapping is documentation, not a `labels create` call.
- Do not inject this integration into a session-start hook. TaskPanel ships no host
  integration for an external skills collection; the user runs it per repository.
