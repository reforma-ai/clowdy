# Interface copy and automatic sync

- Status: accepted
- Date: 2026-11-25
- Decided by: user (semi-manual)
- Related tasks: CLO-185, CLO-186
- Supersedes: [Branch merge choices](2026-11-24-branch-merge-choices.md)

## Decision

The merge mode is named **Merge**, since a regular Git merge can fast-forward or create a merge commit under the destination’s Git policy. The other choices remain **Squash and merge** and **Rebase**. The preview names the actual outcome, commit count and destination path, using separate lines for different facts. An outgoing merge still requires an existing destination checkout. Rebase runs in the current checkout. The daemon continues to accept the previous fast-forward-only strategy for existing callers.

Primary action buttons name the chosen operation, such as **Commit 5 files**, **Complete merge** or **Merge**. Automatic sync follows the existing preference. Explicit one-time overrides name their effect, and progress and errors identify sync when it occurs.

Use natural phrases, layout and ordinary punctuation in app-authored copy. Avoid decorative middle-dot separators and tooltips that repeat the visible control. Keep existing data readable where stored titles used the old separator.
