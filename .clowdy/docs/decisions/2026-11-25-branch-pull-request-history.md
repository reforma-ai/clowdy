# Pull request history by branch

Status: accepted
Date: 2026-11-25

A pull request belongs to its source repository and branch, rather than to a chat. Chats that share a worktree or branch share its history and archive state. Show all outgoing pull requests GitHub returns for that branch, including merged and closed ones, even if their head commit is no longer the current tip. Exclude same-name branches in forks.

Source Control lists the pull requests above the commit form, with a link to GitHub and a state icon. The existing current-PR checks and Create PR eligibility keep their meaning. Only merged and closed pull requests may be archived. Archive is reversible and local to Clowdy; it never changes GitHub. Keep archived records available in the panel and exclude them from the chat list count. A reopened PR becomes visible again.

Fetch and cache history by repository and branch and retain the last good answer in the daemon database. Read lightweight summaries with pagination and deduplicate concurrent requests. Chat list badges use the branch of the actual checkout, with a remembered branch for a missing worktree; switching branches changes the visible history. The count is shared, never a claim of which chat created a PR.
