# About page, Star on GitHub card and menu item: research map

Research date: 2026-11-23. Tree: branch `next` at `2b65281` (Electron 45.2.1, Bun 1.4.4). Research only: no source file was changed.

## Question and scope

The owner wants three things in the Clowdy desktop app (`apps/desktop`, daemon in `apps/daemon`):

1. A one-time, dismissible "Star on GitHub" card at the bottom of the chat list (left column of the Agents screen), shown after the person has used the app a while, never again once closed or clicked.
2. A "Star Clowdy on GitHub" item in the native application menu (Help).
3. A new Settings page (working name "About"): app version and update status or links (where to download, link to the repo), and Credits: the third-party open source the app ships, with licenses.

The repo link comes from the repo name baked into the build (`CLOWDY_RELEASE_REPO`, `src/main/releaseConfig.ts`), so it is absent in a development run. This research maps how the code works today so a plan can be written. It does not propose the design.

## Summary

- **Version and updates.** Everything lives in main: `app.getVersion()` (shell, `0.1.1`), the running bundle number (first-parent commit count), the baked repo, and the updater state, which is private to a closure and reported only through native sheets. The renderer receives one update signal (OTA "Update ready" toast) and shows no version anywhere. A development run and a local `package` build have an empty repo: no updater, no OTA, no update menu item. An About page needs new bridge fields and, for a "Check for updates" button, a new IPC action; those are shell changes.
- **Menu.** One pure function builds the menu (`createAppMenu`); it has no Help menu. A Star item is a small addition there and can call `shell.openExternal` from main directly (no throttle, no renderer). It would be macOS only in practice (the Windows menu bar is hidden behind the custom title bar) and is a shell change. The renderer cannot ask main to open a URL, but any `https:` anchor already opens the system browser, at most once a second.
- **Credits.** No mechanism exists beyond a hand-written root `THIRD-PARTY-LICENSES.md` with one entry (not packaged). Measured by bundling the current tree: 251 distinct npm packages ship (232 renderer, 20 main, 4 daemon), all permissive by their declared license (MIT 236, Apache-2.0 9, BlueOak-1.0.0 3, ISC 2, BSD-2-Clause 1); no copyleft npm package. Items that need their own text: Onest font (SIL OFL 1.1), Bun (MIT with LGPL-2 JavaScriptCore linked statically, no license shipped), Electron and Chromium (files already shipped), Apache packages, four packages with no license file. The renderer build can emit an exact list (a Vite plugin on `generateBundle`, tried: 4.7 s), main and daemon through `Bun.build({ metafile: true })`; a file in the renderer folder is served at `app://clowdy/...` and rides in the OTA manifest.
- **Settings pages.** A page is an entry in `SETTINGS_PAGES` (`UiStore.ts`) and in `PAGES` (`SettingsWindow.tsx`); two tests assert the exact list of seven labels. `ShortcutsPage` is the pattern for an info page; a link row is a `Button` with `href` and `target="_blank"`.
- **The card.** `AgentList` is a `Panel` with a heading and one scrolling `PanelContent`; nothing sits under the list, so the card is a new sibling after it. Flags are `localStorage` values via `readStored`/`writeStored` (copy `ChatListPreferences`). There is no first-launch record, no counters, and no dismissible banner pattern. Available signals: the personal project's `createdAt` (daemon data age) and the chats of the loaded projects.

## Topic pages

- [updates-and-version.md](updates-and-version.md): release config, shell updater, OTA, version reading, the bridge, what a Settings page can read, what is missing, dev-run behavior, shell versus OTA coupling.
- [native-menu-and-external-links.md](native-menu-and-external-links.md): the native menu, where a Help item goes, menu to renderer messages, platform differences, `lockNavigation` and the one-per-second throttle, how links open.
- [third-party-notices.md](third-party-notices.md): what ships, existing notices, license census, non-permissive items, how to generate a credits list and how the packaged renderer reads it, sizes.
- [settings-pages.md](settings-pages.md): declaring and routing a page, order, groups, icons, building blocks, link rows, the tests that assert the list, docs to update.
- [agent-list-and-card-trigger.md](agent-list-and-card-trigger.md): the list structure and where its bottom is, persistence of per-install flags, signals for "used a while", dismissible-pattern precedent.

Earlier work on the update system, for context: `.briefback/releases-updates/plan.md` and `research/` (repo `reforma-ai/clowdy`, public later; updates start the day it opens).

## Important files

Main and shared:

- `apps/desktop/src/main/releaseConfig.ts`, `updater.ts`, `ota.ts`, `index.ts` (`startUpdates`, both `setApplicationMenu` calls, `setAboutPanelOptions`, `web-contents-created` hook), `menu.ts` (+ `menu.test.ts`), `security.ts` (`lockNavigation`), `protocol.ts` (CSP, serving), `ipc.ts`, `bundleManifest.ts` (`hashFolder`)
- `apps/desktop/src/shared/bridge.ts`, `src/preload/index.ts`
- `apps/desktop/scripts/build.ts`, `bundle.ts` (`buildRenderer`, `layoutOtaBundle`), `main-bundle.ts`, `bun-runtime.ts`, `ripgrep.ts`, `publish-ota.ts` (`SHELL_PATHS`); `apps/daemon/scripts/bundle.ts`; `apps/desktop/vite.config.ts`, `electron-builder.ts`

