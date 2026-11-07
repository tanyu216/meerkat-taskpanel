# Eval prompts

Run each prompt with the skill and without it (baseline), using a throwaway HOME and
project, `TASKD_NO_AUTOSTART=1`, and `--no-network` where the board is not under test. The
machine-readable twin is `evals/evals.json`; this page is the human-readable index.

## 1. Remote board

> Set up meerkat for Claude on this repo. The board is at `http://board.internal:9527`.

Step 1 classifies the board as remote, installs only `taskctl` and the agent bundle with
`--no-automation`, and never starts a local taskd or writes its guard. Step 2 skips the
taskd-side keys. A `--dry-run` writes nothing, and no secret is printed.

## 2. Standard team

> Install meerkat here with the standard team.

The board, director and five role skills land for the detected kind; one supervisor is
recommended; step 4 points the project's agent-instruction entry at `/meerkat` and
`docs/agents/`. An agent-only install pins the installed tree and verifies where the config
and shim landed. A second run reports `unchanged` via the fast path.

## 3. Moving a role between platforms

> Turing should run on codex, not on Claude. Move it.

Step 5 reports Turing's `installedOn`, `effective` and `fallback`; the skill is copied into
the codex tree; the Claude copy is deleted only after an explicit yes; the scan set names the
roles that can be claimed; a retired `meerkat-loop` tree is reported and kept.

## 4. Existing tracker

> I already have `docs/agents/issue-tracker.md` for GitHub. Set up the Matt integration.

Step 4 detects an unrelated tracker and asks before overwriting; setup does not write the
tracker's agent-skills block; a tracker that mentions taskpanel is reported `unchanged` and
not asked about.

## 5. Config conflicts

> Check this machine's Meerkat configuration and fix the conflicts you find. The board is
> remote at `http://board.internal:9527`.

Step 2 runs the read-only audit, reports each conflict with its file and line, and repairs
only through the env writer. A loop key in the shared file is a hard error, a per-kind
duplicate is a silent last-wins, the token pair is an error, and no secret is printed. With
a remote board the taskd-side keys are skipped. No conflicts is reported as `unchanged`, not
asked about.

## 6. Setup interview

> Set up Meerkat TaskPanel for Claude on this repo. The board is remote at
> `http://board.internal:9527`, and I am not sure the five roles fit. Do not install or
> write anything — show me the setup interview you would run first.

Detection first, used as facts. Facts detection already establishes are reported, not asked.
Ask only a decision whose answer changes what happens; put the recommended option first and
describe what each option does and what changes as a result; ask in the user's language. The
routing question is adversarial: it asks for a counterexample card shape, a shape none
describes goes to Worker, and the reviewer is independent. A missing or different project
document is a real question, never the fast path. Safety confirmations (a daemon, `--force`,
destructive or remote actions) are always asked. No install, write or daemon before the
answers. `--yes` accepts only recommended non-destructive answers.

## 7. Role routing and fallback

> We will run Jobs and Linus on Claude, Turing on Codex, and Reviewer wherever it is
> available. Explain how the supervisor decides where each role runs, and what happens when
> Codex is not installed on this machine.

Installation location is the routing; the supervisor's primary kind wins; an unavailable
kind falls back only to a kind that carries the role; a role with no carrier is not claimed
and the gap is reported.

## 8. Decision round

> A Jobs card has four open decisions: the design register, the mobile breakpoint, a
> terminology conflict, and whether to expand scope to cover a second persona.

One question comment (Q1..Qn) with a recommendation each; the director answers what it can
in one note and one move; E3 and E1 escalate to `awaiting`; the worker writes no decision;
only a human comment resumes.

## 9. Reviewer catches an omission

> Review card T-2 (round 1) audits delivered card T-1 … the CLI flag appears in no
> acceptance item …

`VERDICT: REJECT`; the ledger names the uncovered requirement; the anchorless `met` is not
verifiable; the report verifies at the delivered commit and records the gate command and
exit code.

## 10. Card scope

> Set up meerkat here. Not everything should become a task card — we mostly want features,
> bugs and design work tracked; quick questions and one-off commands are just chat.

Step 4 asks the scope with a recommended default (the work a role owns), records the
narrower answer, and hands it to the init skill; the instruction entry the init skill writes
carries it. A second run reports `unchanged`.

## 11. The init skill writes the requirements

> Set up meerkat here and initialize this project's agent-instruction entry. Use a temporary
> HOME; do not touch the real one.

Step 4 writes `docs/agents/*.md`, declares the project map, then calls the `init` skill once
with the brief: `/meerkat` is the card entry, the board rules live in `docs/agents/`, every
file under `docs/agents/review-scenarios/` is named when the directory exists, and the card
scope is stated. The `init` skill writes the project's instruction entry; setup does not
edit it, and the file has no marker block. This leg is **blocked**, not passed, when the host
has no `init` skill.

## 12. Security toolchain belongs to Linus

> Set up meerkat in this repo. It has a GitHub Actions workflow that runs the tests, but
> nothing else — no dependency audit, no secret scan, no SAST.

Setup does not check, install or write security tooling. It names the Linus role skill as the
owner, points at the installed Linus material, and does not add a CI file.

## 13. Worktree guard is an optional Step 4 sub-step

> Set up meerkat here and adopt the worktree rules for this repo. I also want the guard so a
> session cannot edit the primary checkout.

Step 4 writes `create-card.md` and the tracker files, declares the project map, calls the
`init` skill for the entry, then writes `docs/agents/worktrees.md` and only after that offers
the worktree guard with its `--dry-run` report. Saving the marker and the guard for last
matters: once the marker exists and the guard is active, a primary-checkout write is denied,
including the entry write. If the guard arms mid-run, the remaining writes move to a session
worktree. Codex hooks are reported as still needing `/hooks` trust. Skipping the guard leaves
the rules as prose.

## 14. Project review scenarios are opt-in and setup-written

> Set up meerkat here. Our reviews repeat a few repo-specific checks: every API change must
> update `test/fixtures/contract/api.snapshot.json`, migrations are append-only, and the
> design oracle tests self-skip in the container so we check the host run.

Step 4 asks one gate: does the project have review checks that repeat on every card and are
not already in its standards? The recommended answer is no (skip). On yes, it asks which
scenario types need project-specific checks and writes
`docs/agents/review-scenarios/<type>.md` for each selected type the user supplied a check
for, with an `Applies to:` line, a `## Checks` list and a `## Blocks APPROVE` list. Empty and
generic files are not written; the reviewer's generic floor already ships with the skill.
Setup is the only writer of these files. The init brief names the directory and every file in
it, and the instruction entry the init skill writes lists each file by name. A second run
reports `written` / `unchanged` / `conflict` and never restates the file.
