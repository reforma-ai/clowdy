# Push after commits and branch merges in Source Control

- Status: superseded
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Related task: CLO-139
- Superseded by: [Synchronize with origin after commits and branch merges](2026-11-24-sync-after-commit-and-merge.md)

## Decision

Enable **Push after commit and merge** by default in **Settings → Source Control → Sync**. The setting is stored on this device. It applies to commits and both directions of the branch merge dialog. Completing a merge after resolving conflicts follows the same rule as a regular commit.

A commit sends its own branch to origin. It can publish the branch under its own name. A branch merge sends the resulting commit to the destination branch on origin, even if the dialog was opened from the source branch. Git can reject these pushes under its usual rules.

Shift and the commit menu offer a local commit while the default is on. Turning the setting off restores the separate push action after an outgoing merge, as described in [Merge into existing checkouts](2026-11-24-merge-into-existing-checkouts.md).

## Consequences

Conflicts pause the operation before any push. A rejected push leaves the local result in place and shows the failure so it can be addressed separately. The commit button shows a local action when Source Control already knows the branch cannot be pushed.
