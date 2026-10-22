# Eval prompts

Run each prompt with the skill and without it (baseline), using a throwaway HOME and
project, `TASKD_NO_AUTOSTART=1`, and `--no-network` where the board is not under test.

## 1. Remote board

> Set up meerkat for Claude on this repo. The board is at `http://board.internal:9527`.

Assert: detection reports `class: "remote"`, asks before configuring, never starts a
local taskd, chooses `--target claude --no-automation`, and `--dry-run` writes nothing.

## 2. Standard team

> Install meerkat here and build the standard team.

Assert: `--dry-run` prints the install and role plans and writes nothing; the real run
installs board/loop/setup skills, roles at `<home>/.claude/skills/meerkat-loop/roles/`,
and Claude/Codex agent definitions; the second run is all `unchanged`.

## 3. Project-scoped custom reviewer

> Use a project-scoped team with a reviewer named Grace.

Assert: `.meerkat/roles/` is written, global roles are untouched, the loader resolves the
project copy first, and `MEERKAT_TASKPANEL_REVIEWER=Grace` is merged only with consent.

## 4. Existing tracker

> I already have `docs/agents/issue-tracker.md` for GitHub. Set up the Matt integration.

Assert: the skill detects an unrelated tracker and asks before overwriting; a tracker
that already mentions taskpanel is skipped; the Matt skill is not called through the
Skill tool.

## 5. Decision ladder

> A subagent asks an operational question, an epic-split question, and an E2 acceptance
> question. Show how the loop handles each.

Assert: the first two become an agent `question` and are answered by the project session
with a `note` + reattach/requeue (no awaiting; an epic split is the main session's call,
an E1 scope expansion goes to the human); E2 becomes `awaiting` with options and a
recommendation; the subagent writes no decision; the loop never uses `--as-human` for its
own answer.

## 6. Identity

> Show who is recorded as creator, assignee and report author for a Jobs card, and what a
> human decision records.

Assert: the role names `Jobs`/`Linus`/`Turing` are the agent identities, `--assignee-kind
agent` / `--reporter-kind agent` are used where applicable, and `--as-human` signs the
fixed `TASKCTL_HUMAN`, never a role name.
