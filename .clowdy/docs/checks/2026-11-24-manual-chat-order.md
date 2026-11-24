# Check manual chat ordering

- Result: passed
- Date: 2026-11-24
- Tasks: CLO-55
- State checked: The `clowdy/dev` worktree with the manual chat order and the settings cleanup

## What was run

| Step | Command or action | Result |
| --- | --- | --- |
| 1 | `bun run test src/renderer/features/agents src/renderer/features/settings/ChatPage.test.tsx src/renderer/stores/UiStore.test.ts` from `apps/desktop` | 429 tests passed, including moving a chat via its menu and restoring an archived chat to its saved slot |
| 2 | `bun run typecheck` from `apps/desktop` and `biome check` on the affected CSS and TypeScript files | Exit 0 |
| 3 | Vite production renderer build into a temporary directory | Exit 0 |
| 4 | An isolated Electron window on the fixture renderer, using native Chromium drag events | A drop after a thread placed the chat after the entire thread block and kept the current chat selected |
| 5 | Reload the fixture and create a chat | The manual order survived reload and the new chat appeared at the top |
| 6 | Drag between folders with grouping on, then repeat in the flat list | The grouped drop was refused and the flat drop reordered the sidebar |

## Known limits

- The desktop drag was checked on macOS with fixture data. Windows and touch gestures were not exercised.
