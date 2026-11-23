# Settings pages: how a page is declared, routed, and tested

## Summary

Settings is a dialog over the app (not a screen). A page is one entry in three places: the `SETTINGS_PAGES` tuple (`stores/UiStore.ts`, which defines the `SettingsPage` type), the `PAGES` array of `SettingsWindow.tsx` (label, sidebar group, icon, render function), and two tests that assert the list of labels by exact equality. `ShortcutsPage` (read only, a card per group of rows) is the closest pattern for an informational page like About. Links in the app are `Button` with `href` and `target="_blank"`, and they reach the system browser through `lockNavigation`. Nothing in `spec.md` (the file does not exist in this tree) or `DESIGN.md` lists the pages; `apps/desktop/AGENTS.md` describes them in prose.

## How it works

- **Window.** `SettingsDialog.tsx` is a `Dialog` (`@clowdy/components/Modal`, `type="overlay"`) open while `UiStore.settingsOpen`; Esc, a click outside and the close button call `ui.closeSettings()`. It holds `SettingsWindow`, which is mounted by `shell/Shell.tsx` beside the rail, the title band, and the find bar.
- **Routing.** `UiStore` (`stores/UiStore.ts`): `settingsOpen`, `settingsPage` (default `'appearance'`, not persisted, so it resets every launch), `settingsProjectId`, `openSettings(page?)`, `closeSettings()`, `showSettingsPage(page)` (resets the Projects stack), `openProjectSettings(projectId?)`. Callers elsewhere: `shell/shellCommands.ts` (`help.open` opens `'shortcuts'`, `settings.open` opens the last page), `shell/UsageStatus.tsx` and `features/chats/ReadOnlyNotice.tsx` (`'providers'`), `features/sidePanel/SidePanelRail.tsx` (the Settings button at the bottom of the rail). Settings is not a history place (`NavHistory` ignores it; `UiStore.restore` closes it).
- **Declaration.** `PAGES: readonly PageView[]` in `SettingsWindow.tsx`; each is `{ id: SettingsPage, label, group, icon, render }`. `SettingsLayout` (`packages/components/src/SettingsLayout`) takes `items={ PAGES }`, `selectedId`, `onSelectedChange`; consecutive items with the same `group` share one heading. The page's title is the item's `label`; the text under it is the page's own `SettingsPage description` (`SettingsLayout.Intro`). `SettingsLayout.Content` takes `headerRight` for a page action (only Projects uses it).
- **Current order, groups, icons** (`SETTINGS_PAGES` order must match):

| id | label | group | icon |
| --- | --- | --- | --- |
| `appearance` | Appearance | General | `PaintBucket` (14) |
| `chat` | Chat | General | `Message` |
| `files` | Files | General | `Page` |
| `shortcuts` | Shortcuts | General | `Keyboard` (16, `size={ 14 }`) |
| `projects` | Projects | Workspace | `Folder` |
| `providers` | Providers | Agents | `Robot` |
| `skills` | Skills | Agents | `Book` |

Icons for an About page: `Info`, `ArrowUpRight` (both in the 14 pack), and `Github` (`@clowdy/icons/logo`) exist; there is no star icon in the 14 pack (`ai-star`, `token-star..` are other glyphs).

- **Page building blocks** (`features/settings/ui/`): `SettingsPage` (the body: description at the top, then blocks 24 px apart), `SettingsSection` (`title`, optional `aside`, `description`), `SettingsCard` (`divided`, `as="ul"`), `SettingsRow` (`title`, `description`, control as children, `stacked`, `footer`), `SettingsBlock`, `SettingsEmpty`. `packages/components` also has `SettingsField` (a `FormField` wrapper), used by forms, not by these info pages.
- **Informational pattern.** `ShortcutsPage.tsx`: `SettingsPage description=…` containing a `SettingsSection` per group with `SettingsCard divided` of `SettingsRow title` rows; the control side holds the keys. Its docblock: "It only informs: there is nothing to change, and a row does nothing when pressed". `AppearancePage.tsx` is the other pattern: one section and a row with a control.
- **A link row.** There is no shared "link row" component. The in-app examples put a `Button` in the row's control slot: `projects/ProjectFolders.tsx` `RemoteButton` (`variant="filling" color="secondary" size="sm" href target="_blank" rel="noreferrer"` with a `Github` or `ArrowUpRight` icon and a `Tooltip`), `providers/Account.tsx` (`variant="inline" color="primary"`, guarded by `url.startsWith('https://')`). Text links inside copy use `inlineLink` from `@clowdy/components/Text`. `Button` with `href` renders an anchor; `target="_blank"` makes Chromium call `window.open`, which main turns into `shell.openExternal` (one per second). In a plain browser the same anchor opens a tab.

