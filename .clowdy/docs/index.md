# Clowdy project documents

## Decisions

- [Manual chat order](decisions/2026-11-24-use-manual-chat-order.md) records why the sidebar uses one saved order and puts new chats first. Status: accepted.
- [Switch branches in a merged chat worktree](decisions/2026-11-24-switch-merged-worktree-branches.md) describes which branch switches are allowed. Status: accepted.
- [Merge between branches](decisions/2026-11-24-merge-between-branches.md) describes both merge directions, automatic fetch, and the destination checkout. Status: accepted.

## Checks

- [Manual chat ordering](checks/2026-11-24-manual-chat-order.md) covers native drag, grouping, and saved order after reload. Status: passed.

- [Worktree branch switch](checks/2026-11-24-switch-merged-worktree-branches.md) covers the real Git and Electron checks. Status: passed.

- [Changes and Source Control](checks/2026-11-24-changes-workflow.md) covers the default diff layout, the sidebar, and the commit and sync controls. Status: passed.

- [Merge between branches](checks/2026-11-24-merge-between-branches.md) covers both directions in Electron, explicit push, and destination conflict handling. Status: passed.
