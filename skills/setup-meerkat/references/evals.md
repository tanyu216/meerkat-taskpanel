# Eval prompts

Run each prompt with the skill and without it (baseline), using a throwaway HOME and
project, `TASKD_NO_AUTOSTART=1`, and `--no-network` where the board is not under test.

## 1. Remote board

> Set up meerkat for Claude on this repo. The board is at `http://board.internal:9527`.

Assert: detection reports `class: "remote"`, asks before configuring, never starts a
local taskd, chooses `--target claude --no-automation`, and `--dry-run` writes nothing.

## 2. Standard team

> Install meerkat here and build the standard team.

Assert: `--dry-run` prints the install plan and writes nothing; the real run installs the
board skill, `meerkat-chat`, `meerkat-director` and the five role skills (`jobs`, `linus`,
`turing`, `reviewer`, `worker`) for Claude, and the native agent definitions; the second run changes no
managed content (role skills and agent definitions are `unchanged`; the installer may re-copy
identical runtime bytes); the project's `CLAUDE.md`/`AGENTS.md` states the task entry once,
naming `/meerkat` and carrying the card scope, with no marker block, and a re-run leaves it
unchanged; the same file carries the compact team contract — each role's shapes, the
acceptance/landing owner, and the handoff markers with their writers — pointing at the
installed role skills for detail; and the same file points at the installed director's
decision policy and the `worker → director → human` ladder instead of copying it.

## 3. Moving a role between platforms

> Turing should run on codex, not on Claude. Move it.

Assert: detection reports Turing's `installedOn`, `effective` and `fallback` first; the skill
is copied into `<home>/.codex/skills/turing/`; the Claude copy is deleted only after an
explicit yes; a re-run reports `unchanged`; detection afterwards reports codex as effective;
a retired `meerkat-loop` tree is reported as legacy and not deleted.

## 4. Existing tracker

> I already have `docs/agents/issue-tracker.md` for GitHub. Set up the Matt integration.

Assert: the skill detects an unrelated tracker and asks before overwriting; a tracker
that already mentions taskpanel is skipped; the Matt skill is not invoked by this skill.

## 5. Decision ladder

> A subagent asks an operational question, an epic-split question, and an E2 acceptance
> question. Show how the supervisor and director handle each.

Assert: the three items are one round (one question string per card, not one comment per
item); the operational and epic-split items are answered by the director in a `note` (no
decision kind), and the card's single move is the E2 escalation to `awaiting` with options
and a recommendation; an epic split is the director's call only while the deliverable is
unchanged, and an E1 scope expansion goes to the human; the worker writes no decision; the
director never uses `--as-human` for its own answer.

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

## 8. Role routing and fallback

> We will run Jobs and Linus on Claude, Turing on Codex, and Reviewer wherever it is
> available. Explain how the supervisor decides where each role runs, and what happens when
> Codex is not installed on this machine.

Assert: the effective platform comes from the role's `installedOn` and the supervisor's
primary kind, not from a config mapping key; a role installed on several kinds reports its
fallback instead of being silently reassigned; an unavailable Codex makes Turing fall back to
another kind that also carries its skill, and the fallback is reported once in status/doctor;
when no carrying kind is available the card is not claimed and the gap is reported — the
handoff is never pointed at a skill that is not installed; the director is found by scanning
the installed kinds (primary first) and is not routed by role discovery.

## 9. Decision round

> A Jobs card has four open decisions: the design register, the mobile breakpoint, a
> terminology conflict, and whether to expand scope to cover a second persona. Show the
> decision round Jobs sends and how the director handles each answer.

Assert: one agent `question` comment carries the frontier (Q1..Qn) with recommendations; a
dependent decision is deferred to the next round and a fact-closable item is closed by
lookup; every authorized item is settled in one `note` (or the lookup) and the card is moved
at most once; the E3 register and the E1 scope expansion go to the human in one `awaiting`
string; the worker writes no decision kind and never enters awaiting; the director does the
work only of deciding; only a human comment resumes, and an incomplete answer is not consent.

## 10. Reviewer catches an omission

> Review card T-2 (round 1) audits delivered card T-1, acceptance_mode auto, project gate
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
owns, read from the role skills' shapes (product design, development, bug fixes, refactors,
tests and review) — and work with no owner (questions, lookups, one-off
commands) is named as not becoming a card; the user's narrower answer replaces the default
scope statement in the instruction file the init step updated, so it is persisted for later
sessions; a second run reports the entry unchanged instead of restating it.

## 12. Security toolchain belongs to Linus

> Set up meerkat in this repo. It has a GitHub Actions workflow that runs the tests, but
> nothing else — no dependency audit, no secret scan, no SAST.

Assert: setup does not run a security check, install a scanner or write a CI security file;
it names the Linus role skill as the owner of both the decision and the mechanism
(`skills/linus/references/security-tools.md`, `skills/linus/scripts/security-tools.mjs`); it
does not ask the user to approve security arms during setup; a missing Linus on every
available kind is reported as the reason the toolchain cannot be initialized; any state it
mentions is a detection fact, not something it started.
