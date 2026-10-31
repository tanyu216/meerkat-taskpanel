# 0007 — Roles are skills; the director decides; installation location routes

## Status

Accepted — 2026-10-31.

## Context

The standard team existed only as a **template** inside `setup-meerkat`
(`assets/team/standard/`). `install-roles.mjs` copied it into a roles root, and the loop's
control session read that manifest, selected a role by the card's assignee, and injected an
abbreviated role excerpt plus a **path** to a workflow file. A session that picked up work
itself could not discover a role the way it discovers a skill.

The loop's one irreplaceable act was assembling that prompt; the rest — role selection — was a
manifest lookup. The orchestration around it (atomic claims, one worker session per card,
worktrees, the review loop, SLA, deferral ledgers) is what has value. Separately, the
`setup-meerkat` skill decided the security toolchain while the role that owns architecture
might run on a platform where `setup-meerkat` is not installed.

## Decision

- The five roles are **standalone skills** — `skills/jobs/`, `skills/linus/`, `skills/turing/`,
  `skills/reviewer/`, `skills/worker/` — each carrying `SKILL.md`, `role.json` (with the
  `meerkat-role` schema marker) and `references/`. `worker` is both a board identity and the
  fallback for a card no role owns and for an unassigned card.
- **Installation location is the routing.** The supervisor scans every installed agent kind's
  `skills/*/role.json`; a role installed on codex runs on codex. There is no roles root, no
  manifest and no platform-mapping configuration key. When several kinds carry a role the
  supervisor's primary kind wins, then claude → codex → pi. Availability is the CLI, not the
  directory: an unavailable preferred kind falls back only to another kind that also carries
  the role; if none does, the card is not claimed and the gap is reported.
- The LLM **control/continue turn is removed**. The supervisor runs patrol → workflow → poll
  in-process under one single-flight lock and generates the prompt injected at session start.
- `meerkat-loop` becomes **`meerkat-director`**: the decision hub for assignment, worker
  questions and E1–E5 escalation. It does not drive the scheduler, claim cards, implement or
  move a card to `done`, and no separate project session handles those decisions.
- The **security toolchain moves to Linus** (decision and mechanism): the assets, script,
  references and the system-initialization step live in `skills/linus/`.
- `setup-meerkat` performs **cross-platform migration** (copy a role skill between kinds,
  deleting the source only after an explicit yes), reports retired structures without deleting
  them, and initializes the project's decision-rights pointer to the director's policy. The
  `taskctl loop …` CLI verbs and flags are unchanged this round.

## Why

- A role as a skill is discoverable by the same mechanism as every other skill, and a session
  that takes work itself reads the complete workflow instead of an excerpt.
- The manifest was a second source of truth that could drift from what was installed; the
  installed tree cannot.
- Role selection is deterministic; keeping an LLM turn for it paid a model call per tick for
  an act that is a lookup. Content decisions remain the director's.
- Putting the security mechanism where its decision lives closes a reachability gap: a Linus
  running on codex or pi can reach the tooling; a Claude-only setup skill could not.
- One supervisor with a multi-kind session pool keeps one claim source and one queue while
  letting each role run where its skill is installed.

## Consequences

- Session keys and stored state carry the actor kind; a role moved between platforms starts a
  new conversation and never resumes the old kind's native session id (ADR 0006's replay path).
- The supervisor claims as its primary kind (`agent=<role>, actor_kind=<primary>`); the worker
  session writes with its own kind.
- A role installed on no available kind is not claimed; status and doctor must report the
  discovered and effective mapping.
- The old `meerkat-loop` skill and `meerkat-loop/roles/` trees are reported as legacy and are
  never deleted by the installer.
