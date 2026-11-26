# Agent sleep mode

- Date: 2026-11-25
- Task: CLO-194
- Result: passed with limits

| Check | Evidence |
| --- | --- |
| Daemon power API | `bun test test/power.test.ts`: 5 passed. Default, multiple projects, mode changes during work, last run finishing, restart, unauthorized and invalid writes, and shutdown race. |
| Daemon regression | `bun test test/runs.test.ts test/background.test.ts test/commands.test.ts`: 155 passed. |
| Desktop | `bun run test src/renderer/features/settings src/renderer/daemon`: 608 passed, including selecting and saving the sleep mode and opening the Power page. |
| Protocol | `bun run test`: 84 passed. |
| Types and formatting | Daemon, desktop and protocol typechecks passed; Biome passed on changed code; `git diff --check` passed. |
| Bundle | `bun run bundle <temporary directory>` succeeded. |
| Native macOS | An isolated daemon reported `while-working` at startup. `pmset -g assertions` showed a new `PreventUserIdleSystemSleep` assertion for its PID in Always and after starting a fake agent, no assertion in Allow or after cancelling the last agent. It never acquired a display assertion. Killing the assertion's owner process also released it. |

Windows native behavior and the packaged desktop app were not run. The check did not modify the owner's running app or data.
