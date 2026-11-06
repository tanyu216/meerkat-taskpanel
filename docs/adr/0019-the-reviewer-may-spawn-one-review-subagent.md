# 0019 — The reviewer may spawn one fresh-context review subagent

- **Status:** Accepted (2026-11-07)
- **Context:** Independence is enforced by dispatch, not by the reviewing context.
  `self_review_not_independent` (`src/core/domain/workflow.mjs`) refuses a review whose
  actor is the original card's assignee or holder, and every card runs as its own
  top-level session since 0.2.0 removed the subagent capability (`cb7e3a1d`; ADR 0006
  keeps the worker-session half only). That actor check cannot see a **session** that
  previously worked the original card — the resident pool can hand the review to a
  session whose context still holds the delivery — and an interactive authoring session
  can invoke the reviewer role directly. In both cases the reviewer would judge its own
  work, and the protocol could only answer with a process REJECT.
- **Decision:** The **reviewer lane only** gains the Claude `Agent` tool. A review turn
  that shares the delivery's context spawns at most **one** fresh-context, read-only
  review subagent. The subagent reads this skill's protocol, performs the review and
  returns the verdict, the security-checklist row table and the evidence. The parent
  relays that verdict verbatim under `independent: delegated`, re-judges nothing, keeps
  every board write (heartbeat, delivery, card state) and delegates no further level:
  the delegated reviewer completes the review in its own turn. Where the harness offers
  no subagent, the reviewer asks the human how to route an independent review and holds
  the turn. Worker and director lanes stay subagent-free. The review child is
  **one-shot**: it is not tracked in the subagent ledger and is never resumed,
  and the ledger's remaining legacy rows are left as they are; no supervisor-level
  subagent machinery returns.
- **Why:** The property that matters is the **reviewing context**, not only the actor
  id. A fresh-context subagent is the smallest mechanism that gives the reviewer an
  independent view without changing the loop's one-session-per-card model or restoring
  the removed ledger. One level bounds recursion and cost; the one-shot child needs no
  resume because its only output is a verdict.
- **Consequences:**
  - `src/foundation/role-tools.mjs` carries `Agent` in the reviewer's Claude surface;
    the Claude session adapter and the generated native agent definition read that one
    table, so both gain the tool together. The generated definition still carries no
    `Write`/`Edit`.
  - The reviewer's skill protocol gains an independence gate (Step 0): detect the
    delivery context, delegate, relay verbatim, and ask the human when delegation is
    unavailable. A self-review that neither delegates nor asks the human is blocking.
  - Codex's adapter carries no per-role tool surface; where the kind has its own
    subagent mechanism the reviewer uses it, and the skill's human fallback covers the
    rest. Pi's reviewer surface stays `read,bash`: spawning there needs the
    `pi-subagents` extension, which this decision does not add, so the fallback applies.
  - One nested turn per delegated review (token and wall-clock cost), with no resume.
  - `docs/scheduling.md`'s "no session spawns a subagent" statements narrow to
    "worker and director sessions spawn nothing; the reviewer may spawn one read-only
    review subagent"; `GLOSSARY.md`'s reviewer-session/subagent entries describe the
    restored, narrower shape.
  - Tests pin the surface: the reviewer carries `Agent`, worker and director do not,
    and the generated reviewer definition carries no `Write`.
- **Alternatives:**
  - **Dispatch exclusion only.** Rejected: the predicate is actor-based, so a reused
    session or an interactive invocation still self-reviews.
  - **Require a fresh session per review.** Rejected: the pool carries no delivery-context
    metadata to route on, and it moves independence into the loop rather than the role.
  - **Restore the full subagent capability and ledger.** Rejected as over-engineering:
    the reviewer needs one one-shot, read-only child and never resumes it.
- **Note:** This narrows the 0.2.0 removal; it does not restore ADR 0006's worker
  batch/subagent lane.
