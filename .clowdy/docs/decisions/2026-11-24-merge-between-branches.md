# Merge between branches from Source Control

- Status: superseded
- Superseded by: [Merge into existing checkouts](2026-11-24-merge-into-existing-checkouts.md)
- Date: 2026-11-24
- Decided by: user
- Scope: branch merges in the Changes sidebar
- Related tasks: CLO-50, CLO-51, CLO-52

The sync menu offers **Merge from branch…** and **Merge into branch…**. Both open a picker and preview the source, destination, and number of incoming commits before the user runs the merge. Importing from a remote branch uses the latest `origin` refs after an automatic fetch.

The merge fast-forwards when possible and otherwise attempts a merge commit. An incoming merge updates the current branch. An outgoing merge updates the selected local branch in its own checkout, or in a separate worktree when it has no checkout. The original checkout stays available. When there are conflicts, the result shows the destination folder. Done closes the dialog and keeps the merge in progress. Abort merge requires confirmation. Pushing the merged destination is a separate button.