Renderer:

- `features/settings/SettingsWindow.tsx`, `SettingsDialog.tsx`, `ShortcutsPage.tsx`, `AppearancePage.tsx`, `ui/*`, the two tests; `stores/UiStore.ts` (`SETTINGS_PAGES`)
- `features/agents/AgentList.tsx`, `Screen.tsx`, their CSS; `packages/components/src/Panel`; `stores/storage.ts`, `RootStore.ts`; `features/agents/chatListPreferences.ts`
- `root.ts` (the only update UI)

Notices:

- `THIRD-PARTY-LICENSES.md`, `packages/styles/src/assets/fonts/Onest/OFL.txt`, `packages/icons/src/assets/SOURCES.md`, `packages/icons/src/logo/SOURCES.md`

## Open questions research could not answer

- Legal weight of Bun's LGPL parts and of Chromium's notices (what must ship beside the binaries).
- Upstream licenses of the Shiki grammars and the Material icon artwork, and the terms of the brand-mark sources; only package-level declarations were read.
- Whether `Run.status === 'succeeded'` means "a turn was answered" (needed if the card counts finished turns).
- How the menu behaves on Windows (hidden bar claim is from the code's comment; never run) and whether `role: 'help'` suits Windows.
- Whether a bottom sibling after `PanelContent` lays out as expected in a running window (derived from the CSS, not tried).

## Assumptions and coverage limits

- Ran: file reading and grep; three throwaway analyses in the scratchpad (`/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/e8a05585-14ab-447c-ba60-898ce48bf278/scratchpad/`): a `package.json` dependency-closure walk (`closure.mjs`), `Bun.build` with `metafile: true` of the main and daemon bundles into scratchpad folders (`bunmeta.ts`), a `vite build` of the renderer through a wrapper config that only adds a module-collecting plugin, output and cache in the scratchpad (`vite.meta.config.mjs`), and scripts mapping modules to packages, licenses, and sizes (`pkgs.mjs`, `sizes.mjs`). One read-only `curl` of Bun's public `LICENSE.md` from GitHub. No source file, config, or lockfile in the repo was changed; the only files written there are these notes.
- Not run: the app, the packaged app, the updater, OTA (nothing is published; the repo is private), the menu, any test suite, Windows. The older builds in `apps/desktop/release/` and `apps/desktop/app/` (17 Nov) were looked at only to see which license files Electron ships.
- License ids are what each package's `package.json` declares; texts were not scanned.
- `spec.md` is referenced by the root `AGENTS.md` and `README.md` but is not in the tree.

## Decisions the owner still has to make

1. **What the card's trigger measures and the threshold**: days since a new first-seen timestamp, days since the personal project's `createdAt` (true age, shows at once on old installs), a chat count or "a chat that answered", a launch count, or a combination. Per-project chat counts only see projects loaded in the session.
2. **What "clicked" covers**: the card's own button, the Close button, the Help menu item, the About page link. Counting the menu item needs a new main to renderer message.
3. **Menu**: whether a Help menu is added at all, the item text per platform, one item or two, and what Windows gets (its menu bar is hidden, so the item would not be seen).
4. **About page scope**: version only, or shell plus bundle number ("0.1.1 (bundle N)"); update status and a "Check for updates" button (new IPC action and status events) or just download and repo links; page name, group, icon, and position.
5. **How the renderer learns the repo and the versions**: a preload field (argument or `sendSync`) versus IPC; what the page and card do in a development run (hide, or say it is unavailable); what happens while the repo is private.
6. **Release sequencing**: any menu item, bridge field, or IPC action is a shell change, so the OTA bundle with the renderer part waits for a shell version bump. Decide whether the work is split (renderer parts first, tolerant of a missing bridge field) or shipped together with a shell release.
7. **Where credits data lives**: generated at build (Vite plugin for the renderer, `Bun.build` metafile or a script for main and daemon) into the renderer folder, versus a committed file; and a committed source for the entries that are not npm packages (Electron, Bun, ripgrep, Onest, Material Icon Theme, brand marks, Reforma-derived work).
8. **What the list covers**: the exact bundled set (251 packages) rather than the dependency closure (adds `chroma-js` and `argparse`, which do not ship); whether to show full license texts, deduplicated (about 85 KB) or only names, versions, license ids, and links.
9. **Bun and Chromium**: whether to ship Bun's `LICENSE.md` beside the binary (today only ripgrep's licenses are), how the About page points to Chromium's `LICENSES.chromium.html` (name only, or a main-process action that opens it), and the fallback text for the four packages with no license file.
10. **Clowdy's own license and Reforma-derived code**: the repo has no `LICENSE`, `@clowdy/file-manager` is `UNLICENSED`, Reforma has no root license, and the Loader animation is Reforma's mark. These are decisions to make before the repo goes public and the credits page states them.
11. **Brand marks**: wording of the trademark notice for the Claude, OpenAI, Cursor, and GitHub marks that ship.
