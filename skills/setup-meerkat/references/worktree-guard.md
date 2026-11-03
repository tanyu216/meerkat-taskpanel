# Worktree guardrails

A round-4 **optional sub-step**. It initializes the worktree rules this project
already wrote in `docs/agents/worktrees.md` and installs the runtime hooks that
make them hard to ignore. It is a best practice, not a mandatory install:

- **Skip** is a valid answer; record `skipped` and do not nag.
- A user may configure the same hooks by hand from this page; say so.
- This is the only initialization point. Do not add this wiring to the
  installer or to a per-kind install script — setup-meerkat owns it.
- Nothing here is a sandbox. Claude project hooks can be disabled, Codex hooks
  require trust, and pi has no sandbox at all. Say that plainly rather than
  promising enforcement.

## What it writes

The installed `taskctl worktree` command is the one mechanism every runtime
calls. The hook adapters are thin translators:

| Kind | File | Entry |
|---|---|---|
| Claude | the settings file the user chose (`~/.claude/settings.json` by default) | `PreToolUse` on `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash\|EnterWorktree` → `taskctl worktree guard --runtime claude`; `SessionStart` → `taskctl worktree status` |
| Codex | `~/.codex/hooks.json` (or the project's `.codex/hooks.json` when trusted) | `PreToolUse` on `Bash\|apply_patch\|Edit\|Write` → `taskctl worktree guard --runtime codex`; `SessionStart` → `taskctl worktree status` |
| pi | `~/.pi/agent/extensions/meerkat-worktree-guard.ts` | `tool_call` → `taskctl worktree guard --runtime pi` |

The policy is in the installed CLI, not copied into the hooks: a project opts in
by carrying `docs/agents/worktrees.md`; a linked worktree is allowed; a write to
the protected primary checkout is denied with the recovery command.

## The questions

Ask, in this order, with a recommended answer:

1. **Enable the guard for this project?** Recommended: yes, when the project
   adopted `docs/agents/worktrees.md`. Skipping leaves the rules as prose.
2. **Which kinds?** Recommend every kind that works in this project and has a
   CLI installed. A kind with no CLI is reported, not guessed.
3. **Claude settings scope?** Recommended: the user-level file (the same one the
   Meerkat session hook uses). A project-level file is valid when the team wants
   it committed; it is still user-overridable.
4. **Codex hook location?** Recommended: the user-level `hooks.json`. The
   project `.codex/hooks.json` is loadable only in a trusted workspace.
5. **pi extension location?** Recommended: `~/.pi/agent/extensions/`. If the
   project installs the package with `pi install`, its own manifest already
   loads the extension; do not write a second copy.

## Act

Run the bundled writer; show its `--dry-run` report before writing:

```bash
node <skill-dir>/scripts/worktree-init.mjs \
  --home <home> --project <dir> --cli <taskctl-shim> \
  --runtime claude,codex,pi --claude-settings <file> [--dry-run] [--json]
```

It merges every hook (never replacing an unrelated one), is idempotent, and
reports `written` / `unchanged` / `skipped` / `conflict` per kind. A second run
reports `unchanged`.

After the write:

1. **Codex:** open `/hooks` in Codex, review the entry, and trust it. Until then
   the hook is inert. This is a manual step; setup-meerkat must not run
   `--dangerously-bypass-hook-trust`.
2. **pi:** print the launcher shape for the project:
   `cd <project>/.worktrees/<slug> && pi`. pi has no `--cwd`; the launch
   directory is the only reliable pin, and the extension is a guardrail.
3. **Verify:** run `taskctl worktree status` from the project and paste one
   sample payload through the guard (the reference in the `meerkat` skill's
   `references/cli.md` has the exact shapes).
4. **Report** each kind as `written` / `unchanged` / `skipped` / `conflict`, and
   name the Codex trust step as still open until the user confirms it.

## The off switch

Deleting `docs/agents/worktrees.md` removes the project from the guard's
protected set. Existing worktrees are never deleted by that act; remove them
with `taskctl worktree leave` / `sweep`. The hook entries may stay installed —
they become no-ops for this project and still guard any other project that
carries the marker.
