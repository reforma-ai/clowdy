# Check: the merge and worktree windows without Cancel and Done

- Result: passed with limits
- Date: 2026-11-26
- Tasks: none
- State checked: commit `165f93ea` on `clowdy/dev`, in the worktree against the fixture daemon, not the real app

## What was run
| Step | Command or user action | Result |
| --- | --- | --- |
| 1 | `bun run typecheck` and `bunx biome check` in `apps/desktop` | exit 0, no findings |
| 2 | `bunx vitest run src/renderer/features/changes src/renderer/features/worktrees` | 597 passed |
| 3 | `bunx vitest run` in `apps/desktop`, twice | 5239 passed, 3 failed each time, two the same, one a different task test that passes alone |
| 4 | The fixture app, Changes tab, Merge from branch, `scripts/screenshot.ts` | the window has the cross, the filter, the branch list and the merge button, and no Cancel |

## Evidence
- `ChangesRemote.test.tsx` now closes the merge window with the cross, checks that the cross is disabled while a merge runs and enabled after, that the only button before a merge is Merge, and that there is no Cancel or Done in any state it reaches (a rebase that stopped, conflicts that sync cannot resume, a conflict in another worktree).
- `ManageWorktrees.test.tsx` checks that the new worktree form has no Cancel.

## Failures
Two desktop failures are in files this change does not touch (`src/main/daemonProbe.test.ts`, `src/renderer/daemon/attachmentsTransport.test.ts`), not run on a clean checkout of the base commit. A third, in `features/tasks`, differs between runs and passes alone.

## Known limits
- The new worktree window was not looked at on a screen: its tests check the form, and its layout is the one of the other windows without Cancel.
- The merge window after a merge, and with a conflict, was seen only through tests.
- No separate reviewer read this change.

## Verdict
The merge and worktree windows have no Cancel or Done in the tests, and the merge window looks right before a merge; the rest wants a look by a person.
