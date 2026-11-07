# Reviewer protocol — the nine mandatory steps

`SKILL.md` carries the stance, the scenario router and the verdict rule; this file is what you
do, step by step. Read it in full before Step 0. Board operations are the `meerkat` board skill's contract.

Every step is a floor, not a ceiling: use any read-only method, record every extra check and
skip, and let an extra finding block `APPROVE`. A type no scenario names is not exempt.

## 0. Establish an independent reviewer

**Purpose.** The verdict belongs to a reviewer whose context did not produce the delivery.
**Do.** Decide whether this session authored the delivery — the commit, plan, report or proof,
or a handoff that names this session. If it did, hand the review to one fresh-context,
read-only subagent (a fresh agent, not a fork, which inherits this context): give it the
`targetDir`, the delivered sha, the handoff and this skill's path, and relay its verdict,
security table and evidence verbatim under `independent: delegated`; re-judge nothing. The
child is one level deep and every board write stays here. With no subagent, ask the human how
to route an independent review and hold; a self-review approves nothing.
**Watch for.** A shared context; softening or re-judging the subagent's verdict.

## 1. Confirm the review still stands

**Purpose.** Decide whether a verdict is still meaningful for this round.
**Do.** The original is `in_review`; its `delivery_round` equals this card's `review_round`;
the round's `commit` anchor resolves; `targetDir` is the target card's worktree/branch. A
declared design stage or handoff path that is missing is a `REJECT`. A card inside a graph is
classified by its stage row in `docs/agents/epic-graphs.md`; one outside a graph by the frozen
acceptance and the report. A missing `plan.md` is not itself a `REJECT`: it falls back to the
description and the frozen acceptance. If the review is invalid, leave a `note` saying why and
stop; the live tree is not the delivery.
**Watch for.** A stale round; an anchor that no longer resolves after a rebase or force-push; a
tree moved past the sha.

## 2. Read the handoff and the sources

**Purpose.** Judge from the sources, not from the report's summary of them.
**Do.** Read the description, every comment, the frozen acceptance (the original's list plus
this review card's generic items), the brief and `plan.md`, this round's report and evidence,
prior findings, and the `## Handoff` block. The block sits in the original's description when a
design stage adopted it, and in this round's report when `meta.stage_handoff=required`; take its
paths from the block rather than the task id. A loop-created rework/fix child (`meta.rework_of`)
inherits its parent epic's handoff. Discover the project's own standards: `CLAUDE.md` /
`AGENTS.md`, `docs/tech-spec.md`, `docs/architecture.md`, `CONTRIBUTING.md`, ADRs, the glossary,
`design/contracts/`, `docs/agents/` (including `review-scenarios/`), `docs/ops/`.
**Watch for.** The report as the only source; a missing block, field or required design input
(a `REJECT`); a narrowed source set.

## 3. Build the requirement ledger

**Purpose.** Enumerate the requirements before judging any implementation.
**Do.** Build `R1..Rn` from the description, comments, brief, plan and handoff. Each row names
the acceptance item that covers it and the implementation that satisfies it (`path:line`, a test
name, or a visible behaviour). Run the omission check; when `meta.acceptance_derived=yes`,
re-derive. An uncovered row is a `REJECT`.
**Watch for.** A requirement with no acceptance item or no implementation — an omission; a
ledger copied from the report that narrows the acceptance — a `REJECT`; a row backed only by the
report's claim.

## 4. Verify at the delivered commit

**Purpose.** Judge the delivered tree, not whatever is in the working directory.
**Do.** Review only on the target card's worktree/branch (the handoff's `targetDir`). Read this
round's `commit` with `git -C <targetDir> show <sha>:<path>` and `git diff <sha>^ <sha>` (or
`git show <sha> -- <path>`); record the sha. Multiple reviewers run in parallel: the primary checkout, another card's worktree and a fixed scratch path stay untouched, the review checks
out nothing and switches no branch, and the shared tree stays read-only. Run a write-heavy
declared gate in the target worktree; if it needs a clean tree or an environment the target
worktree lacks, record the CI run for the sha instead. In shared mode, confirm the
current checkout is the target branch and keep it in place.
**Watch for.** A claim visible only in the working tree — unverified; a `path` anchor absent at
the sha — fabricated, a `REJECT`; a tree moved past the sha — state it.

## 5. Answer every snapshot item

**Purpose.** Make every acceptance claim falsifiable in the report.
**Do.** Every original acceptance item and every review-card generic item gets `met`,
`partial`, `not_met` or `not_applicable` (with a reason), one line of how it was checked, and an
`evidence[n]`. `met` needs falsifiable proof: a command that exits 0 now and fails when the
item breaks, or a `path` plus the check that resolves it. Evidence is the closed set
`commit`/`path`/`command`/`coverage`; a `command` anchor has `cmd` and an integer `exit_code`; a
`coverage` anchor's `lines` is 0–100. Record at least one `command` anchor (the `git show` you
verified with), even with no gate. Explain every `partial`/`not_met` in leftovers and name plan
deviations. Evidence carries provenance: a screenshot names the sha and environment; a benchmark
names environment, command and sample; a scan names tool, scope and sha; coverage names its
scope.
**Watch for.** Treating a `path`, `commit` or coverage number as proof; a `met` without an
`evidence[n]`; an unreproducible claim called `met`.

