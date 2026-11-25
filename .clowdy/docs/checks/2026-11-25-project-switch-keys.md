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
| Project menu | The settings buttons have opacity 0 and no pointer events at rest and opacity 1 on a hovered row (computed style in the harness). With the card forced open in a screenshot, it stood to the right of the menu with a gap, showing `Car Rental`, `⌥ ⌘ 1` and the folder path. A unit test opens it from the keyboard and reads the name, the keys and two folders in order. |
| Drag handle | The handle's computed background is `rgb(255, 255, 255)`, the Settings window's own, where it was the grey `--color-surface`. The grip dots no longer sit in a grey box. |

Not checked: the packaged app and a real keyboard (the keys were sent as events), Windows and Linux, and the dark theme of the handle and the card. The card was not opened by a real pointer: the harness window has no pointer, so it was opened from the keyboard in a test and forced open in the screenshot; the 500 ms wait and moving between rows were not seen.
