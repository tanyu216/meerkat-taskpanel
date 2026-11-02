# Team roles: who owns what

This page is the maintainer's **ownership matrix** for the agent team: one accountable role
per work shape, one decision-maker per question, one writer per act. The role skills remain
the authority for each role's workflow; this page only says which role owns a shape, what it
hands on, who reviews it, and which decisions are not its own.

"Role" here means a **team role** — Jobs, Linus, Turing, Reviewer, Worker. It is not an issue
triage label ([`triage-labels.md`](triage-labels.md)) and not the board's derived `role`
(`task` / `epic` / `review`).

## The four layers

| Layer | What it is | What it does not do |
|---|---|---|
| **Human** | E1–E5, `human`-mode acceptance, the final acceptance right on an `agent` card, release/deploy decisions, the project map and configuration, E5 ADRs | claim or implement a card directly |
| **Director** (`meerkat-director`) | the only content-decision lane: answer a worker question, route an unowned card, consume an accepted card's required handoff, escalate E1–E5; create downstream and fix cards | claim, implement, or move a card to `done`; record a human decision as its own |
| **Supervisor** (`src/orchestrator/`) | the deterministic passes: patrol → workflow → poll; claim and dispatch, create the review card, apply the verdict, accept, land, clean up, bound retries | make a content decision or write a verdict |
| **Roles** | Jobs (product), Linus (engineering), Turing (verification), Reviewer (independent verdict), Worker (everything else) | decide E1–E5, split/route a card, create downstream cards, merge/push, accept their own work |

The director is not a role: it receives no card, has no assignee, and never appears in the
claim scan. The supervisor is not an agent: it speaks only `taskctl` and starts agent sessions;
it never calls the HTTP API.

## Ownership matrix

| Work shape | Accountable role | Input | Output / handoff | Decision rights | Reviewed by | Next actor |
|---|---|---|---|---|---|---|
| product brief, PRD, prototype, UI/UX | Jobs | card, human input, `design/glossary.md` | `design/specs/`, `design/prds/`, `design/prototype/`, `## Handoff`, `stage_handoff=required` | E3 → human; operational → director | Reviewer | director triage creates the implementation/verification cards |
| architecture, foundation, tech stack, security toolchain | Linus | card, Jobs handoff, existing `docs/tech-spec.md` | `docs/tech-spec.md`, `docs/architecture.md`, ADRs, baseline, `## Handoff`, `project.meta.review_gate` | E5/E4 posture → human; operational → director | Reviewer | director triage creates the implementation/test cards |
| implementation, feature, bug | Linus | card, handoff, `docs/tech-spec.md`, frozen acceptance | code + tests + report + commit; a small change or bug uses `product_change=none`; a follow-up owed (regression, cleanup) sets `stage_handoff=required` and names it | E1/E2/E4/E5 → human; operational → director | Reviewer | supervisor accepts/lands; director triage creates the follow-up |
| refactor | Linus | card, behaviour baseline | behaviour-preserving diff + evidence | as implementation | Reviewer | supervisor |
| test design, test authoring | Turing | card, handoff, delivered implementation | `test-plan.md`, tests, traceability, scan evidence | E2/scope → human; operational → director | Reviewer | supervisor |
| regression, post-fix verification, production bug | Turing | fix card/report/commit, reproduction | before/after evidence, blast radius | as test design | Reviewer | supervisor; director triage handles a follow-up fix |
| performance | Turing | card/acceptance/director request + threshold | `performance.md`, measurement against the threshold | threshold/scope → human; request → director | Reviewer | supervisor |
| independent review | Reviewer | review card, original report/commit/handoff | exactly one `VERDICT: APPROVE` or `VERDICT: REJECT` on the review card | none; insufficient evidence is a REJECT | supervisor applies it | supervisor / human |
| operations, release, deploy, external account, manual task | Worker | card, runbook, human authorization | evidence + report | release/deploy decision → human; operational → director | Reviewer (docs/operations floor) | supervisor; human confirms a release |
| epic / split | Director (no worker) | parent, handoff, proposed children | linked children, rollup | deliverable split → director; scope expansion → E1 | Reviewer audits the rollup | board rollup + supervisor |
| downstream / fix card creation | Director | accepted producer + handoff; or a defect question | child/epic cards, seeded acceptance, links, `handoff_consumed_round` / `handoff_declined_round` | as above | Reviewer on the new card | supervisor dispatch |
| question / route / escalation | Director | a decision request | decision + release; assignee; `awaiting` | E1–E5 → human | — | worker resumes / supervisor claims |
| acceptance | `agent` → supervisor; `human` → human; `off` → deliverer or supervisor | report + verdict | `done` | the card's `acceptance_mode` | — | — |
| landing / cleanup | Supervisor | approved lane | merge, worktree cleanup, `landed_sha` | — | — | — |

