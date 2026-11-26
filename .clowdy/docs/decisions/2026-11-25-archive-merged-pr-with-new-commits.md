# Archive a merged pull request once the branch has commits of its own since

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Scope: The merged pull request that the chat list and Source Control show for a branch. Not the current pull request that the Changes tab reads for a checkout, and not open or draft pull requests.
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context
[Pull request history by branch](2026-11-25-branch-pull-request-history.md) keeps every pull request of a branch and shows the newest merged one as the branch's pull request while none is open (`partitionPullRequests`). So a chat whose pull request was merged keeps a purple icon after the branch gained new commits, and it looks fully merged and safe to remove while unmerged work sits on the branch. The Changes tab's own pull request read already drops a merged pull request that HEAD has moved past (`movedPast` in `apps/daemon/src/git/pullRequest.ts`); the history did not. The chat list reads only `ProjectInfo`, which has the branch name but no commits.

## Options considered
1. Grey icon for a merged pull request with new commits. For: the record stays visible. Against: still an icon on a chat that has unmerged work, and a new state to explain.
2. Treat that merged pull request as archived: no icon, the pull request moves to "Archived PR". For: a branch with unmerged work looks like one that never had a pull request. Against: the chat shows nothing about the unmerged work (the Changes tab icon does).
3. Count commits ahead of the base. For: simple. Against: a squash or rebase merge leaves the branch's commits out of the base for good, and a stale `origin/main` counts merged work as new.

## Decision
Option 2. The daemon judges it on every history answer, also one from its cache. It marks the newest merged pull request `movedPast`, and only while none is open, when the local branch has commits that are in neither that pull request's branch (`headRefOid`, now kept in the history rows) nor its base, merges left out. The client shows a merged pull request only when it is not marked, and never falls back to an older one.

## Reason
- Fit: the rule is the Changes tab's, extended to the history, and the archive group already holds every pull request that is not shown.
- Reversibility: one optional field `movedPast` and one condition in `partitionPullRequests`; rows stored before the field have no `headCommit`, so they behave as before until the next read.
- Cost: up to three local git processes per history answer, only for the newest merged pull request and only with no open one; no network.

## Consequences
A squash or rebase merge, a base that moved on, and Update from main (a merge) do not count as new work, so the purple icon stays after them. A commit made in a checkout shows in the chat list at the next refresh (a minute, the window gaining focus, or a git action in the app). A pull request whose head commit is not in the repository, or a branch that is not local, is not judged. The Changes tab still hides a merged pull request after Update from main (HEAD is then not an ancestor of its head), which the history no longer does.
