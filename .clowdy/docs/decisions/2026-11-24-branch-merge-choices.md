# Match GitHub Desktop's branch merge choices

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Related task: CLO-153
- Supersedes: [Select the branch operation in the merge button](2026-11-24-select-branch-merge-mode.md)

## Decision

The branch merge menu offers **Create a merge commit**, **Squash and merge**, and **Rebase**. The first mode is a regular Git merge, like [GitHub Desktop's merge command](https://github.com/desktop/desktop/blob/development/app/src/lib/git/merge.ts). With the standard Git configuration it fast-forwards when possible. The preview describes the actual outcome and the destination's fast-forward policy applies. The previous Fast-forward only strategy remains accepted by the daemon for existing callers.

An outgoing operation still requires an existing destination checkout. Rebase runs in the current checkout. The action keeps Clowdy's existing preview, conflict and Sync behavior.
