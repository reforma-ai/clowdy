# Chat mentions

- Date: 2026-11-25
- Tasks: CLO-192
- Result: passed with limits
- State checked: the change in `clowdy/dev` before commit

| Check | Evidence |
| --- | --- |
| Desktop tests | `bun run test` in `apps/desktop`: 5015 tests, 271 files passed. The review reran 69 affected tests after its changes. |
| Composer and stream | In the hidden Electron fixture window, typing `@architecture` in First version found Architecture questions. Enter inserted the chip, another Enter sent it, the sent chip showed the title and pressing it opened chat c-3. |
| Daemon | The independent review ran 110 tests across the CLI, tool catalog, orchestration and skill vocabulary; all passed. The final CLI regression also passed. |
| Read scope | The CLI test reads pages of an independent archived chat, including question answers and thread summaries, skips reasoning and tool items, rejects missing and cross-project IDs, handles empty chats, and observes no new events or changes to the target. |
| Build and quality | Renderer production build and daemon bundle built into temporary directories. Typecheck and lint passed in the daemon, desktop and components; the components RichInput tests and system-skills validator passed. |

Limits: the full daemon suite was stopped after 995 passing tests and no observed failures, rather than making the user wait for unrelated tests; the affected suite completed. The packaged app and real provider sessions were not run. The running app was not replaced or restarted.