## Tests that name the pages

- `features/settings/SettingsWindow.test.tsx`: `sidebarPages()` equals `['Appearance', 'Chat', 'Files', 'Shortcuts', 'Projects', 'Providers', 'Skills']`, has length `SETTINGS_PAGES.length`, and checks the group headings appear in the order General, Workspace, Agents (it looks for the words `General`, `Appearance`, `Workspace`, `Projects`, `Agents`, `Providers` in the sidebar text).
- `features/settings/SettingsDialog.test.tsx`: the same seven labels again after the dialog opens on `'shortcuts'`.
- Other tests use pages by id only (`UiStore.test.ts`, `NavHistory.test.ts`, `shellCommands.test.ts` use `'skills'`, `'providers'`, `'shortcuts'`), so a new id breaks nothing there. `ShortcutsPage.test.tsx` and `AppearancePage.test.tsx` mount the page alone with `createRoot` under `// @vitest-environment happy-dom`; Appearance mocks `../../theme`. `settings/ui/ui.test.tsx` covers the building blocks.
- Pages that need the store use `RootStoreProvider` with `new RootStore(new FixtureTransport(), { storage: undefined })`. A page that reads `window.desktop` must work with it undefined (tests do not set it unless they mock it; `FilesPage.test.tsx` and `systemClipboard.test.ts` show how they fake it).

## Docs that mention pages

- `apps/desktop/AGENTS.md`, "The renderer" and the **Settings window** bullet (about line 60) describe the dialog, `settingsPage`, the rail entry, `Cmd+,`, `?`; the `features/` line (about line 45) names Providers, Skills, Projects; the **Shortcuts** bullet describes that page. A new page needs a sentence in the same place. The **Releases** section is where the update behavior is documented (the About page would change what it says about the "Check for Updates…" menu only).
- `packages/components/AGENTS.md` lists components (SettingsLayout, SettingsField).
- `DESIGN.md` (lines about `SettingsLayout`) only says settings live in a modal chrome; no list of pages.
- The root `AGENTS.md` and `README.md` point to `spec.md`, which is not in the tree.

## Constraints

- UI text rules (root `AGENTS.md`): a phrase or one sentence ends without a period; periods only in two sentences or more. English in code and tests; the chat can match the user.
- Settings opens over a project screen; with no project selected (`NoProject`) Settings still opens from `Cmd+,` once `root.phase === 'ready'`.
- A new page id changes `SettingsPage` (and therefore the type of `openSettings(page)`), so main-process menu items that want to open About would need a new main to renderer channel; none exists.
- The sidebar groups are consecutive runs: About placed after Skills would need its own group, or sit under General only if it is moved next to the others.

## Relevant files

- `apps/desktop/src/renderer/features/settings/SettingsWindow.tsx`, `SettingsDialog.tsx`, `index.ts`, `commands.ts`
- `apps/desktop/src/renderer/stores/UiStore.ts` (`SETTINGS_PAGES`, `SettingsPage`, `openSettings`), `stores/index.ts` (re-export)
- `apps/desktop/src/renderer/features/settings/ShortcutsPage.tsx`, `AppearancePage.tsx`, `ui/*`
- `apps/desktop/src/renderer/features/settings/SettingsWindow.test.tsx`, `SettingsDialog.test.tsx`
- `apps/desktop/src/renderer/features/settings/projects/ProjectFolders.tsx` (`RemoteButton`), `providers/Account.tsx` (link button)
- `packages/components/src/SettingsLayout/SettingsLayout.tsx` (`SettingsNavItem`, `Intro`, `Content headerRight`)

## Open questions

- Page name and group: "About" in a new group, or at the end of General? Icon: `Info`?
- Whether the page title includes the app name ("About Clowdy").

## Assumptions and limits

- Not run: the Settings window in the app (no screenshot taken); the test suites were not run, as asked.
