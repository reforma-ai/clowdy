# Check: Choose a commit message provider

- Result: passed
- Date: 2026-11-24
- Tasks: CLO-99
- State checked: integrated desktop, daemon and protocol changes on `clowdy/dev`

## What was run

| Check | Result |
| --- | --- |
| Electron fixture: press Generate with Off, choose Claude Code, then generate | Source Control opened with no request. After selection, one request filled the draft. |
| Electron fixture: switch to Codex, generate again, then choose Off | The request used Codex. With Off, Generate opened Source Control and the draft was preserved. |
| Daemon `bun test test/git-message.test.ts test/acp-registry.test.ts` | 78 passed, including loading the saved choice from disk, the legacy two-switch case, provider errors and a change while a request is queued. |
| Desktop `bun run test` for Changes, SettingsWindow, ProvidersPage and projectsTransport | 580 passed. |
| Protocol `bun run test` and `bun run typecheck` | 84 passed, types passed. |
| Desktop `bun run typecheck` and Vite build | Both passed. |

## Known limits

- Electron used fixtures. Daemon tests used stand-ins for Codex and Claude Code, real Git repositories and the generation endpoint.
- The daemon typecheck reported the same eight errors as the baseline in ACP, file serving and terminal code.

## Verdict

The app shows one saved provider, routes generation through it and keeps the setup path visible.
