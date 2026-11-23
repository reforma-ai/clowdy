# The chat list, a place for the card, and what can trigger it

## Summary

The left column of the Agents screen is `AgentList` inside a `Panel` (a flex column): a heading, then one scrolling `PanelContent` that holds the whole list. There is no footer slot and nothing sits under the scroll area, so a card at the bottom is a new sibling after `PanelContent`. Per-install flags are kept in the page's `localStorage` through small singletons or injected `KeyValueStorage` (`readStored`, `writeStored`); `ChatListPreferences` is the cleanest pattern to copy. No first-launch time and no usage counter exist; the nearest existing facts are the personal project's `createdAt` (the daemon's first start, in the root snapshot) and `ProjectState.chats` (only for projects loaded in this session). There is no dismissible promo, banner, or hint pattern in the renderer to copy: the card would be the first.

Reading note: `AgentList.tsx`, `AgentList.module.css`, `Screen.tsx`, `Screen.module.css` were read as committed. `git status` at the start and the end of this research listed only `packages/components/src/MarkdownEditor/markdownDocument.ts` as modified.

## The list and where the bottom is

- `features/agents/Screen.tsx`: `SidebarLayout screen="agents" defaultWidth={ 270 } sidebar={ <AgentList … isCovered={ expanded } /> }`. `shared/SidebarLayout.tsx` is a resizable panel group (min 220, max 480 px, `shared/sidebarWidth.ts`, remembered per screen under `clowdy:sidebar-width:agents`); its `.sidebar` is a flex column with `overflow: hidden` and `--panel-width: 100%`.
- `features/agents/AgentList.tsx` returns `<Panel side="left" className={ isCovered ? styles.covered : undefined }>` with:
  - `SidebarHeading` (project select as the title, `ArchiveButton`, `FilterMenu` `⋯`), margin 12 px (`.heading`),
  - `PanelContent contentClass={ styles.content }` (padding `--spacing-md`, 8 px) holding a `GridList` of rows: the "New chat" row (`NEW_CHAT_ROW`), then the folder group headings, chats and threads, or the "No chats" note, from `entries`,
  - a conditional `Popover` for the right-click chat menu (portal, not in flow).
- `Panel` (`packages/components/src/Panel/Panel.tsx`) is `aside`, `display: flex; flex-direction: column; height: 100%`, 1 px right border. `PanelContent` is `Scrollable` with `height: 100%`; `Scrollable`'s root has `overflow: hidden` (min height can shrink) and its container is `overflow-y: scroll` with hidden scrollbars (custom scrollbar chrome). A sibling after `PanelContent` should therefore stay at the bottom while the list scrolls above it; I did not try it in a running window.
- The "covered" variant: when the expanded side panel takes the chat's place (`useSidePanel().expanded`), the list is a plate of its own (`.covered`: 1 px border, `--plate-radius` and squircle corners, `overflow: hidden`). A card inside the `Panel` is clipped by it and needs no special case. Beside the chat, the column's right border is the divider (`Panel`).
- Neighbors that influence a bottom card: the right rail (`SidePanelRail`) is at the window's right edge and the title band is across the top; nothing is at the bottom-left today. The usage indicator (`shell/UsageStatus.tsx`) is in the title band (`TitleBand.tsx`), not in the list.
- `AgentList` (through `Screen`) is the only user of `SidebarLayout` today; `docs` appears only in `sidebarWidth.test.ts`. When no project is selected the window shows `NoProject` and there is no list: the card would not show there.
- Tests: `features/agents/Screen.test.tsx` renders the screen (the list included) with a fixture daemon; a card added to `AgentList` appears in those renders unless it is off by default.

## Per-install flags: how they are persisted

- Everything lives in `localStorage` of the origin `app://clowdy`, inside Electron's `userData` folder (`Clowdy`, `Clowdy Dev` in a development run; shared by all windows). It survives updates and reinstalls (`deleteAppDataOnUninstall: false` in `electron-builder.ts`), is separate for the dev profile, and is not seen by the daemon. A relaunch for an OTA update calls `session.flushStorageData()` first (`index.ts`), because `app.exit` would skip writing it.
- `stores/storage.ts`: `KeyValueStorage` (`getItem`, `setItem`, `removeItem?`), `browserStorage()` (the `localStorage` or `undefined` when blocked), `readStored(storage, key)` (parsed JSON or `undefined`), `writeStored(storage, key, value)`, `removeStored`. All swallow errors: "Storage is a convenience".
- `RootStore` takes `storage` in its options (default `browserStorage()`) and passes it to `UiStore` (per-project window state under `clowdy:ui:<projectId>`) and `readStored`/`writeStored` the selected project (`clowdy:selected-project`). Tests pass `{ storage: undefined }` or a memory object.
- Global singletons, the pattern for a flag of this computer: `features/agents/chatListPreferences.ts` (`ChatListPreferences`: `makeAutoObservable`, a constructor reading the keys, setters that write, `export const chatListPreferences = new ChatListPreferences(browserStorage())`, default semantics such as `readStored(...) !== false`), `features/changes/sidebarLayout.ts`, `features/openWith/openWithPreferences.ts`, `features/sidePanel/panelWidth.ts`. `theme.ts` reads `localStorage` directly.
- Existing keys, all `clowdy:`-prefixed: `theme`, `chat-sort`, `show-finished-threads`, `side-panel-width`, `sidebar-width:agents`, `changes-sidebar-open`, `changes-sidebar-width`, `default-editor|terminal|file-manager`, `selected-project`, `files-show-hidden`, `files-tree-open|width`, `branch-prefix`, `chat-mode`, `enter-while-busy`, `swipe-to-reply`, `new-chat-engine|mode`, `model-choice`, `ui:<projectId>`, and per-file tabs. A new key would be `clowdy:<name>` holding a boolean or a number (epoch ms).
- Pitfall: a singleton built with `browserStorage()` at import time reads the happy-dom `localStorage` in tests; tests of the class use `new Class(memoryStorage)` (see `chatListPreferences.test.ts`), tests of a component that imports the singleton share state across tests.
- Settings that must live with the data (project and agent settings, chat-title switches) go through the daemon protocol instead (`packages/protocol`), which would also need a daemon change and a protocol decision. Not needed for a one-time card.

## What exists to measure "used the app a while"

- **First launch or install time: not recorded.** Searched the renderer stores, main process, and daemon for a first-run, installed-at, launch-count, or first-seen value: none. A new `localStorage` key would start counting at the first launch of the build that has it (for an existing install that is the update, not the real install).
- **Age of the daemon's data: available.** `RootSnapshot.projects` (`packages/protocol/src/events.ts`, loaded by `RootStore.load()` into `RootStore.projects`) holds the personal project (`Project.personal: true`, created by the daemon at its first start, `ensurePersonalProject` in `apps/daemon/src/domain/projects.ts`), whose `createdAt` is the real age of this person's Clowdy data, including installs older than the card. Gotchas: a separate dev profile has its own database; deleting the data resets it; `Project.createdAt` is on every project (the earliest is the age).
- **Chats: per loaded project only.** `RootSnapshot` has no chat counts. `RootStore.selectProject` creates a `ProjectState` and loads its snapshot only for a selected project (`#states`), so the renderer sees the chats of the selected project and of projects selected earlier in the session. `ProjectState.chats: Map<ChatId, Chat>` includes threads (`parentChatId`), archived chats (`archivedAt`), and forks; `chatList` is all of them sorted by `updatedAt`. `Chat` has `createdAt`, `updatedAt`, `orchestratorRunId` (set when the first message started a run). A new-chat page is not a chat until the first message (`ui.draft`).
- **A finished turn.** `Run` (`packages/protocol/src/domain.ts`) has `status` (`RunStatus`, terminal ones `succeeded`, `failed`, `cancelled`, `interrupted`), `createdAt`, `startedAt`, `finishedAt`. A chat's orchestrator run is in `ProjectState.runs` (`orchestratorOf(chat, runs)` in `agentTree.ts`). Whether `succeeded` means "answered a turn" or only the end of a session was not checked.
- **Counters across projects need new data.** An app-wide count of chats or messages would need a daemon route or a renderer counter incremented on events; neither exists.
- Real options, with what each needs: (a) wall-clock days since a stored first-seen timestamp (new key, shows on update for old installs only after the delay); (b) days since the personal project's `createdAt` (no new state, true age, may show at once for an old install); (c) at least N chats, or N chats with a finished turn, in the loaded projects (new derived getter, depends on the project loaded); (d) a launch counter (new key, incremented at start); a combination (age and a chat that has answered). Cross-checks are cheap: all inputs are in `RootStore` after `load()`.

## Dismissible patterns in the renderer

- None is dismissible-and-remembered. Closest shapes: `shell/SyncBanner.tsx` (a status pill in the title band, driven by `root.bannerVisible`, not dismissible); `features/chats/ReadOnlyNotice.tsx` and `ReadOnlyNotice.module.css` (a calm bordered plate with an icon, two lines, and action buttons, in place of the message box); `packages/components/src/Alert` (`Alert`, `AlertIcon`, `AlertDescription`, `AlertAction`, tints `primary`/`accent`/`success`/`warning`/`danger`) used in `ProvidersPage`, `SkillsSection`, `ArchiveView`, `OpeningTask`, `stream/ErrorLine.tsx`; `ComposerBanner` (status rows above the composer); the sticky update toast in `root.ts` (`toast.info({ timeout: 0, action })`, closed by its own control).
- There is no onboarding, tips, "seen" flag, or welcome flow; the empty states are `NoProject.tsx` and `SettingsEmpty`.
- A close control would be `Button iconOnly variant="filling" size="xs"` with the 14 pack's `Close` icon (rows already use `size="xs" iconOnly` buttons in the list, `AgentList.tsx` `RowEnd`); the press must not reach the list's row events (the list's rows use `ownEvents` to stop clicks, but a card outside the `GridList` does not need them).
- Link: a `Button` with `href` and `target="_blank"` to `https://github.com/<repo>` (one open per second). The repo comes from the bridge or the menu path; in a dev run it is empty, so the card has nothing to link to and should not show.

## Constraints

- Text rules: UI phrases end without a period (root `AGENTS.md`).
- The card must not break keyboard flow in the list: `AgentList` registers hotkeys with `useHotkeyScope(AGENTS_SCOPE)` and `agentCommands` over the list's element (`list.current`); a card is outside that `div`.
- The card is renderer code (OTA-able), but its repo link and dev-run absence depend on the bridge (shell change).
- Sizes: the column can be 220 px wide; a bottom card takes list height in a short window (the minimum window height is 600 px).

## Relevant files

- `apps/desktop/src/renderer/features/agents/Screen.tsx`, `Screen.module.css`, `AgentList.tsx`, `AgentList.module.css`, `Screen.test.tsx`
- `apps/desktop/src/renderer/shared/SidebarLayout.tsx`, `SidebarLayout.module.css`, `sidebarWidth.ts`
- `packages/components/src/Panel/Panel.tsx`, `Panel.module.css`; `Scrollable/Scrollable.module.css`
- `apps/desktop/src/renderer/stores/storage.ts`, `RootStore.ts` (`load`, `selectProject`, `projects`), `ProjectState.ts` (`chats`, `runs`, `chatList`), `UiStore.ts`
- `apps/desktop/src/renderer/features/agents/chatListPreferences.ts` (+ `.test.ts`) — the pattern to copy
- `packages/protocol/src/domain.ts` (`Project`, `Chat`, `Run`), `events.ts` (`RootSnapshot`), `apps/daemon/src/domain/projects.ts` (`ensurePersonalProject`)

## Open questions

- Which measure counts as "used a while" (see the options above)? And should an old install, which has data older than the card, see the card at once?
- Does closing the card, clicking it, and the menu item all set the same flag? Does a menu click reach the renderer?
- Is the card shown while the repo is private (the link would 404 for others)? The brief says the link comes from the baked repo, so it is hidden whenever the repo is empty.

## Assumptions and limits

- Not run: the app, the list with a card in place, or any test.
- `Run.status` semantics for a finished turn, and whether `Chat.createdAt` is set for a chat with no run, were not traced through the daemon.
