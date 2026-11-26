# Sync keeps the default branch up to date

- Status: accepted
- Date: 2026-11-25
- Decided by: user (the need), orchestrator (the rules)
- Scope: Sync of a branch with origin, manual and after a commit or a merge
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context

Sync fetched and merged only the branch that is checked out, and pushed it. After a pull request was merged into `main` on GitHub, the local `main` stayed where it was, 48 commits behind, because nobody had it checked out and nothing else updates it. The person wanted Sync to keep it current.

## Decision

- After a Sync that finishes, the default branch is fast-forwarded to origin's. The default branch is the one the app already treats as the base: the branch `origin/HEAD` names, else `main` or `master`.
- Only a fast-forward, and only of a branch the person already has. Sync makes no branch.
- A default branch with commits of its own that origin lacks is left as it is. So is one that is checked out in any checkout of the repository, the person's or an agent's: files do not move under them. That checkout brings it up to date with its own Sync.
- It is silent and best effort. A refusal or a network failure never fails the Sync, and the next Sync tries again. A plain Fetch does not do it.

## Reason

The local default branch is where new branches and worktrees start from, so it should not fall behind. Letting git decide what is safe (a refspec with no `+`) keeps the rule small and the person's work out of harm's way.

## Consequences

Each Sync of a feature branch costs one more small fetch of the default branch. A project whose default branch is checked out in its main folder does not get it updated from a Sync of a worktree.