## Authority map

| Act | Owner |
|---|---|
| create an ordinary card | the creator, with the accountable role as the assignee |
| create a downstream or fix card | the director (its triage/question decision) |
| assign a role | the creator; the director only for an unowned card |
| claim / heartbeat / deliver | the card's worker session; a supervisor-dispatched worker heartbeats and never re-claims |
| move a card to `done` | the card's `acceptance_mode`: the supervisor after a current-round `APPROVE` (`agent`), a person (`human`), the deliverer/supervisor (`off`) |
| create/close a review card, apply a verdict, rework, create an epic fix child, land | the supervisor |
| move a card to `awaiting` | the director, for an E1–E5 matter; only a human-authored comment resumes it |
| reopen a terminal card | a human, audited; not a role, and not the director as a substitute for triage |
| choose/register the project directory | a human (`projects.json`); the director may choose among registered directories |
| E1–E5 | a human |
| record a human's words | `meerkat-chat`; the director never signs as the human |

The reviewer never moves either card. The producer never accepts its own work. The
supervisor's `system` writes carry no acceptance right beyond the evidence.

## Marker inventory

| Key | Writer | Reader |
|---|---|---|
| `stage_handoff=required` | a producer role (Jobs, Linus architecture, or any card that owes a follow-up) | supervisor triage, reviewer |
| `design_stage` | director triage (on the child card), or the creator | Linus, Turing, Reviewer |
| `product_change=none` | the creator or director, for a small change or bug with no design input | Linus, Turing, Reviewer |
| `project.meta.review_gate` | Linus when the foundation records the gate | board workflow, reviewer |
| `handoff_consumed_round` / `handoff_declined_round` | director triage | supervisor triage settle, `loop doctor` |
| `accepted_by`, `accepted_round`, `review_verdict`, `review_verdict_round`, `rework_round`, `review_retry`, `loop_hold_*` | supervisor | board, supervisor, `loop doctor` |
| `fixes`, `origin`, `parent` | director (fix card) | SLA `defect_card_creation` |
| `acceptance_derived=yes` | a worker when the handoff or director pre-authorized the derivation | reviewer, delivery gate |

## Lifecycle seams

1. **Create** → the creator names one accountable role from its `shapes`; a shape no role
   describes goes to Worker; an unowned card is the director's route.
2. **Claim/dispatch** → the supervisor claims atomically and hands the card to its role
   session.
3. **Question** → the worker asks and waits; the director decides and releases, or escalates
   E1–E5 to `awaiting`.
4. **Deliver** → `in_review` with a current-round report; the supervisor creates and claims the
   review card.
5. **Verdict** → the reviewer writes the verdict on the review card; the supervisor applies it
   and closes the review card last.
6. **Accept** → the mode names the closer; landing runs before `done`; cleanup follows.
7. **Handoff** → an accepted card with `stage_handoff=required` gets a director triage
   decision: create/seed/link the proposed cards, or record `handoff_declined_round`.
8. **Defect** → an out-of-scope finding is a `defect` comment plus a question; the director
   creates the fix card (bug label + `fixes`/`origin`) or escalates E1/E4/E5.
9. **Loop/failure** → the supervisor's rework/retry/hold bounds; a `blocked(decision)` card is
   released by a human, not by `awaiting`.

## Known limits

- **Two human stops are different.** `awaiting` is the director's E1–E5 escalation and a
  human comment resumes it; `blocked(decision)` is a supervisor hold and a human must move the
  card back. `meerkat-chat` presents them separately.
- **E-codes are vocabulary plus prompt, not a board gate.** The board checks the
  `in_progress → awaiting` edge and the E1–E5 enum; an automated hold is `E2`.
- **Unassigned has two owners.** With `claim_unassigned=yes` the public pool may claim an
  unassigned card as Worker before the director's route fallback. An assigned card that no
  worker lane can claim is the `assignee_not_scanned` finding, not a route decision.
- **`--as-human` / actor kind is declared attribution.** The board has no cryptographic
  identity; the `awaiting` resume rule is only as strong as the declared author kind.
- **Reviewer read-only is adapter-dependent.** Claude and Pi apply a per-role allowlist;
  Codex, OpenCode and Cursor rely on the prompt plus the board and supervisor checks.
- **A reviewer on another agent kind** requires a second supervisor; one supervisor holds
  sessions of several kinds but has one deployment reviewer.

## See also

- [`../scheduling.md`](../scheduling.md) — the supervisor, the director lane and the passes.
- [`../lifecycle.md`](../lifecycle.md) — flow A/B, the delivery round and acceptance.
- [`../../skills/meerkat/SKILL.md`](../../skills/meerkat/SKILL.md) — the board contract every
  role runs.
- [`../../skills/meerkat-director/SKILL.md`](../../skills/meerkat-director/SKILL.md) — the
  decision charter.
