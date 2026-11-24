# Merge into existing checkouts

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Scope: both branch merge directions in Source Control
- Related tasks: CLO-79
- Supersedes: [Merge between branches](2026-11-24-merge-between-branches.md)

## Context

An outgoing merge used to create a temporary worktree when the destination was not checked out. A conflict left that worktree behind without a chat to help resolve it. The result of an outgoing merge in an existing checkout could also surprise the chat that used that folder.

## Decision

**Merge into branch…** requires an existing checkout. Its preview reports incoming commits, the destination path, and whether the pinned commits can merge cleanly. A predicted conflict blocks the action and points to **Merge from branch…** in a chat on the destination branch. The daemon checks again before merging. Source Control creates no worktree for either direction.

**Merge from branch…** merges into the current checkout and can leave conflicts there for resolution. It fetches origin first when available. The conflict result shows the folder, Done dismisses the dialog, and Abort merge requires confirmation. Both directions fast-forward when possible. The follow-up is covered by [Synchronize with origin after commits and branch merges](2026-11-24-sync-after-commit-and-merge.md).

## Consequences

A branch without a checkout must be opened before an outgoing merge. Checking a diverged outgoing merge requires Git with `merge-tree --write-tree`. See `apps/daemon/src/git/branchMerge.ts` and the [Git manual](https://git-scm.com/docs/git-merge-tree).
