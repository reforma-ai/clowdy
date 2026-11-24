# Synchronize with origin after commits and branch merges

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Related task: CLO-143
- Supersedes: [Push after commits and branch merges in Source Control](2026-11-24-push-after-commit-and-merge.md)

## Decision

Use the same Sync action manually and after successful commits or branch merges. Rename the existing device preference to **Sync after commit and merge** and keep its saved value and enabled default.

Sync fetches origin, integrates missing commits from the branch of the same name and pushes if local commits still need sending. A branch with no matching branch on origin can be published. When both branches have commits, a clean merge is automatic. Conflicts pause Sync in the affected checkout. Completing that merge follows the same automatic setting. Merge into runs Sync in the destination checkout.

The interface shows the fetch, merge and push phases. Explicit Fetch and Pull remain available. The operation uses normal non-forced pushes and keeps local commits if the remote rejects them.