## 6. Re-answer the earlier rounds

**Purpose.** Carry every prior finding forward instead of letting it disappear.
**Do.** Every prior finding is resolved with evidence or explicitly deferred with a recorded
decision. A leftover lies only outside the frozen acceptance and names its owner and follow-up.
A decision/defect/change entry is resolved by a recorded decision, a linked follow-up card, or
the director's disposition. An omitted acceptance item is a `REJECT`.
**Watch for.** A prior finding answered by silence (a `REJECT`); a missing acceptance item
softened into a deferral; a leftover invented to avoid a `REJECT`.

## 7. Run the declared gate and the security audit

**Purpose.** Test the delivery with the project's own gate and its security surface.
**Do.** Run the project's declared review gate (`meta.review_gate`) at the delivered sha and
record the command, exit code and coverage — or `n/a — none declared` plus targeted checks. A
red gate is a `REJECT` (TS-34), not a note; attribute a failure against the baseline, which
changes ownership, not the verdict. Host-static checks are corroboration, not the declared gate.
When the lane has no way to run it, record the CI run for the sha; record only a run you observed.
**An environmental gap is a decision, not a defect.** When the gate is the push-time container
gate (TS-34), outside the lane's reach and with the branch unpushed — so no CI run exists —
record `n/a — gate unobservable in lane` and, if a frozen acceptance item demands it, raise an
E4 decision instead of a must-fix. A red gate you actually observed is still a `REJECT`. Run
the documented scans — dependency audit (`osv-scanner` by default), secret scan, SAST — and
record a read-only arm with its CI job and sha. Check waivers and the target ASVS level the
project records in its `docs/tech-spec.md` (default **L2** where none is recorded); a valid
recorded human waiver can accept risk, and an
expired or invalid waiver is a `REJECT`. Walk
every row of `references/security-checklist.md`; it is a floor, not a ceiling — add any surface
check the change calls for (threat model, authorization matrix, abuse cases, concurrency and
resources, supply chain, data protection). For a code-changing delivery the verdict carries the
row table: every Tier 1 row, each Tier 2 row the surface touches, Tier 3 at the target level
(default **L2** where the project records none), each with a disposition and an anchor. A blank
row, an unwalked tier or a missing table is a `REJECT`; a documentation-only delivery records
one `n/a — <reason>` per tier.
**Watch for.** Inventing a gate; describing a scan report you read as a run; a blank row;
assuming a worker self-check covered security — the manual rows are yours.

## 8. Apply the scenario floors and the project's own standards

**Purpose.** Start from the universal floor, then apply every matching refinement.
**Do.** Read every built-in scenario the card matches (the router is in `SKILL.md`) and every
matching project scenario under the target's `docs/agents/review-scenarios/`. List them at the
delivered sha (`git -C <targetDir> ls-tree --name-only <sha> docs/agents/review-scenarios/`) and
read each match; a delivery that adds or edits one is judged by the stricter of the base and
delivered text. A mixed card
reads every match; a type no scenario names follows the generic floor plus the project's own
standards. Record the classification and why no named floor matched. Apply the plan-quality
refinement below when a plan is part of the delivery or its evidence, then add any check the
surface and risk call for and record it.
**Watch for.** Stopping at the listed items; treating a scenario as the only reviewable type; a
PRD Must with no testable acceptance; a ledger that does not trace every Must; a test that
still passes with the change reverted; a stale rollup or a dropped epic child.

**Plan-quality refinement — any card whose deliverable or evidence includes a plan.** Judge the
plan on three axes: **logic** (goal → acceptance → step → proof; order, assumptions and failure
modes hold), **boundaries** (the blast radius: callers, contracts, migrations, config, data,
tests, docs, rollout/back-out and states), and **simplicity** (the smallest reliable option;
each dependency's failure mode and each abstraction's forcing function named). A gap is a
finding; a gap that leaves an acceptance item unprovable or a surface unhandled is **blocking**.

## 9. Write the verdict, run the self-check and deliver

**Purpose.** End in exactly one verdict on the review card.
**Do.** Apply the verdict rule in `SKILL.md`. Number the must-fix items: file/line,
reproduction, expected versus actual, missing case. Put blocking items first; the loop appends
at most ten items of 400 characters each to the original's acceptance. Keep the numbered items
inside the first 4,000 characters; the report accepts at most 64 acceptance items/anchors, a
16,384-character conclusion and 64 KiB. Record the sha, gate command and exit, uncovered ledger
rows and the findings re-checked. Put the verdict on the review card with the first line
`VERDICT: APPROVE` or `VERDICT: REJECT`; run `references/self-check.md` before delivering.
**Watch for.** Softening a red gate, security finding, missing acceptance item or invalid
handoff path into a note; an `APPROVE` with an open check; a self-review.
Beyond: write the strongest reason to `REJECT`, then show why it does not hold.
