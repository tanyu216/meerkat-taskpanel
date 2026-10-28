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
runtime bytes); the project's `CLAUDE.md`/`AGENTS.md` carries the
`<!-- meerkat:task-entry -->` block exactly once, naming `/meerkat`, and a re-run leaves
those bytes unchanged.

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

Assert: the three items are one round (one question string per card, not one comment per
item); the operational and epic-split items are answered in a `note` (no decision kind),
and the card's single move is the E2 escalation to `awaiting` with options and a
recommendation; an epic split is the main session's call only while the deliverable is
unchanged, and an E1 scope expansion goes to the human; the subagent writes no decision;
the loop never uses `--as-human` for its own answer.

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
team question is adversarial and asks for a counterexample card; the interview states that
installation, writes and daemon starts wait until the frontier is empty and the answers are
confirmed; `--yes` accepts only recommended non-destructive answers.

## 8. Custom-team co-design

> Design a custom team for a product with heavy docs and mobile work. We have
> Jobs/Linus/Turing today, but docs changes and release notes keep falling through, and
> nobody is clearly testing the mobile app. Do not install anything; show the team design
> and the questions you would settle first.

Assert: an ownership matrix gives every card shape exactly one accountable role — a defined
role or an explicit outside-the-roles worker — and work outside the roles is not force-fit
into one; a double-owned shape is named as a finding; a concrete counterexample card is
requested; the reviewer stays independent and the
ladder is unchanged; the questions are one numbered round and installation waits for the
frontier to close.

## 9. Decision round

> A Jobs card has four open decisions: the design register, the mobile breakpoint, a
> terminology conflict, and whether to expand scope to cover a second persona. Show the
> decision round Jobs sends and how the loop handles each answer.

Assert: one agent `question` comment carries the frontier (Q1..Qn) with recommendations; a
dependent decision is deferred to the next round and a fact-closable item is closed by
lookup; every authorized item is settled in one `note` (or the lookup) and the card is moved
at most once; the E3 register and the E1 scope expansion go to the human in one `awaiting`
string; the subagent writes no decision kind and never enters awaiting; only a human comment
resumes, and an incomplete answer is not consent.

## 10. Reviewer catches an omission

> Review card T-2 (round 1) audits delivered card T-1, acceptance_mode agent, project gate
> `npm run verify:docker`. T-1's description asks for five things: a retry with backoff, a
> timeout, a metric, a CLI flag and a regression test. Its delivery report lists four
> acceptance items and marks them met; the fifth (the CLI flag) appears in no acceptance
> item, and one `met` note says only "implemented". Show the verdict the reviewer delivers
> and the report it writes.

Assert: the verdict's first line is exactly `VERDICT: REJECT`; the requirement ledger names
the uncovered CLI-flag requirement rather than answering one generic "requirements covered"
line; the anchorless `met` is refused as unverifiable (`not_met`), not accepted on the
strength of its note; the audit reads the delivered `commit` (`git show` / `git diff` at that
sha) rather than only the live working tree; the report records the declared gate with its
command and exit code, run by the reviewer; every must-fix item is numbered and carries
file/line, reproduction, expected versus actual and the missing case (the loop appends them
to T-1's acceptance); the reviewer moves neither card and never enters awaiting.

## 11. Card scope

> Set up meerkat here. Not everything should become a task card — we mostly want features,
> bugs and design work tracked; quick questions and one-off commands are just chat.

Assert: the card scope is one frontier question with a recommended default — the work a role
owns, read from the ownership matrix the team question settled (product design, development,
bug fixes, refactors, tests and review) — and work with no owner (questions, lookups, one-off
commands) is named as not becoming a card; the user's narrower answer replaces the default
`Task scope` paragraph inside the marked block in `CLAUDE.md`/`AGENTS.md`, so it is persisted
for later sessions; a second run reports the block unchanged instead of appending.
