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
and Claude/Codex agent definitions; the second run changes no managed content (role
files and agent definitions are `unchanged`; the installer may re-copy identical
runtime bytes).

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

## 7. Setup interview

> Set up Meerkat TaskPanel for Claude on this repo. The board is remote at
> `http://board.internal:9527`, I want a project-scoped team, and I am not sure the standard
> team fits. Do not install or write anything — show me the setup interview you would run
> first.

Assert: detection runs first and its facts are used rather than re-asked; the open decisions
are one numbered round (Q1..Qn) with a recommendation each, worded so "yes" accepts it; the
team question is adversarial and asks for a counterexample card; nothing is installed,
written or started before the frontier is empty; `--yes` accepts only recommended
non-destructive answers.

## 8. Custom-team co-design

> Design a custom team for a product with heavy docs and mobile work. We have
> Jobs/Linus/Turing today, but docs changes and release notes keep falling through, and
> nobody is clearly testing the mobile app. Do not install anything; show the team design
> and the questions you would settle first.

Assert: an ownership matrix gives every card shape exactly one accountable role; the
docs/release-notes and mobile-testing gaps are named as unowned or double-owned findings; a
concrete counterexample card is requested; the reviewer stays independent and the ladder is
unchanged; the questions are one numbered round and nothing is installed.

## 9. Decision round

> A Jobs card has four open decisions: the design register, the mobile breakpoint, a
> terminology conflict, and whether to expand scope to cover a second persona. Show the
> decision round Jobs sends and how the loop handles each answer.

Assert: one agent `question` comment carries Q1..Q4 with recommendations; the project session
answers the operational items in one `note` and moves the card once; the E3 register and the
E1 scope expansion go to the human in one `awaiting` string; the subagent writes no decision
kind and never enters awaiting; only a human comment resumes, and an incomplete answer is not
consent.
