# Delete branches from Source Control

- Status: accepted
- Date: 2026-11-24
- Decided by: user (semi-manual)
- Related task: CLO-159

## Decisions

- The branch list offers Delete branch from a context menu. A separate confirmation names the branch and warns about unmerged commits.
- A local branch with a same-named branch on origin offers a Delete on origin checkbox, off by default. A remote-only row explicitly deletes the branch on origin.
- Deleting the current branch switches to the repository's default or configured base branch first, when the existing branch switch rules permit it.
- The default branch, configured or saved worktree bases and branches checked out in another worktree are protected. The operation never deletes worktrees.

## Implementation constraints

The daemon previews the deletion, rechecks the intended refs, unmerged warnings and checkout rules at confirmation time, and rejects a changed tip. An origin deletion uses an explicit lease for the confirmed commit. A failed origin deletion after local deletion reports that partial result and refreshes the branch list.

Local deletion uses Git's native branch command to retain its checked-out branch safeguards. The tip is checked immediately before the command under the daemon's repository lock. Direct Git commands outside that lock can still race with the local deletion.
