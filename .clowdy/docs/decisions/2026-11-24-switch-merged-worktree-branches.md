# Switch branches in a merged chat worktree

- Status: accepted
- Date: 2026-11-24
- Decided by: user
- Scope: branch selection in the Changes sidebar
- Related tasks: CLO-34, CLO-35, CLO-36

Chat worktrees use the same branch picker as the folder's own checkout. A switch can proceed when Git can show that the worktree's current commit is in its recorded base branch. An existing worktree without a recorded base uses the folder's base. This check uses the refs already on disk.

The daemon also checks for uncommitted files, an active run or Git operation, and a target branch held by another worktree. A worktree switch also refuses to overwrite an ignored file. App switches in the same repository run one at a time. The switch keeps the worktree path, chat association, and original creation record.
