# Sync advances the default branch

- Date: 2026-11-25
- Tasks: none
- Result: passed with limits
- State checked: the working tree of `clowdy/dev` before the commit

| Check | Evidence |
| --- | --- |
| Daemon Sync suite | `bun test test/git-remote.test.ts`: 64 pass, none fail (59 before, 5 new). The new ones use a real repository with a bare origin and a second clone that moves `main`: Sync of `topic` fast-forwards the local `main` and leaves `topic` without main's commits; a local `main` with commits of its own stays; no local `main` is not made; a `main` checked out in another worktree and that worktree's files stay; Sync of `main` itself still ends as before. |
| Without the change | With the call switched off, the fast-forward test fails and the other four pass, so the test does see the change. |
| Types and lint | Daemon `bun run typecheck` reports no error, and `bun run lint` is clean. |

Not checked: a project whose origin default is not `main`, a remote that does not answer (the call is wrapped, but its timeout was not exercised), and the app's own Sync button end to end. The change had no separate reviewer: I read it myself against git's refusal cases, which the tests exercise.
