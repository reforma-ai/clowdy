# A window that has a close button has no Cancel or Done button

- Status: accepted
- Date: 2026-11-26
- Decided by: user (semi-manual)
- Scope: Every git window now and any that is added (the merge window, the new worktree window), and the other windows with a close button. Not confirmations, and not a button that stops something running.
- Related tasks: none
- Supersedes: none
- Superseded by: none

## Context
The merge window had Cancel before a merge and Done after it, and the new worktree window had Cancel. Each did what the close button in the corner, Escape and (for the worktree window) a click outside already do. The add-project, new-task and folder windows already left Cancel out, with a comment that says so.

## Options considered
1. Keep the buttons. Against: they copy the cross, and the user dislikes them.
2. Remove the ones that only close. A form has its action as one full-width button; a window that is over after its action keeps only the buttons that go on from there.
3. Remove every Cancel. Against: a confirmation (`openConfirmModal`) has no close button, so its Cancel is the only visible way out, and for a destructive action it takes the focus first; a Cancel that stops a clone or a sign-in is not a copy of the cross.

## Decision
Option 2. The merge window keeps Abort (a merge or rebase that stopped) and Sync (after a merge) and leaves its footer out when nothing is left to press; the new worktree window is the action as one full-width button. The rule is written in `apps/desktop/AGENTS.md`.

## Reason
- Fit: the same rule as the add-project, new-task and folder windows.
- Reversibility: the buttons are a few lines each.
- Cost: the cross of the merge window is disabled while a merge runs, as the button was, so nothing is closed that was not before.

## Consequences
A merge that ends with nothing to press leaves the cross as the only way out. A new window with a close button follows the rule without a record.
