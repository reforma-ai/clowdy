# Check: the icon and the single dot of the Changes tab

- Result: passed with limits
- Date: 2026-11-26
- Tasks: none
- State checked: commit `5c3c679c` on `clowdy/dev` (and `e97bfff3` before it), in the worktree against the fixture daemon, not the real app

## What was run
| Step | Command or user action | Result |
| --- | --- | --- |
| 1 | `bun run typecheck` and `bunx biome check` in `apps/desktop` | exit 0, no findings |
| 2 | `bunx vitest run` in `apps/desktop` | 5228 passed, 2 failed (below) |
| 3 | Fixture renderer on a spare port and `scripts/screenshot.ts` for `?fixtures&worktree&chat=c-9&pr=none` in the light and dark themes, and for `pr=open&clean` | the dot in both themes; no dot and the merge icon for a clean branch with an open pull request |
| 4 | Mutating the rule twice: commits counted even with a pull request, and the dot drawn while the tab is on show | each made at least one test fail |

## Evidence
- `SidePanel.test.tsx` covers the merge icon for an open, a draft and a merged pull request (from the current pull request or from the history alone) and the commit icon with none or with a merged one the branch has moved past; the dot for uncommitted files whatever the pull request says; the dot for two commits not merged with no pull request; no dot for commits held by an open, a draft or a merged pull request; the dot only while the tab is not on show and with the panel shut; the name `Changes, 3 uncommitted files, 2 commits not merged`; the tooltip lines.
- The dot is 4px in the primary colour, clear of the icon's corner node in both themes.

## Failures
Two desktop failures are in files this change does not touch: `src/main/daemonProbe.test.ts` and `src/renderer/daemon/attachmentsTransport.test.ts`. They were not run on a clean checkout of the base commit.

## Known limits
- The real app was not run, and no separate reviewer read the last change; the two rules were checked by mutation only. The two earlier versions of this tab were reviewed, and then dropped.
- Commits that are not pushed but sit on a branch with an open pull request give no dot.
- The colour (primary, not the amber warning colour) is read from the user's word "orange" and was not confirmed.
- The tooltip was seen only as text in a test: synthetic hover does not open it in the screenshot harness.

## Verdict
The icon and the dot follow the rule in the fixture app and the tests; the real window still wants a look by a person.
