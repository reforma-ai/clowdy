# App review and refactor

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit.
> Record scope changes before leaving the stage.
> Record landed commits and their checks under the stage they implement.

**Goal:** make the whole app simple, reusable, safe and fast for the agents who change it next, with the renderer built on the design system instead of beside it.

**Approach:** research is in `research/` (start at `research/index.md`; findings are cited as `<page> F<n>`). Wave 1 runs six independent stages in parallel: the design-system foundation, the renderer data layer, two daemon stages, shared packages, and the Electron shell on its own branch. Wave 2 migrates the renderer features onto the new components, one stage per feature area. Wave 3 unifies the daemon-renderer contract, tightens lint, rewrites the guides and verifies the whole.

**Decisions** (autopilot, 2026-11-27; the owner was asleep and asked for no questions)

- **Branches.** All work lands on `clowdy/full-app-refactor` (worktree `/Users/bionic/Clowdy/workspaces/clowdy/0DCP3E70/clowdy`). Each stage thread works in a worktree of its own, branched from it, and commits there; the coordinator merges it back with a merge commit and runs the checks. Nothing is pushed or merged into `next`; the owner does that. Revisit: never, this is the owner's rule for Clowdy's own repo.
- **Shell paths stay out of the main branch.** A change to a path in `SHELL_PATHS` (`apps/desktop/scripts/publish-ota.ts`: main, preload, shared, the build, `packages/protocol/src/paths.ts`, `packages/constants/src/theme.ts`) or to `PROTOCOL_VERSION` holds every OTA bundle until a new shell is released. Such changes go to the separate branch `clowdy/refactor-shell`, so the main refactor ships as an OTA bundle and the shell work ships with the next shell release. Revisit when the owner plans a shell release anyway.
- **Stored data.** Only additive migrations an older daemon can still open (an index, never a dropped column or rewritten rows). Event log retention and delta events (daemon-core F1) are not done here: they change the resync contract and need a design; they become a follow-up task. Revisit with that design.
- **Delete the unused forked code.** Reforma parity is not a goal (NOTICE: the adapted code is Clowdy's own). Unused components, `packages/lib` modules and their dependencies are deleted after a grep across `apps/` and `packages/` proves zero use. Revisit if a feature needs one: copy it again from Reforma.
- **Design system first, one way per pattern.** A pattern the renderer repeats becomes one component in `packages/components` (generic) or `apps/desktop/src/renderer/shared` (Clowdy-specific); existing components are extended rather than paralleled (`PanelEmptyState` gets a `label`, not a new `EmptyState`). The renderer keeps no hand-made chips, empty or loading states, dialog presets, fold buttons, row controls, focus rings, progress bars or settings rows.
- **Styling rule.** Components and their props first; CSS modules only for layout and the feature's own look, with tokens only (no raw colors, durations, easings, opacities, z-index or shadows); a CSS module is imported only by its own component; one focus ring (a `packages/styles` ruleset). UnoCSS stays as it is (out of scope).
- **The renderer token holder is trusted.** Terminals and custom agents already run commands for it, so the daemon guide's "untrusted renderer" wording is corrected rather than adding confirmations. Revisit if the daemon ever serves a remote client.
- **A disabled user skill is not loaded by agents** (daemon-edges): the switch says off, so off means off.
- **Fixture daemon.** It leaves the production bundle now (renderer-state F6 step 1). Replacing it in tests with the real daemon is a follow-up.
- **Tests.** The renderer's Vitest config gets the MobX observer plugin the app build uses, and a shared test kit; each stage adopts the kit and drops stale `Modal` mocks in the test files it touches. Tests belong to the stage that owns the code. The baseline failures are fixed, not skipped.
- **Guides.** Each package `AGENTS.md` becomes a compact guide (target 15 KB or less: layout, rules, invariants, traps, commands, test policy); feature behavior moves to domain pages under `.clowdy/docs/desktop/` and `.clowdy/docs/daemon/`; what the code already states (UI copy, key lists, migration numbers, file inventories) is dropped. GITFLOW's branch policy is left to the owner.
- **No visual redesign.** Migrations keep the look; small visual changes that come from adopting the design system (one focus ring, token shadows) are accepted.

**Reuse:** `packages/components` (catalog in `research/design-system.md`), `packages/styles` tokens, `@clowdy/lib` (`errorMessage`, `isRecord`), `domain/workspaces.ts` `SYNC_READ_TIMEOUT_MS`, `files/service.ts` TTL cache.

**Scope change (2026-11-27, 08:00 UTC).** The subscription's 5-hour usage limit stopped every agent from about 04:20 to 08:00 UTC, leaving about 3.5 hours and one quota window. Stages 5 and 6 are deferred untouched (`CLO-230`, `CLO-231`). Stage 1 Part 2 (dead forked code, design-system docs) is dropped unless time remains. Stages 2, 3 and 4 are narrowed to defects, freezes and hot paths (the thread messages list the kept findings; the big file splits are left). Stages 7-9 keep design-system adoption and the top performance items. Stage 10 is deferred. Stage 11 keeps the final verification; the guide rewrite is reduced to what time allows.

## Out of scope

- Event log retention and delta events (follow-up).
- Replacing the fixture daemon in tests (follow-up).
- A visual redesign, new features, UnoCSS changes, the GITFLOW branch policy.
- Merging into `next`, pushing, releasing.

## Stage 1 — Design-system foundation

**Depends on:** None.

**This stage:** gives the renderer the components and tokens it keeps rebuilding, so wave 2 can migrate onto them. Generic pieces go into `packages/components` and `packages/styles`; existing components are extended. It also fixes the design system's own defects that the migrations would inherit (Modal accessibility, Badge as a grid, Button disabled tooltip, FormField with Textarea). A second part deletes unused forked code and corrects the design-system docs.

- [ ] Complete
  - [ ] Tokens: focus ring ruleset and token, float shadow with dark remap, `--ease-ui`/`--ease-out`, visually-hidden ruleset; `--color-secondary-text` usages pointed at the existing muted token
  - [ ] Components: `Chip` (one tone map), `Badge` as a plain span, Button `disabledReason` and expanded look and default `aria-label` from a string tooltip, `SplitButton`, `ProgressBar`/`Meter`, `FoldButton`, row controls (`RowControls`, `RowActionButton`), `ItemRow`, `DiffStat`, `PathText` (start truncation), `ContextMenuPopover` and `useRowContextMenu`, single-value `ToggleButtonGroup`, `VisuallyHidden`, `label` on `PanelEmptyState`/`PanelLoadingState`, Card float surface, settings kit in `SettingsLayout` (`SettingsField` rebased or deleted)
  - [ ] Dialogs: Modal with `role="dialog"`, accessible name and focus containment; `openFormDialog` preset; `DialogLayout`; exported z constants; `ConfirmModal` `isConfirmDisabled` and dismissal blocked while pending
  - [ ] FormField + Textarea prop leak fixed; callback refs stable in Button, Input and lists
  - [ ] Part 2: unused forked components and their dependencies deleted; `packages/components/AGENTS.md` catalog, Scrollable docs, icons README and DESIGN.md match the code

**Files**

- `packages/components/src/**`, `packages/styles/**`, `packages/icons/README.md`, `DESIGN.md` — owned by this stage.

**Done when:** the components above exist with tests where they hold logic, the renderer still builds and its tests pass unchanged, and the catalog lists every live component.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/components --filter=@clowdy/styles --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 2 — Renderer data layer

**Depends on:** None.

**This stage:** makes the renderer's data layer correct under streaming and cheap per event, and removes its duplicated mechanisms, so the feature stages can fix rendering on top of it. Covers `renderer-state` F1-F10, F12-F16, the draft stores (`ui-chats-stream` F2, `ui-tasks-agents-panels` F11 store side), store-level caches the views need (`ui-tasks-agents-panels` F9: assigned runs by task, status by id), the theme-driven `FileIconColorScheme` provider, the fixture daemon out of the production bundle, the MobX observer plugin in Vitest with a shared test kit, and the baseline test failures.

- [ ] Complete
  - [ ] Event feed: no leak or skipped event on a handler error, stalled-stream detection from the heartbeat
  - [ ] Stream store: incremental updates (no copy and sort per event), bounded retention of closed streams
  - [ ] Indexes and selectors: task by key, runs by task and by parent, one visible-selection derivation
  - [ ] One SSE reader, one backoff, one latest-request-wins helper; one preference pattern; drafts in one store, persisted without a write per keystroke
  - [ ] Branch-prefix sync stops retrying forever and no longer breaks the fixture tests
  - [ ] Fixture daemon not in the production bundle
  - [ ] Vitest with the MobX observer plugin; shared test kit
  - [ ] `RootStore` and `ProjectUi` split by concern

**Files**

- `apps/desktop/src/renderer/{daemon,stores,hotkeys}/**`, `stream/StreamStore.ts`, `stream/turns.ts` and other non-visual `stream/` modules, `root.ts`, `main.tsx`, `theme.ts`, `updateOffer.ts`, the draft modules (`features/chats/composerDrafts*`, `stores/NewChatDrafts*`), `apps/desktop/vitest.config.ts`, `apps/desktop/vite.config.ts`, a new test kit folder. Mechanical call-site edits in `features/**` are allowed and listed in the report.

**Done when:** a streamed chunk costs work proportional to the chunk, not the run; the renderer suite is green with the observer plugin; the production renderer bundle has no fixture daemon.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 3 — Daemon core

**Depends on:** None.

**This stage:** removes the daemon's per-chunk and per-client waste, the blocking git work inside write transactions, and splits the oversized run and workspace modules by concern. Covers `daemon-core` F2-F8, F10, F12-F15 and the failing replay test; F1, F9 and F11 are not part of it.

- [ ] Complete
  - [ ] Streaming flush and chunks reuse what the caller has; SSE fan-out serializes once per event
  - [ ] `chat.create` and threads with a worktree do no sync git inside the transaction; restart recovery kills survivors in parallel and outside the transaction
  - [ ] `RunService`, `RunDriver`, `workspaces.ts`, `routes.ts` split by responsibility; one base-to-commit resolver
  - [ ] Index for item lookups by kind if additive and safe for older daemons
  - [ ] Small duplicates, prompt-suggestion state, startup cleanup, needless exports

**Files**

- `apps/daemon/src/{http,runs,engine,domain,db}/**` and the src root files, except `domain/git.ts`; their tests in `apps/daemon/test`.

**Done when:** the daemon suite is green and no sync git runs inside a transaction.
**Verify:** `cd apps/daemon && bun run typecheck && bun test && bun run lint`
**Commits:** None yet.

## Stage 4 — Daemon edges

**Depends on:** None.

**This stage:** gives the daemon one process runner, one environment filter, one path-containment check, one settings-file writer, one TTL cache and one set of git helpers, adds timeouts where a hung child freezes the daemon, and cuts the git process count per request. Covers `daemon-edges` F1-F26 (F24 only if safe) and the disabled-skill decision.

- [ ] Complete
  - [ ] Timeouts on every sync git call; docs tree cached and async; terminal log writes async; Windows kill fixed
  - [ ] One runner, env filter, containment check, settings writer, TTL cache; git write plumbing shared
  - [ ] Git process count per status/viewed request cut; `GET /git` parallel; `gitLine` reports unavailable instead of "no"
  - [ ] File manager refuses `.git`; ripgrep keeps `..`-prefixed names; Windows argv limit handled
  - [ ] Disabled user skills not loaded; dead user-plugin mirror removed
  - [ ] Big git files split after consolidation

**Files**

- `apps/daemon/src/{git,fs,files,terminals,providers,skills,commands,cli,attachments,docs}/**`, `apps/daemon/src/domain/git.ts`; their tests.

**Done when:** the daemon suite is green and each duplicated mechanism above has one implementation.
**Verify:** `cd apps/daemon && bun run typecheck && bun test && bun run lint`
**Commits:** None yet.

## Stage 5 — Shared packages and tooling

**Depends on:** None.

**This stage:** brings `packages/lib`, `packages/file-manager`, `packages/constants` (outside `theme.ts`) and the dev scripts in line with their users: dead modules deleted, traps removed, one Windows file-name rule. Covers `platform-shared` F8-F10, F13, plus file-manager items in its scope.

- [ ] Complete
  - [ ] Unused `packages/lib` modules deleted; `extname` fixed; MobX-named helper renamed; one `clamp`; guide matches exports
  - [ ] One Windows file-name helper; call sites outside the stage listed for integration
  - [ ] `scripts/dev.ts` stops parsing Vite output
  - [ ] File manager: duplication with the app removed inside the package

**Files**

- `packages/lib/**`, `packages/file-manager/**`, `packages/constants/**` except `src/theme.ts`, root `scripts/**`, `apps/desktop/scripts/**` except the shell paths.

**Done when:** every package builds and tests green, and `packages/lib/AGENTS.md` lists only exported, used helpers.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/lib --filter=@clowdy/file-manager --filter=@clowdy/constants --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 6 — Electron shell (branch `clowdy/refactor-shell`)

**Depends on:** None.

**This stage:** tightens the shell where it matters for safety and size, on a separate branch because it needs a shell release. Covers `platform-shared` F1-F6, F11, F12, F16, F17; F18 is left to the owner.

- [ ] Complete
  - [ ] Main imports a small pure shell part of the protocol; the OTA gate watches it
  - [ ] One sender check for every IPC handler; dead find bridge removed; main's failure reasons reach the renderer
  - [ ] One external-link policy; tests for the security-critical main code; `main/index.ts` split

**Files**

- `apps/desktop/src/{main,preload,shared}/**`, `apps/desktop/scripts/publish-ota.ts`, `packages/protocol/src/shell.ts` (create: the shell contract cannot stay in the barrel main imports today), `packages/protocol/src/paths.ts`.

**Done when:** the shell branch builds, its tests pass, and main's bundle no longer contains zod.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/desktop --filter=@clowdy/protocol`
**Commits:** None yet.

## Stage 7 — Chats, stream and shell UI

**Depends on:** Stage 1, Stage 2.

**This stage:** fixes the streaming re-renders in the views and moves chats, the stream, the app shell and `renderer/shared` onto the design system. Covers `ui-chats-stream` F1, F3-F13, F15-F22 (F14 is Stage 10) and `ui-tasks-agents-panels` F15 (shared layering).

- [ ] Complete
  - [ ] A streamed chunk re-renders only the streaming message; long chats skip off-screen work
  - [ ] Pills, chips, cards, progress, rename, stop, empty and loading states, alerts on the design system
  - [ ] `Composer` and `ModelPicker` split; `stream/` no longer imports features; `shared/` holds no feature imports

**Files**

- `apps/desktop/src/renderer/features/chats/**`, `stream/**` view files, `shell/**`, `shared/**`, `App.tsx`, `base.css`, `styles.ts`.

**Done when:** the renderer suite is green and no hand-made version of a stage-1 component remains in scope.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 8 — Tasks, agents and panels UI

**Depends on:** Stage 1, Stage 2.

**This stage:** moves tasks, the agents list, side panels, quick search, files, terminal and worktrees onto the design system and takes the agents list model out of render. Covers `ui-tasks-agents-panels` F1-F14, F16-F25.

- [ ] Complete
  - [ ] Detail rows, task references, chips, fold buttons, row controls, empty states, dialogs on the design system
  - [ ] `AgentList` model derived outside render; Tasks screen uses store caches
  - [ ] Worktree dialogs keep no JSX in state and use `ConfirmModal`

**Files**

- `apps/desktop/src/renderer/features/{tasks,agents,sidePanel,quickSearch,files,openWith,terminal,worktrees}/**`.

**Done when:** the renderer suite is green and no hand-made version of a stage-1 component remains in scope.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 9 — Settings and Changes UI

**Depends on:** Stage 1.

**This stage:** moves Settings onto the one settings kit and Changes onto shared file rows, split button and row menu, and moves the merge dialog and commit box logic out of the views. Covers `ui-settings-changes-css` F1-F24.

- [ ] Complete
  - [ ] Settings on `SettingsLayout`; edit-on-blur fields and async states shared
  - [ ] Changes: one changed-file row, one split button, one row menu, one observer for visibility
  - [ ] `BranchMergeDialog` and `CommitBox` state machines out of the views; dead code removed

**Files**

- `apps/desktop/src/renderer/features/{settings,changes}/**`, `apps/desktop/src/renderer/hotkeys/**` view parts if any.

**Done when:** the renderer suite is green and no hand-made version of a stage-1 component remains in scope.
**Verify:** `bunx turbo run build lint typecheck test --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 10 — One daemon-renderer contract

**Depends on:** Stage 2, Stage 3.

**This stage:** makes `packages/protocol` the single source of request shapes and command results, so the daemon and the renderer cannot drift. Covers `daemon-core` F11, `platform-shared` F7, `renderer-state` F11, `ui-chats-stream` F14 (structured usage-limit pause) and F3 (tool-call count on the run).

- [ ] Complete
  - [ ] Request schemas live in the protocol; the daemon validates with them; the renderer uses the inferred types
  - [ ] Typed command results; usage-limit pause and tool-call count carried as data

**Files**

- `packages/protocol/src/**` except `paths.ts`, `apps/daemon/src/http/**` schemas, `apps/desktop/src/renderer/daemon/**` types.

**Done when:** no request or result shape is declared twice.
**Verify:** `bunx turbo run build lint typecheck test`
**Commits:** None yet.

## Stage 11 — Lint, guides and final verification

**Depends on:** Stages 1-5, 7-10.

**This stage:** turns on unused-code lint across the repo, rewrites the guides into compact rules plus domain pages, merges the latest `next`, and verifies the integrated branch end to end with the app built and started against a scratch daemon.

- [ ] Complete
  - [ ] Biome `noUnusedImports` and `noUnusedVariables` on, findings fixed
  - [ ] Package guides 15 KB or less; domain pages under `.clowdy/docs/`; root guide layout current
  - [ ] Latest `next` merged; full checks green; app started from the worktree with a scratch data folder

**Files**

- `biome.json`, every `AGENTS.md`, `.clowdy/docs/**`, `README.md`, `DEVELOPING.md`.

**Done when:** the full checks are green on the merged branch and the app starts and streams a chat against a scratch daemon.
**Verify:** `bunx turbo run build lint typecheck test`
**Commits:** None yet.
