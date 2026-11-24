# Clowdy project documents

## Decisions

- [Manual chat order](decisions/2026-11-24-use-manual-chat-order.md) records why the sidebar uses one saved order and puts new chats first. Status: accepted.
- [Switch branches in a merged chat worktree](decisions/2026-11-24-switch-merged-worktree-branches.md) describes which branch switches are allowed. Status: accepted.
- [Merge into existing checkouts](decisions/2026-11-24-merge-into-existing-checkouts.md) describes conflict checks for outgoing merges and how to resolve conflicts in an existing checkout. Status: accepted.
- [One provider for commit messages](decisions/2026-11-24-choose-one-commit-provider.md) records the Source Control selector and how older settings map to it. Status: accepted.

## Checks

- [System skill edits](checks/2026-11-24-system-skill-edit.md) covers validation, integration tests and semantic review. Status: passed with limits.

- [Manual chat ordering](checks/2026-11-24-manual-chat-order.md) covers native drag, grouping, and saved order after reload. Status: passed.

- [Worktree branch switch](checks/2026-11-24-switch-merged-worktree-branches.md) covers the real Git and Electron checks. Status: passed.

- [Changes and Source Control](checks/2026-11-24-changes-workflow.md) covers the default diff layout, the sidebar, and the commit and sync controls. Status: passed.

- [Merge between branches](checks/2026-11-24-merge-between-branches.md) covers both directions in Electron, explicit push, and destination conflict handling. Status: passed.

- [Outgoing merge preflight](checks/2026-11-24-merge-into-preflight.md) covers conflict and checkout refusals, incoming conflicts, and explicit push after a clean merge. Status: passed.

- [Source Control with a PR and merge conflicts](checks/2026-11-24-source-control-combination.md) covers the compact PR row, split file lists, and narrow layout. Status: passed.
- [Commit message provider](checks/2026-11-24-commit-message-provider.md) covers setup from Generate, switching providers and daemon routing. Status: passed.

## Superseded

- [Merge between branches](decisions/2026-11-24-merge-between-branches.md) records the earlier temporary checkout policy. Status: superseded.
