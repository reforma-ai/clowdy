# Handoff: worktree-followups

> Next chat: read this file and the plan. The plan is finished; what is left is
> the owner's decisions and a real-app check. Do not resurrect discarded
> approaches from a chat summary.

## Plan

path: `.briefback/worktree-followups/plan.md`
sync: not used
scope: done. All nine stages (the Manage worktrees dialog with its daemon side, its entry points, the branch prefix, the Fork menu) are on `next` and pushed; see the plan's Closing notes.

## Current work

stage: none in flight
shipped: stages 1 to 9 (merges `f178ccd`, `27a10a7`, `9c812d2`, `08507ac`, `94f9cb1`, `297edfb`); the agent worktrees and branches of this work are removed
remaining: the owner's open decisions (below) and a run in the real Electron app
worker: none

## Next work

stage: only on the owner's word
done when: the owner has used the dialog and the Fork menu in the real app and decided on the open points
assignment: unassigned
suggested: the open points are in the plan's Closing notes and in the memory `clowdy-manage-worktrees`: widen the Fork menu to answers without `canFork`; focus Cancel instead of the destructive button in `ConfirmModalContent`; a fourth `WorktreeBlock` value for a worktree that has another worktree inside; the Windows reserved names in a branch prefix; a per-place cache in `useFolderGit` so the Files place bar does not nudge the layout. Before UI work read `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md`; for the daemon `apps/daemon/AGENTS.md`. The git chat's work (`.briefback/git-integration/plan.md`) shares the transport and Info files: check `git status` first.
