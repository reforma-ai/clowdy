# Check: a merged pull request with new commits on the branch is archived

- Result: passed with limits
- Date: 2026-11-25
- Tasks: none
- State checked: the uncommitted change on `clowdy/dev` before its commit, in the worktree: daemon, protocol and desktop

## What was run
| Step | Command or user action | Result |
| --- | --- | --- |
| 1 | `bun run typecheck` in `packages/protocol`, `apps/daemon`, `apps/desktop`; `bunx biome check` in the daemon and the desktop app | exit 0, no findings |
| 2 | `bun test --timeout 20000 test/git-pull-request.test.ts` in `apps/daemon` | 77 passed |
| 3 | `bunx vitest run` in `apps/desktop` | 5025 passed, 2 failed (below) |
| 4 | `bun test --timeout 20000` in `apps/daemon`, whole suite, twice | first run 2570 passed, 1 failed; second run 2573 passed, 0 failed |
| 5 | The daemon's own history read against real GitHub for this branch, in the worktree and in a throwaway clone with one extra commit | see Evidence |
| 6 | Mutating the daemon rule (drop `--no-merges`, drop the base refs, drop the head exclusion, mark older pull requests, mark while one is open, mark the oldest, a git error counted as true) | each made at least one test fail |
| 7 | Independent review by a separate agent | no defect in the rule; it cut the git cost, added tests and fixed comments |

## Evidence
- Real GitHub, branch `clowdy/dev`, newest merged pull request #46 (head `d4469467`): in the worktree, whose tip has no commit of its own since, #46 was not marked; in a clone with one more commit, #46 was marked `movedPast` and the older merged #45 was not.
- `test/git-pull-request.test.ts` covers, with real git repositories: the mark after a commit made in a checkout, also from the cache and after an archive; a merge of the base into the branch and a base that moved on (not marked); only the newest merged pull request judged; an open or draft pull request, a row without `headCommit`, a commit the repository lacks and a branch that is not local (not judged); a linked worktree.
- The desktop tests cover the grouping (the newest merged pull request is hidden once marked, and an older one does not take its place) and the chat row badge going away.
- The independent review added tests for three mutations that had survived.

## Failures
- The desktop suite has two failures in files this change does not touch: `src/main/daemonProbe.test.ts` and `src/renderer/daemon/attachmentsTransport.test.ts`. They were not run on a clean checkout of the base commit, so "already failing" is inferred.
- The first whole daemon run had one failing test whose name was not kept; the second run, with the same code, had none. The cause is not established, and a failure that appears only under load is the likeliest.

## Known limits
- The app was not run: the chat row and Source Control were not looked at, only the data they read and the tests of their grouping.
- A squash or rebase merge, a base that moved and Update from main leave the merged pull request visible, by design. A rebase of the branch after a squash merge, a pull request head force-pushed on GitHub, an update from a base other than the pull request's base, and a deleted stacked base all count as new commits, which hides the merged pull request without real new work.
- Commits that exist only on `origin/<branch>` and were never pulled are not seen.
- Not verified: whether GitHub keeps `headRefOid` of a merged pull request fixed after later pushes, Windows git, shallow clones, the packaged app.
- The Changes tab still hides a merged pull request after Update from main, which the history no longer does.

## Verdict
The rule works on real GitHub data and in tests; the chat row and the panel still want a look by a person in the app.
