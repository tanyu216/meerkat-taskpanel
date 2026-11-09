# 0023 — The director stays read-only alongside the reviewer

- **Status:** Accepted (2026-11-07)
- **Context:** ADR 0020 gave every dispatched session the full tool set and kept
  only the reviewer's write tools denied. The director lane (the
  `meerkat-director` skill answering question, route, triage and escalation rows)
  does not need the write tools: its contract is to decide, record the decision on
  the board and release the card; a fix is a card for a worker, never an edit. Its
  cwd is the project directory — the shared tree, not a card worktree — so an edit
  there competes with peer lanes and humans and leaves no claim, plan, report or
  review behind. A project carrying `docs/agents/worktrees.md` already has the
  worktree guard deny writes in its primary checkout.
- **Decision:** The read-only lanes are `director` and `reviewer`. The worker lane
  keeps the full tool set. The Claude adapter denies `Edit`, `Write` and
  `NotebookEdit` for a read-only lane; Pi excludes `edit` and `write`; Codex has no
  per-role tool surface, so its read-only boundary stays with the prompt. The
  native agent definitions render the same deny line (the reviewer is the only
  `role.json` role with a read-only lane; the director is a skill, not a role).
  `src/foundation/role-tools.mjs` carries `READ_ONLY_LANES` and the one deny table.
  This supersedes ADR 0020's director-lane claim; the worker's full access and the
  reviewer's read-only rule stand.
- **Why:** Least privilege for the two lanes whose contract excludes file changes.
  A decision or a review that finds a defect records it; the fix goes through the
  board's claim, plan, report and review chain. Granting write to the control lane
  buys a convenience that the audit trail cannot see and that the project's own
  worktree guard is designed to refuse.
- **Consequences:**
  - A trivial fix surfaced by a decision still becomes a card; the director cannot
    do it in passing.
  - The rule is tool-level: the director keeps unrestricted `Bash` (it must run
    `taskctl` and the project's reads) and `Agent`. A shell redirection can still
    write; the boundary is the prompt plus the board's authority.
  - Codex's director and reviewer boundaries are prompt-only.
  - The worker's full access, `Agent` availability for every lane, and the
    untracked-subagent position are unchanged from ADR 0020.
- **Alternatives:**
  - **Keep the director full.** Rejected: no contract need, a shared cwd, and no
    audit trail for the edit.
  - **Deny `Bash` too.** Rejected: the director must drive the board and read the
    project; a tool-level write deny is the smallest rule that matches the
    contract.
