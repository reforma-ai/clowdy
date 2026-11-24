# Sidebar widths and merge file rows

- Result: passed with limits
- Date: 2026-11-24
- Task: CLO-156

| Check | Result |
| --- | --- |
| Electron resize with an existing profile width below 220 px | Source Control, Files, Docs and Chats open at 220 px. Source Control can grow, then stops at 220 px when dragged smaller |
| Electron window resize | Changes uses wide mode at 1200 px and returns beside the chat at 1440 px |
| Electron merge conflict fixture | Conflicts and Files to commit have no checkboxes. The commit message is editable |
| Git merge with one conflicting and one clean incoming file | Git rejects committing the clean path before and after resolving the conflict. Committing the staged merge after resolution succeeds and records both parents |
| Desktop Changes, side panel, width persistence and UI store tests | 605 passed |
| Desktop and file manager type checks, Vite build and scoped Biome | Passed |

The Electron and broader test runs used a clean checkout of `ef3a4e8b` with the changes applied. A baseline type check in `clowdy/dev` failed on conflict markers in `ChatFolder.test.tsx`, `ChipTrigger.tsx` and `ChatView.test.tsx`. The reviewer ran 62 relevant tests in `clowdy/dev` and they passed.
