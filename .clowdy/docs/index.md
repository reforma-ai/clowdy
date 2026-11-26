# Clowdy project documents

## Decisions

- [Changes tab icon and dot in the rail](decisions/2026-11-25-changes-tab-rail-indicator.md) records that the tab's icon shows the stage of the work and a yellow dot marks uncommitted files. Status: accepted.

- [Sync keeps the default branch up to date](decisions/2026-11-25-sync-advances-default-branch.md) records that Sync fast-forwards the local default branch from origin, and when it leaves it alone. Status: accepted.

- [Project switch keys](decisions/2026-11-25-project-switch-keys.md) records Cmd+Option+0 to 9 for the personal space and the first nine projects, where they run, and why Actual size moved to Cmd+0. Status: accepted.

- [Clone a repository into a project](decisions/2026-11-25-clone-repository-into-projects.md) records that folders can be cloned from a git address, from the shared folder list, with no fork on GitHub. Status: accepted.

- [Interface copy and automatic sync](decisions/2026-11-25-interface-copy-and-automatic-sync.md) records the merge and commit labels, preview layout and copy conventions. Status: accepted.

- [Pull request history by branch](decisions/2026-11-25-branch-pull-request-history.md) records shared branch history, archive and chat list indicators. Status: accepted.

- [Delete branches from Source Control](decisions/2026-11-24-delete-branches.md) records the branch menu, confirmation and origin option. Status: accepted.

- [Source Control action priority](decisions/2026-11-24-source-control-action-priority.md) records which action wins and how base updates follow automatic Sync. Status: accepted.

- [Sync after commits and branch merges](decisions/2026-11-24-sync-after-commit-and-merge.md) records the shared Sync action and how it resolves branch divergence. Status: accepted.

- [Changes tab render performance](decisions/2026-11-24-changes-tab-render-performance.md) records why far diff cards are empty boxes and unchanged git answers keep their objects. Status: accepted.

- [Durable provider questions](decisions/2026-11-24-durable-provider-questions.md) records provider capabilities and how questions survive an agent without form elicitation. Status: accepted.

- [Stage coordination follows Briefback](decisions/2026-11-24-briefback-stage-coordination.md) records the stage, review and delegation model. Status: accepted.
- [Manual chat order](decisions/2026-11-24-use-manual-chat-order.md) records why the sidebar uses one saved order and puts new chats first. Status: accepted.
- [Switch branches in a merged chat worktree](decisions/2026-11-24-switch-merged-worktree-branches.md) describes which branch switches are allowed. Status: accepted.
- [Merge into existing checkouts](decisions/2026-11-24-merge-into-existing-checkouts.md) describes conflict checks for outgoing merges and how to resolve conflicts in an existing checkout. Status: accepted.
- [One provider for commit messages](decisions/2026-11-24-choose-one-commit-provider.md) records the Source Control selector and how older settings map to it. Status: accepted.
- [CI: red runs and run time](decisions/2026-11-25-ci-red-runs-and-speed.md) records that CI stays a report for now, how the red tests are sorted and fixed, and how the gate and the Windows release tests get faster. Status: accepted.

## Checks

- [Changes tab icon and dot in the rail](checks/2026-11-25-changes-tab-rail-indicator.md) covers the stage rules, the rail in the fixture app in both themes, the tooltip text and an independent review. Status: passed with limits.

- [Sync advances the default branch](checks/2026-11-25-sync-default-branch.md) covers the fast-forward, a branch with its own commits, a missing local branch and a checked-out one, with real git. Status: passed with limits.

- [Project switch keys](checks/2026-11-25-project-switch-keys.md) covers the keys in each window state, the hints in Settings > Projects and the drag handle background. Status: passed with limits.

- [Clone a repository into a project](checks/2026-11-25-clone-repository.md) covers the clone dialog from a new and an existing project, the three target cases, a taken target, a bad address, cancel and Escape against a real daemon. Status: passed with limits.

- [Interface copy and automatic sync](checks/2026-11-25-interface-copy.md) covers the action labels, merge preview, decorative separators and legacy scheduled titles. Status: passed with limits.

- [Branch pull request history](checks/2026-11-25-branch-pull-request-history.md) covers GitHub reads, shared counts, archive and missing worktrees. Status: passed.


- [CI: red runs and run time](checks/2026-11-25-ci-red-runs-and-speed.md) covers the gate in four Linux containers, twice, the fixed tests and the independent read; the GitHub run is still to come. Status: passed with limits.
- [Branch deletion](checks/2026-11-24-delete-branches.md) covers the context menu, confirmation, branch switching and protection against stale or unsafe deletions. Status: passed.

- [Branch merge choices](checks/2026-11-24-branch-merge-choices.md) verifies the three modes and the result of the destination's Git policy. Status: passed with limits.

- [Sidebar widths and merge file rows](checks/2026-11-24-sidebar-widths-and-merge-rows.md) covers the shared minimum, saved widths and merge file selection. Status: passed with limits.

- [Source Control action priority](checks/2026-11-24-source-control-action-priority.md) covers Push, Update, Fetch and the automatic Sync preference. Status: passed with limits.

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

- [Branch merge choices](decisions/2026-11-24-branch-merge-choices.md) records the earlier label for regular merge. Status: superseded.

- [Select the branch operation](decisions/2026-11-24-select-branch-merge-mode.md) records the earlier four choices. Status: superseded.

- [Push after commits and branch merges](decisions/2026-11-24-push-after-commit-and-merge.md) records the earlier push-only preference. Status: superseded.

- [Provider question capabilities](decisions/2026-11-24-provider-question-capabilities.md) records the earlier ordinary-tool fallback. Status: superseded.

- [Merge between branches](decisions/2026-11-24-merge-between-branches.md) records the earlier temporary checkout policy. Status: superseded.
