# Check: Changes and Source Control

- Result: passed
- Date: 2026-11-24
- Tasks: CLO-19, CLO-20, CLO-21, CLO-22
- State checked: the combined Changes renderer and Source Control settings in the `clowdy/dev` worktree

| Check | Result |
| --- | --- |
| Desktop Vite renderer build | Exit 0 |
| Desktop `bun run typecheck` and Biome on changed paths | Exit 0 |
| Desktop `bun run test` with loopback access for the daemon tests | 255 files and 4774 tests passed |
| Open Changes in a fresh Electron fixture | All six diffs start collapsed and the sidebar contains the commit checklist without a Changed files section |
| Turn off Collapse diffs by default and reload | All six diffs open and the preference stays off |
| Open the origin dropdown for a branch two commits ahead | Push shows 2 commits, Pull is disabled, and each entry fits on one line |
| Hold Shift and click the contrast commit button | The button reads Commit & Push. The fixture confirms the commit and push, then offers Fetch origin |

The Changes tests also cover new files after refresh, expanding all, focus after a discard, and the disabled Shift action when there is no origin.

The Electron check used fixture data on macOS. It made no request to a live remote.
