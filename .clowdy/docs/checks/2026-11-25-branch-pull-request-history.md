# Branch pull request history

- Date: 2026-11-25
- Tasks: CLO-180, CLO-181, CLO-182, CLO-183
- Result: passed

| Check | Evidence |
| --- | --- |
| Real GitHub read | The new history query returned four merged PRs for `clowdy/dev` with `access: ready`. No GitHub writes were made. |
| Daemon | The PR and storage suites covered pagination, same-name fork exclusion, deduplication, deleted local refs, persistent offline history, archive and restore, reopened PRs, and changed-origin refusal. |
| Desktop | Full suite: 4,834 tests passed before review fixes. The focused review checks covered history transport, archive updates across shared chats, branch switching, and the missing-worktree history. |
| Protocol and types | 84 protocol tests passed; desktop, daemon and protocol typechecks passed. Scoped Biome and `git diff --check` passed. |
| Isolated Electron | Three chats on one fixture worktree displayed the same count; Source Control displayed three PR rows with open, merged and closed states, current CI counts and terminal-PR archive controls. |

Independent review added canonical origin validation before archive, a persisted last-known branch for missing worktrees, and tests for both cases. The running Clowdy app was left untouched.
