# App review and refactor: research map

**Question.** Where is the Clowdy app (desktop renderer, Electron shell, daemon, shared packages, tests and guides) not simple, reusable, safe or fast, and what should change so other agents can work on it easily? Special focus: the renderer rebuilding UI that `packages/components` and `packages/styles` already provide.

**Scope.** All of `apps/` and `packages/`, the root guides, the test suites. Read-only research by nine agents on 2026-11-27, at the commit `e4cd92b4` (branch `clowdy/full-app-refactor`, `next` merged in).

## Summary

- **Safety is sound.** No command injection, path traversal or Electron hole was found. The loopback API checks host, origin and token; SQL is bound; the shell has context isolation, sandbox, a navigation lock and signed OTA bundles. Remaining safety items are edges: the file manager can write into `.git`, sync git calls without timeouts freeze the daemon, a disabled user skill is still loaded.
- **Speed problems are on hot paths.** Every streamed chunk re-renders the whole chat page and copies and sorts the whole run; drafts re-render the chat list on every keystroke; the agents list rebuilds its model on every run tick; the daemon re-reads and re-serializes per chunk and per SSE client, spawns 8-19 git processes per status request and walks the docs tree synchronously per keystroke of the `@` menu.
- **The renderer rebuilds the design system.** Chips and pills six times with three tone maps, loading and empty states 16 times, the dialog preset in 8 places, rows, fold buttons, split buttons, progress bars, focus rings in six recipes, a parallel settings kit, two undefined CSS variables. The design system itself carries about 10k lines of unused forked Reforma components, an inaccessible `Modal` and a `Badge` that is a grid.
- **Duplication everywhere below the UI.** Four process runners, seven path-containment checks, six settings-file writers, four SSE loops, four latest-request-wins loaders, 13 preference classes, helpers re-implemented beside `@clowdy/lib`.
- **Oversized modules.** `runs/driver.ts` 1665 lines, `domain/workspaces.ts` 1531, `runs/service.ts` 1345, `AgentList.tsx` 1190, `ModelPicker.tsx` 790, `Composer.tsx` 787, `ProjectUi` 650.
- **Guides cannot be read first.** `apps/desktop/AGENTS.md` is 300 KB and `apps/daemon/AGENTS.md` 470 KB, about 1% rules; they are the top merge hotspot. The components guide recommends the wrong import and omits used components.
- **Tests.** Renderer tests run without the MobX observer plugin the app uses; a 12k-line fake daemon backs 88 test files and ships in the production bundle; no shared test kit; stale `Modal` mocks hide confirm flows.

## Baseline (2026-11-27, before any change)

`bunx turbo run build lint typecheck test --continue`: build, lint, typecheck green. Desktop tests: 61 failed of 5452 in 17 files (most from the branch-prefix sync added on `next` in `b6d8d2f6`, which adds a `settings.setBranchPrefix` command the fixture tests do not expect; others time out under load). Daemon tests: 1 failed of 2666 (`commands endpoint > replays a lost first-message response`), 881 s. The machine was loaded by nine research agents, so timing failures need a re-run.

## Topic pages

- [ui-chats-stream.md](ui-chats-stream.md): chats, the run stream, the shell; streaming re-renders, composer, model picker, chips.
- [ui-tasks-agents-panels.md](ui-tasks-agents-panels.md): tasks, agents list, side panels, worktrees; rows, chips, fold buttons, empty states.
- [ui-settings-changes-css.md](ui-settings-changes-css.md): settings kit, Changes (diffs, commit box, merge dialog), hotkeys, renderer-wide CSS audit.
- [design-system.md](design-system.md): catalog of `packages/components` and tokens; gaps, dead forked code, accessibility, docs drift.
- [renderer-state.md](renderer-state.md): transport, SSE feed, stores, stream store, drafts, preferences, fixture daemon.
- [daemon-core.md](daemon-core.md): HTTP API, runs, engines, domain, database; event growth, streaming hot path, sync git in transactions, oversized files.
- [daemon-edges.md](daemon-edges.md): git, file system, terminals, providers, skills, CLI; process runners, timeouts, git process counts, duplication.
- [platform-shared.md](platform-shared.md): Electron main, preload, protocol, lib, file-manager, scripts; shell contract and OTA gate.
- [tests-and-guides.md](tests-and-guides.md): test suites and the agent guides; target structure for guides.

## Important files

- `apps/desktop/src/renderer/stream/StreamStore.ts`, `features/chats/ChatView.tsx`, `features/chats/Composer.tsx`: streaming hot path.
- `apps/desktop/src/renderer/daemon/httpTransport.ts`, `daemon/fixtureTransport.ts`, `stores/RootStore.ts`, `stores/ProjectUi.ts`: data layer.
- `apps/desktop/src/renderer/features/agents/AgentList.tsx`: agents list.
- `packages/components/src` (`Modal`, `Badge`, `Button`, `SettingsLayout`, `PanelEmptyState`), `packages/styles`: design system.
- `apps/daemon/src/runs/driver.ts`, `runs/service.ts`, `domain/workspaces.ts`, `http/routes.ts`, `domain/git.ts`, `git/status.ts`, `providers/exec*`: daemon.
- `apps/desktop/scripts/publish-ota.ts` (`SHELL_PATHS`): files whose change needs a shell release.

## Open questions

- Event log retention and delta events (daemon-core F1) change the resync contract; not decided by research.
- GITFLOW names `next` as the only working branch while the app works in `clowdy/<slug>` worktrees merged through `clowdy/dev`: which is the integration branch is the owner's call.
- Whether `http://localhost` links from the terminal should open in the browser.

## Limits

- Nothing was profiled or run in the app; performance costs are derived from code.
- Windows behavior was read, not run.
- Database growth was not measured on a real `clowdy.db`.
