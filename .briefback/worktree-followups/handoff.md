# Handoff: worktree-followups

> Next chat: read this file and the plan. Resume within the authorized scope,
> respecting dependencies and existing worker ownership. Do not resurrect
> discarded approaches from a chat summary.

## Plan

path: `.briefback/worktree-followups/plan.md`
sync: not used
scope: the whole plan (8 stages: the Manage worktrees dialog and its daemon side, the branch prefix, the Fork menu), authorized by the owner on 2026-11-23 with the wish to run stages in parallel and to start the next ones while the previous are in review. The grill is settled (plan Decisions, Out of scope, Defaults I took); do not reopen it.

## Current work

stage: Stages 1, 3 and 8 (first wave, no dependencies)
shipped: nothing yet
remaining: three implementation workers, each in its own isolated worktree on a branch `worktree-agent-<id>` (Stage 1: `a5ed993286278046e`, Stage 3: `a2318d608d170640b`, Stage 8: `a025858a595710645`; the worktrees are under `.claude/worktrees/`). Their branches were created from `origin/main`, which lacks the commits of `next`, so each was told to merge `next` first. After each: review in a subagent, merge into `next`, record commits in the plan.
worker: those three agents and the coordinating chat. Results arrive in the coordinating chat, not here.

stage: Neighbouring work, so these files are busy (read them, do not edit until it lands)
shipped: `workspace.open` and the new-chat page's worktree place are merged on `next` (`e16040f`..`3e281d7`)
remaining: branch `worktree-agent-ab7b3603ed54da2a6` (`4fe71a9`, `fb4fa98`) turns the new-chat page's mode and branch chips and the read-only line into one control; it is not merged into `next`. Do not edit `WorkspaceChips.tsx`, `ChatFolder.tsx`, `ChipTrigger.tsx` or `DraftChat.tsx` before it lands. Another agent has uncommitted git-integration work in the shared tree (`routes.ts`, `domain/git.ts`, protocol `api.ts` and `index.ts`, desktop `daemon/*Transport*.ts`): merges that touch those files wait until it is committed.
worker: the review of the one-control branch and the git-integration agent, in other chats

## Bleed

none. Decided and not to be reopened: no "Open here" and no folder switcher (a new chat in the worktree or folder instead); no disk size; no squash detection; the chat delete dialog keeps what it allows; a thread's own worktree keeps the default `clowdy` prefix.

## Next work

stage: Stages 2, 4, 5, 6, 7 as their dependencies land (see the plan's Execution)
done when: each stage is verified, reviewed, merged into `next` and recorded in the plan
assignment: unassigned
suggested: Stage 4 starts from Stage 1's first commit (the contract); Stage 2 after Stage 1; Stage 6 after Stage 4; Stage 5 after 2 and 4; Stage 7 after Stage 4 and the one-control merge. Before UI work read `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md`; for the daemon `apps/daemon/AGENTS.md`.
