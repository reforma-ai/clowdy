# Check: Changes tab icon and dot in the rail

- Result: passed with limits
- Date: 2026-11-25
- Tasks: none
- State checked: the uncommitted change on `clowdy/dev` before its commit, run in the worktree against the fixture daemon, not the real app

## What was run
| Step | Command or user action | Result |
| --- | --- | --- |
| 1 | `bun run typecheck` in `apps/desktop` | exit 0 |
| 2 | `bunx biome check` on the changed files | no findings |
| 3 | `bunx vitest run` in `apps/desktop` | 5010 passed, 2 failed (below) |
| 4 | Fixture renderer on a spare port, `scripts/screenshot.ts` for `?fixtures`, `&worktree&chat=c-9&pr=draft`, `pr=none`, `pr=open`, `pr=none&clean`, light and dark | icon and dot as in the decision record |
| 5 | Independent review by a separate agent, which fixed three defects and added tests | see below |

## Evidence
- Stage rules: `changesStage.test.ts` covers clean, ahead, open, draft, merged, closed, merge with conflicts, paused rebase, failing checks, requested changes, a pull request of another branch, detached and unborn heads, a cut file list.
- Rail: `SidePanel.test.tsx` checks the icon of each stage, the dot with its count, no dot while the Changes tab is on show, and the tooltip text `Draft pull request #54, checks are running` then `3 uncommitted files`.
- Screenshots (fixture data): Commit icon with no dot with no chat open; branch icon with a yellow dot (commits waiting); Merge icon with a dot (draft pull request); the warning icon with a dot (failing checks), grey like the other icons in both themes; branch icon with no dot for a clean worktree.
- The review found that a permanent reader in the rail stopped the Changes tab from starting a round of reads when it opened, so the file list could be as old as the last round; `useGitFacts` now asks for a round when a reader joins a place that is already read. It also found that the pull request of a previous branch could show after a switch (now ignored unless its head is the checked-out branch) and an unclear accessible name (now `Changes, 3 uncommitted files`). Mutating seven behaviours was caught by the tests each time.

## Failures
Two tests fail on the desktop suite and also alone: `src/main/daemonProbe.test.ts` (gives up on a status other than 200) and `src/renderer/daemon/attachmentsTransport.test.ts` (keeps an uploaded file). They are in files that none of the changed files touch. They were not run on a clean checkout of the base commit, so "already failing" is inferred, not proven.

## Known limits
- The real app was not run, and the tooltip was seen only as text in a test, not drawn: synthetic hover does not open it in the screenshot harness.
- The facts refresh on window focus, the end of a run, a commit, a push and similar, not on a save in the editor or a command in the terminal, so the dot can lag while an agent edits, and a conflict outside a merge or rebase (a cherry-pick, a stash pop) is not a problem state.
- If `gh` cannot be read, the pull request drops out and the icon falls from Merge to Version.
- The rail now keeps the place's git status, branch changes and `gh` pull request read while a project is on show; the cost was not measured.
- The branch and Merge glyphs are mirror images at 14px; telling them apart in use is not judged.

## Verdict
The icon and the dot work as decided in the fixture app and the tests; the real app and the cost of the extra reads still want a look by a person.
