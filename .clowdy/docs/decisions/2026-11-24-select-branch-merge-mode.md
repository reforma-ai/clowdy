# Select the branch operation in the merge button

- Status: superseded
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Scope: the mode selector in Merge from branch and Merge into branch
- Related tasks: CLO-114
- Supersedes: none
- Superseded by: [Match GitHub Desktop's branch merge choices](2026-11-24-branch-merge-choices.md)

## Context

The merge dialog picked fast-forward or a merge commit automatically. The user chose a split button with Merge, Fast-forward only, Squash and merge, and Rebase. The existing checkout and conflict policy still applies.

## Decision

The arrow selects a mode and refreshes its preview. The main button runs it. Merge still fast-forwards where possible. Fast-forward only refuses diverged branches. Squash commits the incoming changes together after checking for conflicts.

Rebase runs in Merge from branch, in the checkout whose commits will be replayed. The preview names that branch and its new base. A paused rebase can be aborted from the dialog or continued in that checkout. The ordinary Commit action is blocked while a rebase is paused.

## Consequences

No operation creates a worktree. Rebase in another checkout needs a separate decision about history changes and preflight. The related checkout policy is in [Merge into existing checkouts](2026-11-24-merge-into-existing-checkouts.md).
