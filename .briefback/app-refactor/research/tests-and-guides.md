# Test suites and agent guides as tools for future agents

## Summary

Both tools are big and mostly accurate in detail, but they are built so that the next agent cannot use them well.

- **Guides.** `apps/desktop/AGENTS.md` (308 KB, 49.6k words, 4 lines over 10k characters) and `apps/daemon/AGENTS.md` (476 KB, 117 KB of it table padding, 58k words) are feature encyclopedias. 90% of the desktop guide is one section ("The renderer") with one bullet per feature. Rules and invariants make up about 1% of the desktop guide and 0.5% of the daemon guide. Agents are told to "read it first", and a guide this size (roughly 75k and 90k+ tokens) cannot be read that way. Since 2026-11-17, 550 of 1,364 non-merge commits (40%) touched one of the two files. They are the top two merge hotspots: in 46 of the last 150 merges, both sides had edited one of them.
- **What is stale.** The sampled fine detail (file names, defaults, timeouts, key bindings, copy) is almost all correct. The structural claims and rules have drifted: the process docs describe a `next`-only flow that the repository no longer follows, the root layout and `spec.md` are stale, the "no `observer()`" rule is broken in 7 files, a daemon invariant omits two async commands, and the release status and the file-manager test notes are out of date.
- **Tests.** The renderer has 284 test files and 100k lines (69.6k source lines, 8.9k of them the fixture daemon). The daemon has 96 files and 69k lines. Both suites lean on shared worlds: a 3,500 + 3,300 line in-memory fake daemon backs 88 renderer test files, and the tests reference its ids by magic string about 2,200 times. Small helpers, by contrast, are rewritten in every file: 96 hand-rolled React mounts, 32 copies of `memoryStorage`, `press` defined 44 times with different meanings, and in the daemon, git helpers that `gitRepos.ts` already exports.
- **Vitest and MobX.** The renderer's Vitest config leaves out the MobX observer plugin that the app build uses. Tests therefore redraw by hand and cannot catch a missing reactive update. Separately, 21 test comments say `Modal` cannot load under Vitest, a reason that has been false since 2026-11-18.
- **Timing and copy.** The daemon tests sleep for a fixed 37.6 s in total, and the renderer tests make about 400 real-time `settle`/`wait` calls. 1,000 renderer assertions read `textContent`, coupling tests to copy.

## Findings

### F1. The two app guides are encyclopedias that cannot be read first, and they are the top merge hotspot
- Where: `apps/desktop/AGENTS.md` (lines 51-123 are one section of 270 KB; single lines: 66 = 13.9k chars, 111 = 16.3k, 59 = 12.4k, 91 = 11.4k); `apps/daemon/AGENTS.md` ("API decisions" 133 KB, "Agents" 67 KB, "Threads" 56 KB; lines 259-266 are 9,014-char padded table rows); root `AGENTS.md:16` ("Read its `AGENTS.md` first"); `packages/system-skills/skills/orchestrate/references/threads.md:25` ("Read first: the project guide").
- Problem (observed): section breakdown, with table padding squeezed out:
  - Desktop: 89.6% "The renderer" (one `- **Feature** (paths): ...` bullet per feature). Security invariants 0.8 KB, traps 2.2 KB.
  - Daemon: 37% "API decisions", 18.7% "Agents", 15.5% "Threads". "Invariants" is 1.9 KB (0.5%).
  - The desktop guide quotes 3,414 backticked identifiers and about 225 UI strings, and points to 19 shipped plans and 15 "Stage N" history markers. The daemon guide has 33 migration-number references.
  - Churn: 413 commits touched the desktop guide in 10 days, 179 the daemon guide, 550 of 1,364 non-merge commits touched either.
  - In 46 of the last 150 merges, both sides had edited a giant guide (from `git show --cc --name-only`): desktop guide 37 times, daemon guide 19 times. The next hotspots are `fixtureTransport.ts` (21) and `Screen.test.tsx` (14).
  - Because each feature is a single physical line, two branches that touch the same feature always collide on the whole line.
- Problem (inferred): agents grep a fragment of a line and miss the rule that applies. They also add another paragraph instead of a rule, so the file keeps growing. F4 and F17 show rules in the guides that the code does not follow.
- Fix: see F2 for the target structure. Add a guard to `lint:root` (`scripts/check-guides.ts`) that fails when an `AGENTS.md` is over 12 KB or has a line over 400 characters. Add one rule to the root `AGENTS.md`: feature behavior goes to the domain page, and an `AGENTS.md` changes only for a rule, an invariant or a trap.
- Category: docs. Effort: L. Risk: low (docs only, but every in-flight branch will conflict once: land it between merges).

