# Worktrees and branches in this project

1. Parallel work never happens in the primary checkout; it happens under `.worktrees/`.
2. Ownership partition: `lane/<ref>[-r<round>]` belongs to the loop. A session never creates,
   reuses, commits to or deletes a lane worktree. Human work uses `<type>/<slug>`; never name a
   session worktree after a card id.
3. Cards branch from the project's declared `base_ref` and land on `merge_ref`; read both with
   `taskctl project map show <id> --json`. Keep the primary checkout on `merge_ref`; the loop
   refuses to land anywhere else. A **rework** round (the loop rejected the delivery the
   round before) reuses the rejected round's `lane/<ref>` worktree, branch and uncommitted
   work instead of creating `lane/<ref>-r<round>`; do not create or move that tree by hand.
4. Landing order: merge first, then `git worktree remove`, then `git branch -d`. A worktree with
   uncommitted changes is never removed.
5. `.worktrees/` and `.claude/worktrees/` belong in `.gitignore` and `.dockerignore`; a session
   worktree is never registered in the loop's `workspaces.json`.
6. **Off switch:** deleting this file removes the project from the guard's protected set;
   existing worktrees are never deleted by that act.
