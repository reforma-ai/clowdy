# Clowdy project documents

## Decisions

- [Sync after commits and branch merges](decisions/2026-11-24-sync-after-commit-and-merge.md) records the shared Sync action and how it resolves branch divergence. Status: accepted.

- [Changes tab render performance](decisions/2026-11-24-changes-tab-render-performance.md) records why far diff cards are empty boxes and unchanged git answers keep their objects. Status: accepted.

- [Durable provider questions](decisions/2026-11-24-durable-provider-questions.md) records provider capabilities and how questions survive an agent without form elicitation. Status: accepted.

- [Stage coordination follows Briefback](decisions/2026-11-24-briefback-stage-coordination.md) records the stage, review and delegation model. Status: accepted.
- [Manual chat order](decisions/2026-11-24-use-manual-chat-order.md) records why the sidebar uses one saved order and puts new chats first. Status: accepted.
- [Switch branches in a merged chat worktree](decisions/2026-11-24-switch-merged-worktree-branches.md) describes which branch switches are allowed. Status: accepted.
- [Merge into existing checkouts](decisions/2026-11-24-merge-into-existing-checkouts.md) describes conflict checks for outgoing merges and how to resolve conflicts in an existing checkout. Status: accepted.
- [Select the branch operation](decisions/2026-11-24-select-branch-merge-mode.md) records the split button and the scope of the four choices. Status: accepted.
- [One provider for commit messages](decisions/2026-11-24-choose-one-commit-provider.md) records the Source Control selector and how older settings map to it. Status: accepted.

## Checks

- [Branch Sync](checks/2026-11-24-smart-sync.md) covers the origin exchange, conflict recovery, destination safety and streamed progress. Status: passed with limits.

- [Source Control during fetch and push](checks/2026-11-24-source-control-during-sync.md) covers branch selection and queued actions while sync is pending. Status: passed.

- [Automatic push in Source Control](checks/2026-11-24-auto-push-in-source-control.md) covers both merge directions, the saved setting and recovery after rejection. Status: passed with limits.

- [Changes tab performance](checks/2026-11-24-changes-tab-performance.md) covers render time before and after for 200 files, and the tests. Status: passed with limits.

- [Question lifecycle](checks/2026-11-24-question-lifecycle.md) covers provider questions, cancellation, recovery and timed waits. Status: passed with limits.

- [Briefback stage coordination](checks/2026-11-24-briefback-stage-coordination.md) covers skill validation, prompt tests and the daemon typecheck baseline. Status: passed with limits.
- [System skill edits](checks/2026-11-24-system-skill-edit.md) covers validation, integration tests and semantic review. Status: passed with limits.

- [Manual chat ordering](checks/2026-11-24-manual-chat-order.md) covers native drag, grouping, and saved order after reload. Status: passed.

- [Worktree branch switch](checks/2026-11-24-switch-merged-worktree-branches.md) covers the real Git and Electron checks. Status: passed.

- [Changes and Source Control](checks/2026-11-24-changes-workflow.md) covers the default diff layout, the sidebar, and the commit and sync controls. Status: passed.

- [Merge between branches](checks/2026-11-24-merge-between-branches.md) covers both directions in Electron, explicit push, and destination conflict handling. Status: passed.

- [Outgoing merge preflight](checks/2026-11-24-merge-into-preflight.md) covers conflict and checkout refusals, incoming conflicts, and explicit push after a clean merge. Status: passed.
- [Branch merge modes](checks/2026-11-24-branch-merge-modes.md) covers the split button, the resulting Git history, and conflict handling. Status: passed with limits.

- [Source Control with a PR and merge conflicts](checks/2026-11-24-source-control-combination.md) covers the compact PR row, split file lists, and narrow layout. Status: passed.
- [Commit message provider](checks/2026-11-24-commit-message-provider.md) covers setup from Generate, switching providers and daemon routing. Status: passed.
- [Stop commit message generation](checks/2026-11-24-stop-commit-message-generation.md) covers the stop control, retry and provider process cancellation. Status: passed.

## Superseded

- [Push after commits and branch merges](decisions/2026-11-24-push-after-commit-and-merge.md) records the earlier push-only preference. Status: superseded.

- [Provider question capabilities](decisions/2026-11-24-provider-question-capabilities.md) records the earlier ordinary-tool fallback. Status: superseded.

- [Merge between branches](decisions/2026-11-24-merge-between-branches.md) records the earlier temporary checkout policy. Status: superseded.
