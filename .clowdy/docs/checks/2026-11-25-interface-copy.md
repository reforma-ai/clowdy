# Interface copy and automatic sync

- Date: 2026-11-25
- Tasks: CLO-185, CLO-186
- Result: passed with limits
- State checked: integrated changes in `clowdy/dev`, including the independent review fix

| Check | Evidence |
| --- | --- |
| Desktop | `bun run test`: 261 files, 4,841 tests passed. The merge and commit tests exercise both automatic sync settings, explicit overrides, Shift, and the merge strategies. |
| Daemon | `bun test --timeout 20000 test/acp-mapper.test.ts test/acp-session.test.ts test/background.test.ts test/providers-read.test.ts`: 451 passed, 8 skipped, none failed. Covers both scheduled-title formats and provider labels. |
| Types, lint and build | Desktop and daemon typechecks, scoped Biome, `git diff --check` and `bun run build:app` passed. |
| Isolated Electron | Opened the merge preview and observed the source and destination, three commits, fast-forward outcome, and destination path separately. The normal commit action read `Commit 3 files`. Background command and worktree rows rendered without decorative separators. |
| Copy scan | The app-authored middle-dot and `& Sync` scan found only three middle-dot parsing expressions, including compatibility with persisted scheduled tasks. |

Independent review caught a legacy scheduled title leaking into the Stop button's accessible label. The fix and regression assertions passed the final desktop suite.

The skills settings preview was not verified visually: its fixture selector did not match. Changes there passed the desktop checks. The running app was left untouched; the candidate built successfully in the worktree.
