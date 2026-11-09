# 0020 — Full tool access is the default; the reviewer is a deny list

- **Status:** Accepted (2026-11-07); director-lane claim superseded by ADR 0023
- **Context:** The loop ran every supervised session under a per-lane allowlist
  (`src/foundation/role-tools.mjs`), with a `--allow-all-tools` opt-in for unattended
  runs. `docs/scheduling.md` § Headless permission boundary made that a rule: no
  default bypass, a narrow allowlist, an explicit written authorization to widen it.
  In practice the allowlists excluded the subagent tool and the commands a card
  actually needs (`npm`, `docker`, bare `bash`), so sessions hit denied calls and
  could not delegate. ADR 0019 had already narrowed the rule once, for the
  reviewer's one-shot independence child; the owner asked for the capability
  restored for every session, with the reviewer's read-only rule kept as the one
  exception.
- **Decision:** Every dispatched session runs with the full tool set. Claude uses
  `--permission-mode bypassPermissions`; Pi uses `--approve` with no `--tools`;
  Codex uses `approvalPolicy: "never"` with `sandbox: "danger-full-access"`. The
  reviewer lane is the only restricted lane: Claude denies
  `Edit`, `Write` and `NotebookEdit` with `--disallowedTools`, Pi excludes
  `edit` and `write` with `--exclude-tools`, and Codex keeps the prompt-only
  boundary it already had. The same one table renders the adapters' flags and the
  generated native agent definitions: full lanes omit `tools` (both kinds inherit
  their pool), the reviewer carries `disallowedTools` (Claude) or `excludeTools`
  (Pi). The `--allow-all-tools` / `--allow-all-tools-reason` flags and the
  `MEERKAT_TASKPANEL_ALLOW_ALL_TOOLS[_REASON]` keys are retired. This ADR replaces
  the `docs/scheduling.md` § Headless permission boundary rule and supersedes ADR
  0019's tool-surface claims; ADR 0019's reviewer-independence decision stands.
- **Why:** The supervisor is an unattended executor for a board the owner already
  controls. A card session that cannot run the project's commands, edit its tree or
  spawn a subagent cannot do the work the card describes, and there is no human at
  the keyboard to approve the missing tool. A per-lane allowlist also duplicated
  the role model in a second place: the role skill says what the work is, and the
  lane table said what it may use, and the two drifted. One default with one named
  exception is smaller and easier to audit.
- **Consequences:**
  - Claude and Pi sessions carry the installing user's full OS permissions. The
    project directory is **not** an isolation boundary; the worktree-guard hooks
    still block writes to the protected checkout, but they are a guard.
  - `Agent` takes no per-call cwd: a worker's subagent does not inherit the card's
    worktree. Subagent activity is untracked — ADR 0019 keeps the review child out
    of the subagent ledger — and no child is resumed.
  - The reviewer's read-only rule is tool-level: it keeps `Bash`, so it can still
    write through a shell. On Codex it is prompt-only. A child the reviewer spawns
    has its own tool pool, so the deny applies to the reviewer session.
  - The director lane can now write. Its skill still says it never implements; that
    remains a prompt rule.
  - On Pi, spawning a child still needs the `pi-subagents` extension; full access
    does not install it.
  - An old `taskctl loop … --allow-all-tools` invocation fails fast as an unknown
    option. No installed unit carried the flag.
- **Alternatives:**
  - **Keep the opt-in and flip its default.** Rejected: it leaves dead machinery and
    two spellings of one posture; the switch has no user left.
  - **Keep the allowlists and add the missing entries.** Rejected: it keeps a second
    copy of the role model and the same drift; the owner asked for no narrowing.
  - **Deny-list every non-read tool for the reviewer.** Rejected as the wider
    contract: the reviewer must re-run the project's gate, so its commands stay.