### F2. Target structure: compact package guides, domain pages, and deleting what the code states
- Where: all guides listed in F1, plus `packages/components/AGENTS.md` (25 KB), `packages/file-manager/AGENTS.md` (16 KB, line 24 alone is 5.1k chars), `.clowdy/docs/` (already the app's own document folder: the Docs tab shows it and the system skills write decisions and checks there), `.briefback/` (3.0 MB of plans and research).
- Problem: there are three homes for knowledge with overlapping content. Example: the rule "windows with a close button have no Cancel or Done" is both `apps/desktop/AGENTS.md:61` and `.clowdy/docs/decisions/2026-11-26-no-cancel-or-done-with-a-close-button.md`. None of the three is sized for reading.
- Fix (proposal):
  - **What stays in each `AGENTS.md`** (target ≤10 KB, ≤150 lines, no line over 400 chars):
    - What the package is, in 3 lines.
    - A folder map, one line per folder.
    - Commands.
    - Invariants and rules, one line each, with the file that enforces them.
    - Traps.
    - How to test: the shared test kit, the fixture policy, the timing policy, the screenshot harness command.
    - A link to the domain index.
    - Desktop keeps "Security invariants", "Traps", the process boundaries, the data flow in ~10 lines (`Transport` → `RootStore` → `ProjectState`/`UiStore` → features; `root.command` never throws; one event feed), and the UI rules as one-liners linking `DESIGN.md`: loading states, content width, type weights, settings blocks, no Cancel/Done, subpath imports, no `observer()`.
    - Daemon keeps run and test, layout, invariants (fixed per F4), the runtime model in ~15 lines (`store.tx`/`emit`/`afterCommit`, `RunService.setStatus` and `transitions.ts`, scheduler slots, the engine seam), testing (`Harness`, `ScriptEngine`/`GateEngine`, `gitRepos.ts`, `SHORT_TIMINGS`) and environment (link `src/config.ts`, or generate the table from it).
    - Components: a complete catalog, one row per folder (all 67, see F17), plus the rules. Props stay in the TS types.
    - File manager (≤6 KB): move "Differences from Reforma" (line 24) to a page. Move the `DiffView` and `selectionAction` prop docs (lines 27-28) into TSDoc on those exports.
  - **Domain pages** under `.clowdy/docs/` (each ≤20 KB, wrapped lines, "why" kept, no copy strings):
    - `desktop/`: `architecture.md` (transport, stores, event feed), `side-panel.md`, `agents-list.md` (chat tree, folders, worktree cards, ordering, archive), `composer.md` (queue, mentions, attachments, edit, model, mode, context ring), `stream.md` (messages, tool, agent, question, approval and thread cards, fork, swipe reply), `changes.md` (Changes tab, last run, discard, sync, PRs, merge, branch picker), `worktrees.md`, `files-and-docs.md`, `terminal.md`, `search.md` (Quick search, Find), `settings.md` (projects, providers, skills, shortcuts, about, appearance), `open-with.md`, `usage-status.md`, `fixtures.md` (`?fixtures` switches and fixture ids), `daemon-host.md` (start-up, child env, packaged daemon), `releases-and-ota.md` (merge with `apps/desktop/RELEASING.md`).
    - `daemon/`: `runtime.md` (runs, turns, scheduler, limits, process safety), `threads.md`, `rewind-and-fork.md`, `native-subagents.md`, `tools-and-prompts.md`, `agents-acp.md` (registry, discovery, v1/v2), `providers.md`, `skills.md`, `terminals.md`, `projects-and-folders.md` (personal space, icons), `queue-and-messages.md`, `attachments.md`, `git-api.md`, `fs-api.md`, `places.md`.
    - `.briefback/<feature>/` stays a working area. A shipped plan is linked from the domain page, not from `AGENTS.md`.
  - **Delete, because the code states it:**
    - UI copy quoted verbatim, about 225 strings in the desktop guide (`Submit edit`, `Stop the agent to edit` restate `Composer.tsx:300,726`).
    - Key bindings (the hotkey registry and Settings > Shortcuts state them).
    - Pixel sizes and token names (the CSS).
    - Per-folder file tables (daemon "Agents" table rows 255-307).
    - Command and route data shapes (the `packages/protocol` types).
    - Migration numbers (`db/migrations.ts`).
    - Test-file inventories (daemon line 406).
    - "Stage N of plan" pointers for shipped work.
    - The `?fixtures` switch list at desktop line 51, which duplicates the comment at `src/renderer/daemon/config.ts:52-64`.
  - **Migration:** do it mechanically, one bullet at a time. Each `- **Title** (paths)` bullet becomes a page section for its area, gets wrapped, and loses its copy literals. Pages can be split in parallel by separate agents.
- Category: docs. Effort: L. Risk: low.

### F3. The process docs contradict each other and the workflow the repository actually uses
- Where: `GITFLOW.md:14` ("All local work happens in the main checkout, on the branch `next` ... A new chat or a new task does not get its own branch or worktree"), `GITFLOW.md:36` ("Push after every commit: `git push origin next`"), `GITFLOW.md:119` (`./clowdy worktree add` → `../clowdy-<slug>` on `<nickname>/<slug>`); `DEVELOPING.md:24-30` ("Use a separate worktree ... select **New worktree** ... Merge the worktree's branch"); `packages/system-skills/skills/orchestrate/references/self-hosting.md:10` ("Work in a copy outside the running checkout"); `BRIEFBACK.md:94-95` (document → "the human docs tree, or `.briefback/docs/<domain>/`"); `BRIEFBACK.md:54` ("Load project craft skills named in `AGENTS.md`").
- Problem (observed):
  - `git worktree list` shows 22 app-made worktrees under `~/Clowdy/workspaces/clowdy/<ID>/clowdy` on `clowdy/<slug>` branches (prefix `DEFAULT_BRANCH_PREFIX = 'clowdy'`). This checkout is one of them (`clowdy/full-app-refactor`).
  - Those branches merge into `clowdy/dev` (for example `d8c3efdd Merge branch 'clowdy/show-removal-form-while-checking' into clowdy/dev`). `clowdy/dev` reaches `main` by PR (`4b084a46 Merge pull request #54 from reforma-ai/clowdy/dev`), and `next` merges `clowdy/dev` (`91eff5dd`). None of this is in GITFLOW.
  - An agent inside a Clowdy worktree that follows GITFLOW would push to `origin next` from the wrong branch.
  - Docs have three homes (`.briefback/`, `.clowdy/docs/`, `AGENTS.md`). BRIEFBACK names `.briefback/docs/`, which does not exist, while README, DEVELOPING and the system skills name `.clowdy/docs/`.
  - The root `AGENTS.md` names no craft skills.
- Fix: rewrite GITFLOW around the real flow. Clowdy worktree per chat → `clowdy/<slug>` → merge into the integration branch → PR to `main`. Keep the shared-tree rules for the case of working in the owner's checkout. Decide whether `next` or `clowdy/dev` is the integration branch and say so once. Make BRIEFBACK's Document step name `.clowdy/docs/` (F2). Remove the craft-skills sentence or name the skills.
- Category: docs. Effort: S. Risk: low (needs the owner's decision on the integration branch).

### F4. Stale and violated claims found by the sample check (30 claims checked)
- Where/Problem (observed). STALE or VIOLATED rows first:

| # | Claim | Where | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| 1 | "Product spec: `spec.md`" | `AGENTS.md:6` | STALE | no `spec.md`; `9c9d7430 chore: stop tracking spec.md` |
| 2 | `apps/daemon`, `packages/protocol` "appear when their stage starts"; the layout table lists neither, nor `packages/system-skills` | `AGENTS.md:24`, table 14-22 | STALE | all three exist; `DEVELOPING.md` layout lists them |
| 3 | All work on `next` in the main checkout, no worktree per chat | `GITFLOW.md:14` | STALE | see F3 |
| 4 | "No `observer()`: the plugin wraps every component" | desktop `AGENTS.md:88` | VIOLATED | `observer(` in 7 files: `features/agents/ProjectMenu.tsx:20`, `settings/SettingsDialog.tsx:12`, `settings/SettingsWindow.tsx:60`, `settings/SourceControlPage.tsx:29`, `agents/AgentList.tsx:1090`, `quickSearch/QuickSearch.tsx`, `changes/ChangesToolbar.tsx`; no reason given (see F5) |
| 5 | Type weights: no 600 in the chrome, never `Text bold` | desktop `AGENTS.md:122` | VIOLATED | `shell/CloneRepositoryForm.module.css:82` `font-weight: 600`; `shell/CloneRepositoryForm.tsx:390` `<Text variant="sm" bold>` |
| 6 | "The release workflow has not run yet" | desktop `AGENTS.md:202` | STALE | tags `v0.1.0` (2026-11-19), `v0.1.1` (2026-11-22), `ota`; the sentence dates from 2026-11-19 |
| 7 | Async command exceptions are `chat.fork` and `chat.edit` (plus sometimes `chat.create`/`chat.delete`) | daemon `AGENTS.md:73` (Invariants) | STALE | `src/commands/context.ts:68` `AsyncCommandType` also has `workspace.create` and `workspace.remove` (`commands/workspace.ts:14`) |
| 8 | "The Explorer and the editor need a browser and have no unit tests" | file-manager `AGENTS.md:31` | STALE | `apps/desktop/src/renderer/features/files/FileManagerView.test.tsx` renders `FileManagerView` (with Explorer) in happy-dom, 33 tests |
| 9 | `import { Box, ... } from '@clowdy/components'` (barrel) | components `AGENTS.md:3` | CONTRADICTS | desktop `AGENTS.md:190` requires subpath imports; the renderer has 584 subpath imports and 0 barrel imports |
| 10 | Components catalog | components `AGENTS.md:45-93` | INCOMPLETE | 25 of 67 folders missing (F17) |
| 11 | `features/` lists `agents`, `tasks`, `files`, `terminal`, `settings` | desktop `AGENTS.md:45` | INCOMPLETE | also `changes`, `chats`, `openWith`, `quickSearch`, `sidePanel`, `worktrees` |
| 12 | `.github/workflows/ci.yml` used as the example of a tracked hidden file | desktop `AGENTS.md:72` | STALE | deleted in `105a38f4` (2026-11-26) |
| 13 | lib "Other modules" list | `packages/lib/AGENTS.md` | INCOMPLETE | omits `coords`, `css-units`, `date`, `errors`, `hooks`, `localstorage`, `react`, `semver`, `useRunner` |
| 14 | Test comments: "`Modal` cannot load under the desktop's Vitest (decorators)" | 21 test files | STALE | see F8 |

  Claims that checked out:
  - Electron 45 (`45.2.1`); TypeScript 7; Node >=22.12; `minimumReleaseAge = 259200`; Biome import boundaries (`biome.json:189,208,236`).
  - Daemon env defaults all match `src/config.ts:128-164` (8/6/4/1000/4/24/3/30/300/2000).
  - `bun run test` = `bun test --timeout 20000`; all 226 `.ts` files the daemon guide names exist.
  - Health timeout 800 ms (`main/daemonHost.ts:10`); external links one a second (`main/security.ts:108`); `assertTrustedSender` (`main/ipc.ts:25`); permissions refused except `clipboard-sanitized-write` (`security.ts:170-183`).
  - `root.command` never throws (`stores/RootStore.ts:240-252`); terminal `FIRST_SIZE` 80x24, resize debounce 100 ms, `Control+Backquote`.
  - `SIDE_PANEL_TABS` order; `PROVIDER_IDS`; skills caps 200 / 256 KB / 1,536; files list TTL 5 s; text 5 MB and media 50 MB limits.
- Pattern (inferred): fine detail is kept current because every feature commit edits the guide. Rules, layout and meta statements are never re-read, so they rot. This argues for the small, rule-only `AGENTS.md` in F2.
- Fix: correct rows 1-14 while restructuring.
  - Row 4: either add the observer plugin to Vitest (F5) and remove the 7 wrappers, or document when `observer()` is required.
  - Row 5: fix `CloneRepositoryForm` (design-system owner).
  - Row 7: add the two commands to the invariant.
- Category: docs. Effort: S (corrections), M (the code fixes in rows 4-5). Risk: low.

### F5. Renderer tests run without the MobX observer plugin, so they redraw by hand and cannot catch reactivity bugs
- Where: `apps/desktop/vitest.config.ts:5-16` (Babel with decorators only) vs `apps/desktop/vite.config.ts:53-62` (`observingComponentsPlugin` + decorators). 25 test files carry the note "The test build has no MobX observer plugin, so the view is drawn again by hand", for example `features/chats/RunningAgents.test.tsx:23`, `features/tasks/screenHarness.tsx:19`, `features/chats/ConversationHeader.test.tsx:19`. `features/chats/ChatView.test.tsx`'s `draw()` calls `render` twice.
- Problem (observed): every UI test re-renders after each store change instead of letting MobX do it. A component that fails to observe a value it reads (the most common MobX UI defect) stays green in tests.
- Problem (inferred): the 7 explicit `observer()` wrappers in F4 row 4 may exist to make components update under tests.
- Fix: add `observingComponentsPlugin({ importPath: 'mobx-react-lite' })` to the Babel plugins in `vitest.config.ts`, the same as `vite.config.ts`, ideally from one shared constant. Then delete the manual second renders and the "drawn again by hand" scaffolding, and drop the explicit `observer()` wrappers or justify them.
- Category: tests. Effort: M. Risk: medium (some tests may depend on manual draws; run the suite).

### F6. A 12k-line fake daemon is the renderer's test backend, dev mode, and a merge hotspot all at once
- Where: `apps/desktop/src/renderer/daemon/fixtureTransport.ts` (3,504 lines), `fixtureData.ts` (3,323), `fixtureTasks.ts` (763), `fixtureGit*.ts`, `fixtureTerminals.ts` and others (8,868 lines of source in total). Their own tests: `fixtureTransport.test.ts` (2,261 lines, 86 tests), `fixtureTasks.test.ts` (992, 57 tests), plus most of `projectsTransport.test.ts` (2,463 lines; 52 fixture references). Wired statically in `daemon/config.ts:1-7,177-200` and used from `root.ts:15-17`.
- Problem (observed):
  - The real client is `httpTransport.ts` + `transport.ts`, 1,143 lines. The fake implements all 56 `Transport` methods with daemon rules copied in: `fixtureTasks.ts` is "written to match the daemon's", and `fixtureTransport.ts:2892` repeats `src/runs/edit.ts:75`'s `Stop the agent to edit this message`.
  - 287 `new FixtureTransport` in 88 test files.
  - Tests address the fixture world by magic ids: 956 `'c-N'`, 825 `'r-...'` and 395 `'CAR-N'` literals. A test's meaning lives in `fixtureData.ts`, which breaks the testing rule that the values that matter are literal in the test.
  - `fixtureTransport.ts` (21), `fixtureData.ts` (13) and `config.ts` (12) are among the top merge hotspots in the last 150 merges.
  - No test checks that the fake and the real daemon agree.
- Problem (inferred): `createTransport` reaches `FixtureTransport` through a static import, so the whole fixture world likely ships in the production renderer bundle. No `dist/` was available to confirm.
- Fix:
  1. Load fixtures lazily (`await import('./fixtureTransport')` when `config.kind === 'fixtures'`).
  2. Split the screenshot world (keep it for `?fixtures`) from a small test fake: an in-memory `Transport` with explicit seeding plus entity builders (F7), so each test states its own data.
  3. Stop testing the fake's behavior in depth. Where the fake must mirror daemon rules, put the rule in `packages/protocol` (pure functions both import), or add shared scenario fixtures that run against the daemon (bun) and the fake (vitest).
  4. Migrate tests away from magic ids file by file.
- Category: tests. Effort: L. Risk: medium.

### F7. There is no shared renderer test kit, so every file rebuilds its own mount, storage, events, queries and builders
- Where (observed counts in `apps/desktop/src`):
  - Hand-rolled React mount (`document.createElement('div')` + `createRoot` + `unmount`): 96 files.
  - `IS_REACT_ACT_ENVIRONMENT = true` set per file: 102 files (17 more in `packages/`).
  - `memoryStorage` redefined in 32 files, and 49 files define a `getItem` storage. The helper is already exported from `features/tasks/screenHarness.tsx:26`, and only 8 files import that harness.
  - `press` defined 44 times with different meanings: a keydown in `shared/PickerPopover.test.tsx:87` and `features/chats/Composer.test.tsx:148`, a click in `shell/UsageStatus.test.tsx`, a dispatch on `body` in `hotkeys/react.test.tsx`.
  - Find-a-button-by-text helpers: 63 in 33 files. Menu-item finders: 12 in 8 files. `new KeyboardEvent('keydown'` in 50 files; `new PointerEvent('pointerdown'` in 31.
  - `settle` defined 40 times, `draw` 57 times.
  - Entity builders written inline: `Chat` 25 in 18 files (`agentTree.test.ts` alone has 6), `Run` 19 in 15, `Task` 11 in 10, `StreamItem` 14 in 10.
  - `HttpTransport` fetch stubs: `const fetchImpl =` 37 times in 15 files, and 71 `new HttpTransport(` with the same URL and token.
  - No `@testing-library` dependency.
- Problem: high setup cost per new test, different semantics behind the same names, and drift: some builders cast partial objects (`({ id, status }) as Run` in `features/agents/mainBranch.test.ts:28`), so a protocol change does not fail them at compile time.
- Fix: create `apps/desktop/src/renderer/testing/` (test-only, excluded from the app build):
  - `mount(ui, { store? })` returning `{ container, rerender, unmount }` with automatic cleanup.
  - `memoryStorage()`.
  - `keyboard.press(key, init, target)`, `pointer.press(el)` / `click(el)`.
  - `byRole(container, role, name)` / `byTestId`.
  - `settle()` (frames/microtasks, no fixed ms).
  - `recordingFetch()` + `httpTransport()`.
  - Typed builders `aChat`/`aRun`/`aTask`/`aStreamItem` with full defaults, no casts. The builders could live in `packages/protocol/testing` so the daemon and lib tests can share them.
  - Move `IS_REACT_ACT_ENVIRONMENT` into `src/vitest.setup.ts`.
  - Optional, an install the owner decides on: `@testing-library/react` and `user-event` instead of the hand-rolled kit.
- Category: tests / reuse. Effort: M (kit), L (migration). Risk: low.

### F8. 21 stale "Modal cannot load" comments keep 15 module mocks that hide the confirm flows
- Where: `vi.mock('@clowdy/components/modals', ...)` in 15 files, for example `features/chats/deleteChat.test.ts:17-18`, `features/chats/ChatViewArchivedTasks.test.tsx:16`, `features/tasks/ScreenViews.test.tsx`, `features/agents/Handoff.test.tsx`, `features/agents/AgentListWorking.test.tsx`; the "cannot load under the desktop's Vitest (decorators)" comment appears 21 times. `vi.mock('@clowdy/components/Toast')` is in 23 files.
- Problem (observed): the decorators plugin was added to `vitest.config.ts` in `b33eb5ad` (2026-11-18), and its comment says it is there so that tests can load modals. `features/worktrees/RemoveWorktreeDialog.test.tsx:2,97,128-147` uses the real `Modal` (`Modal.opened`, `Modal.create`). The comment was still being copied into new files on 2026-11-24 (`deleteChat.test.ts`). With `openConfirmModal` mocked as `vi.fn()`, tests "draw the dialog by hand" and never press its real buttons.
- Fix: delete the stale comments and the modals mocks file by file. Drive confirmations through the real `ConfirmModal`, using `animate: false` as `RemoveWorktreeDialog.test.tsx:130` does, and put that in the test kit (F7). Keep the Toast mock only where a host is missing, or mount a `ToastRegion` in the kit.
- Category: tests. Effort: M. Risk: low.

### F9. Daemon tests redefine helpers that `test/helpers.ts` and `test/gitRepos.ts` already export
- Where:
  - `isolated`, `repository`, `hook` and `left` are redefined in `test/git-commit.test.ts:31,43,71,86`, `test/git-remote.test.ts:42,62(bare),79,110,119` and `test/git-discard.test.ts:43,62,83,92`, although `test/gitRepos.ts:15-92` exports them. Six other git test files import `gitRepos.ts`.
  - `put(root, files)` is identical in 8 files: `git-snapshot`, `git-viewed`, `git-commit`, `files`, `docs`, `places`, `git-changes`, `git-discard`.
  - `const failure = (result) => ...` is identical in 7 files: `task-comments`, `task-archive`, `context`, `projects`, `chat-model`, `task-hierarchy`, `commands`. `Harness` has `ok()` but no `fail()` (`test/helpers.ts:141`).
  - `const harnesses: Harness[] = []` + `afterEach(... splice ... stop())` is repeated in 49 files. 48 setups do `openRepo` + `chat.create`.
  - The polling deadline loop is reimplemented in `bundle.test.ts:23`, `rewind.test.ts:25` and `http.test.ts:401`, alongside `helpers.ts:222 waitFor` and `acp-helpers.ts:166 until` (different defaults: 4 s vs 5 s).
- Problem: the same setup written N times; fixes to the shared helpers (for example `isolated`'s env) do not reach the copies.
- Fix: import the `gitRepos.ts` helpers in the three git files. Add `put` to `fs-helpers.ts` or `helpers.ts`. Add `Harness.fail(type, fields)` returning the `CommandError`. Make `startHarness` register itself for cleanup in the `test/setup.ts` preload (one `afterEach`), and delete the 49 local registries. Keep one `waitFor` (with an `until` alias if needed) and delete the three local loops. Optionally add `startRepoChat(h, engine)` for the 48 `openRepo` + `chat.create` setups.
- Category: tests / reuse. Effort: M. Risk: low.

### F10. Fixed sleeps make both suites slower and timing-dependent
- Where: daemon has 129 awaited fixed sleeps totalling 37.6 s. The largest:
  - `test/chat-workspaces.test.ts:1906,1943,1989` (3 × `Bun.sleep(2500)`)
  - `test/git-clone.test.ts:739` (1500)
  - `test/git-remote.test.ts:574` (1050)
  - `test/acp-session.test.ts:1791,1951` (400, 600)
  - `test/places.test.ts:472-474` (2 × 400)
  - `test/races.test.ts:110,175` (400, 600)
  - `test/threads.test.ts:1175,1202`
  - `test/skills-api.test.ts:453,561`

  The suite runs with `--timeout 20000`. Renderer has 64 literal real sleeps (3.2 s; `features/chats/ContextRing.test.tsx:241` 550 ms, `shell/projectDialogs.test.tsx:297` and `settings/projects/ProjectsPage.test.tsx:538` 450 ms, `features/settings/SettingsDialog.test.tsx:21` 300 ms per `settle`). It also makes about 400 awaited calls to real-time `settle`/`wait` helpers (`features/tasks/screenHarness.tsx:215` `wait = 40ms`; `features/quickSearch/QuickSearch.test.tsx:27` and `shell/CloneRepositoryForm.test.tsx:17` `settle(ms = 60)`, called with 200-450). That adds an estimated 15-30 s of sleeping.
- Problem (observed): many sleeps are "wait, then assert nothing happened" (for example `races.test.ts:110`: `Bun.sleep(400); expect(engine.turns.length).toBe(1)`). These are slow and pass trivially when the effect is merely late.
- Problem (inferred): the 2.5 s sleeps wait out a real grace period instead of the shortened timings (`SHORT_TIMINGS` exists at `test/helpers.ts:73`).
- Fix:
  - Daemon: make the grace periods `Timings` fields shortened in tests, and wait for the event or log line that proves the outcome (`waitFor`) rather than for wall-clock time. For negative assertions, wait for a later positive marker (the next event the runtime always emits), then assert the absence.
  - Renderer: tooltips and debounce timers use `vi.useFakeTimers()` (35 files already do). Replace `settle(ms)` with an act-flush plus an animation-frame wait in the kit (F7).
- Category: tests / perf. Effort: M. Risk: low.

### F11. Renderer assertions are coupled to copy and markup
- Where: 1,000 `textContent ... toBe/toEqual/toContain/toMatch` assertions in 89 files; 572 assertions on English phrases of 3+ words in 104 files, for example `features/chats/deleteChat.test.ts` asserting the whole confirm sentence. 433 `aria-label="..."` selectors in 70 files. Buttons found by their text (F7). Class names inside markup: `stream/ToolCard.test.tsx:83,93,109,137` (`innerHTML` contains `line-through` / `shimmer`); 45 `.style.*` assertions in 9 files. Daemon: 125 phrase assertions in 39 files, against 316 error-code assertions.
- Problem: per `testing.md` "Copy-coupled", a copy edit (and `AGENTS.md` mandates copy rules such as no trailing period) turns many unrelated tests red. Behavior is asserted through wording instead of state.
- Fix: query by role and accessible name through kit helpers that take the name from one place (exported label constants where the label is the contract). Assert store state, command input, or error `code` instead of message text. Keep exact text only where it is the contract (daemon error messages the app shows, CLI output). For `ToolCard`, assert a state attribute (`data-state`) instead of class names. Do this as files are touched, not as a sweep.
- Category: tests. Effort: L (incremental). Risk: low.

### F12. Renderer URL tests repeat the protocol's route tests, while the real seam (daemon router) is untested
- Where: 61 literal `http://127.0.0.1:4310/v1/...` assertions in 11 renderer test files (for example `daemon/projectsTransport.test.ts:28-80`). `httpTransport.ts` builds every URL from `ROUTES` (61 uses). `packages/protocol/src/api.test.ts` already pins `ROUTES` strings. The daemon router does not use `ROUTES`: `apps/daemon/src/http/routes.ts:256-307` matches hand-written regexes (`/^\/v1\/projects\/([^/]+)\/snapshot$/`). `ROUTES` is used once in the daemon (`src/stop.ts:22`).
- Problem: the same path is locked in three places, and the place where drift would break the app (client `ROUTES` vs daemon regex) has no check.
- Fix: add one contract test in the daemon suite that formats every `ROUTES` entry with sample ids (including characters that need escaping) and asserts that a daemon route matches it with the right method. Keep one renderer test per escaping rule and delete the per-method URL assertions.
- Category: tests. Effort: S. Risk: low.

### F13. Giant test files mix many features under misleading names
- Where:
  - Desktop has 18 test files of 1,000+ lines (29.9k lines): `features/agents/Screen.test.tsx` (2,869 lines, 129 tests, 14 top-level describes from "the list" to "worktree cards" and "the Star on GitHub card"), `features/chats/ChatView.test.tsx` (2,289, 101 tests, 26 describes), `daemon/projectsTransport.test.ts` (2,463), `features/tasks/taskCommands.test.ts` (2,212), `stream/StreamView.test.tsx`, `features/changes/ChangesTab.test.tsx` (1,829 lines for a 30-line `ChangesTab.tsx`).
  - Daemon has 22 (38k lines): `acp-session.test.ts` (3,537, 163 tests), `background.test.ts` (3,308), `threads.test.ts` (2,816), `acp-mapper.test.ts` (2,576), `chat-workspaces.test.ts` (2,489).
- Problem: the file name does not tell an agent where a behavior is tested. `Screen.test.tsx` and `projectsTransport.test.ts` are both merge hotspots (14 and 12 of the last 150 merges).
- Fix: split along the existing top-level `describe`s into files named by behavior. For example `features/agents/Screen.test.tsx` → `chatList.test.tsx`, `folderGroups.test.tsx`, `chatArchive.test.tsx`, `threads.test.tsx`, `worktreeCards.test.tsx`; `ChangesTab.test.tsx` → `commit`, `sync`, `scopes`; `acp-session.test.ts` → `acp-v1-session`, `acp-v2-session`, `acp-probe`. Do this after F7, so the shared setup moves into the kit instead of being copied.
- Category: tests / structure. Effort: M. Risk: low.

### F14. Wide test-only dependency seams and mock-heavy assertions
- Where:
  - `features/tasks/taskCommands.ts:48` `TaskCommandDeps` has 33 members, assembled in production by `features/tasks/Screen.tsx` and `shell/keymap.ts`, and faked member by member in `taskCommands.test.ts:116-247` (`ui.openTask: vi.fn`, `asked.created++`, ...). Similar `*Deps` seams: `quickSearch/quickSearchCommands.ts:20`, `files/filesCommands.ts:9`, `agents/agentCommands.ts:15`.
  - Desktop totals: 1,094 `toHaveBeenCalled*` (366 bare `toHaveBeenCalled()`, 278 `toHaveBeenCalledTimes`, 356 `not.toHaveBeenCalled()`), 370 `vi.spyOn` (259 on `store`, `root` or the transport), 119 `vi.mock` of modules in 53 files.
- Problem: per `testing.md` (Implementation-detail, Asserts nothing), many tests verify that a collaborator was called rather than the outcome. A bare `toHaveBeenCalled()` passes with the wrong arguments.
- Problem (inferred): the 33-member seam exists mainly so the test can reach in.
- Fix: test the task keymap through `mountScreen` (`features/tasks/screenHarness.tsx`) on a real store, asserting board state and the commands the transport received, then shrink `TaskCommandDeps` to the real collaborators. Replace bare `toHaveBeenCalled()` with `toHaveBeenCalledWith(<expected>)` or a state assertion. Do this incrementally.
- Category: tests / simplify. Effort: L. Risk: medium.

### F15. Risky logic with thin or no direct coverage
- Where/Problem (observed):
  - `packages/components/src/Modal/Modal.ts` (1,805 lines) and `ModalInteractions.ts` (631) have one 81-line test file that covers focus restore only (`Modal.test.tsx`). Meanwhile 15 app test files mock `modals` (F8), so the modal stack, Escape and close order are barely exercised.
  - `Select`, `Autocomplete`, `Tooltip` (389 lines), `Toast`, `Resizable`, `Table` have no tests.
  - The `Transport` contract between the fake and the real daemon, the route contract (F12), and MobX reactivity (F5) have no test at all.
  - The daemon is well covered: migrations by version in `test/storage.test.ts:49+`; guards, with 403 cases, in `test/http.test.ts`.
- Fix: add behavior tests for the Modal stack (open two, Escape closes the top, close order, focus return, `animate: false`) and for Select/Autocomplete keyboard selection in `packages/components`. Add the contract tests in F6 and F12.
- Category: tests. Effort: M. Risk: low.

### F16. Two fake ACP agents parse the same directive language separately
- Where: `apps/daemon/test/fake-acp-agent.ts` (796 lines, 24 `case` directives) and `fake-acp-agent-v2.ts` (1,820 lines, 40 cases); 21 directive names are shared (`say`, `tool`, `perm`, `usage`, `limit`, `fail`, `sleep`, `crash`, ...). The v2 header says it "takes the directives of `fake-acp-agent.ts` that apply".
- Problem: a directive added or fixed in one agent silently differs in the other, and the 163 tests in `acp-session.test.ts` run over both (`PROTOCOLS = ['v1','v2']`, `acp-helpers.ts:17`).
- Fix: extract the prompt-directive parser into `test/fake-acp-directives.ts`, returning a typed list of steps. Each agent then only maps steps onto its protocol's wire messages.
- Category: tests / reuse. Effort: M. Risk: low.

### F17. The component catalog is incomplete, and its rules are not followed, so agents do not reuse components
- Where: `packages/components/AGENTS.md:45-93` lists 47 rows. Folders missing from it: `AngleControl`, `AsChild`, `ButtonUpload`, `Card`, `Checkbox`, `CodeHighlighter`, `CodeInput`, `Collapsible`, `FileDropOverlay`, `FileUploadZone`, `GradientStopRange`, `Hotkey`, `HoverCard`, `LayoutGridControl`, `Lottie`, `Radio`, `Resizable`, `RichInput`, `Shimmer`, `Slot`, `SortableList`, `Tag`, `Terminal`, `Textarea`, `modals`. Rules at `:6-41` ("Prefer For, Show, Box, Text"). `packages/lib/AGENTS.md` omits 9 modules (F4 row 13).
- Problem (observed): the renderer has 324 `<div` against 27 `<Box`, and 53 JSX `.map(` against 21 `<For` in `apps/desktop/src/renderer`. The guide's rule is not followed, and a quarter of the components cannot be found from the guide.
- Problem (inferred): this is one cause of the "reinvents what the design system has" pattern the refactor targets.
- Fix: generate the catalog from the folder list plus one line each, with a check in the components lint that every exported folder has a row. Decide whether For/Show/Box is a rule for the app. If it is, enforce it (a Biome rule or review checklist). If not, scope it to `packages/components`. Complete the lib module list.
- Category: docs / design-system. Effort: S. Risk: low.

## Cross-area notes

- **Protocol testing helpers.** Typed entity builders (`aChat`, `aRun`, `aTask`, `aStreamItem`) belong in `packages/protocol` (for example a `@clowdy/protocol/testing` subpath), so the renderer tests, the fixture world and the daemon tests stop hand-writing partial entities (F7).
- **Daemon/renderer contract.**
  - Make the daemon router derive from, or be checked against, `ROUTES` in `packages/protocol/src/api.ts` (F12).
  - Daemon rules that the fixture daemon copies (task status sync, edit refusal, fork cut) should become pure functions in `packages/protocol` that both import, or be covered by shared scenarios (F6).
- **Production bundle.** `FixtureTransport` and about 8.9k lines of fixture data are statically reachable from `root.ts` → `createTransport` (likely shipped; confirm with a build). A dynamic import keeps them out (F6).
- **`packages/lib` dead or parallel code (observed, not my area).** `packages/lib/src/localstorage.ts` (`localStorageService`) and `date.ts`'s `formatRelativeDate`/`formatChatDayLabel` have no users. The renderer has its own `stores/storage.ts` (`KeyValueStorage`) and `shared/time.ts`. Hand this to the reuse/dead-code research.
- **Package view tests.** `@clowdy/file-manager`'s `FileManagerView` is tested only from the app (`apps/desktop/src/renderer/features/files/FileManagerView.test.tsx`). Moving that suite into `packages/file-manager/specs` would keep the package self-checking.
- **Design rule violations to hand to the design-system research.** `shell/CloneRepositoryForm.module.css:82` and `shell/CloneRepositoryForm.tsx:390` (type weights); the 7 `observer()` wrappers (F4 row 4).
- **Skills in the session.** The `mobx`, `react-best-practices` and `feature-sliced-design` skills describe Reforma (`apps/front`), not this repository. That is a related source of misleading guidance for agents.

## Not inspected / limits

- No suite was run (per the rules), so there are no runtime numbers or flake rates. The sleep totals are sums of literal values, and the renderer's real-time `settle`/`wait` total is an estimate from call counts and helper defaults.
- Whether the fixture code ships in the production bundle is inferred from the static import; no `dist/` was present to grep.
- The merge-hotspot counts come from `git show --cc --name-only` on the last 150 merges. A file in that list was edited on both sides; this does not prove a textual conflict.
- The guide claims were sample-checked (30 claims), not checked exhaustively. The "Keep or drop" judgments in F11 and F14 are pattern counts plus spot reads, not a per-test audit.
- `packages/components`, `packages/file-manager` and `packages/protocol` tests were sized but read only briefly. `packages/icons` script tests were not reviewed.
- `DESIGN.md` and `apps/desktop/RELEASING.md` were not checked against the code beyond the cross-references above.
