# Changes tab render performance

- Status: passed with limits
- Date: 2026-11-24
- Tasks: CLO-128, CLO-129, CLO-130
- Decision: [Changes tab render performance](../decisions/2026-11-24-changes-tab-render-performance.md)
- Commits: 7dc6a508, 862a0064 (branch `clowdy/dev`)

## Claim

The Changes tab no longer re-renders cards whose files did not change, a Viewed tick re-renders only its card, and only the cards near the screen are built.

## Evidence

A temporary probe (not committed) mounted the tab on the fixtures with 200 changed files, all cards folded, under the renderer's observer plugin, and summed React Profiler render time per event (happy-dom, so absolute numbers are higher than in Electron):

| Event | Before | After |
| --- | --- | --- |
| Mount the tab | 473 ms | 233 ms |
| Window focus, the same git answers | 106 ms | 3 ms |
| Tick Viewed on one card | 119 ms | 1 ms |
| Shift press anywhere, ×10 | 8 ms | 11 ms |
| Commit message keystroke, ×3 | 4 ms | 2 ms |

With the sidebar hidden the mount was 93 ms: most of what is left is the commit box's list of every uncommitted file.

- `bunx vitest run src/renderer/features/changes` (apps/desktop): 447 passed, 5 failed. The 5 are about the commit date format in the scope menu (`19 Nov at 23:59` against `19 Nov, 23:59`) in `changeScopes.test.ts` and `ChangesTab.test.tsx`; they are not touched by this work.
- `bun run typecheck` (apps/desktop): clean. `bunx biome check` on the changed files: clean.
- New tests: `keepEqual.test.ts`; in `PlaceChanges.test.ts`, a re-read keeps unchanged files and a card's viewed and fold reads ignore other files; in `ChangesTab.test.tsx`, a far card becomes an empty box and comes back, and a focused card stays built.
- Each stage was reviewed by a separate agent. The second review fixed focus loss under a far card and made the empty box and the built card one element, so scroll anchoring keeps working.

## Not checked

- No run in the Electron app: the change was not tried in a candidate build with a real repository, and scrolling, sticky headers and the jump from the last run plate were checked only by tests and review.
- If the window loses focus while a far card holds the focus, the card is emptied and the focus is not restored.
