# Project switch keys

- Date: 2026-11-25
- Tasks: none
- Result: passed with limits
- State checked: the working tree of `clowdy/dev` before the commit

| Check | Evidence |
| --- | --- |
| Unit tests | `src/renderer/shell`, `hotkeys`, `features/settings`, `features/sidePanel` and `src/main/menu.test.ts`: all pass. They press the keys as a Mac types them (`key: '¡'`, `code: 'Digit1'`, Cmd and Option) for each slot, an empty slot, a text field, Settings alone, a confirmation or a menu over Settings, and a changed order. |
| Full desktop suite | `bun run test`: 266 files and 4,978 tests pass, 2 fail: `attachmentsTransport.test.ts` (already recorded in the clone check) and `daemonProbe.test.ts` (oversized health body). Neither file nor what it imports was changed. |
| Types and lint | `bun run typecheck` and `bun run lint` in `apps/desktop`, and the same in `packages/components`, pass. |
| Real renderer | In the screenshot harness (fixtures): with no window open, Cmd+Option+2, 0 and 1 moved to Clowdy, Personal and Car Rental, and 7 changed nothing; from a text field it worked; over Settings, 0 opened Personal and closed Settings; with a row menu open over Settings, 2 changed nothing. Each row showed its keys before the menu button. |
| Drag handle | The handle's computed background is `rgb(255, 255, 255)`, the Settings window's own, where it was the grey `--color-surface`. The grip dots no longer sit in a grey box. |

Not checked: the packaged app and a real keyboard (the keys were sent as events), Windows and Linux, and the dark theme of the handle.
